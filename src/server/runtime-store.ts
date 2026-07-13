import mysql from "mysql2/promise";
import type { HallDeviceEvent, HallRuntimeSnapshot } from "../runtime";
import type { HallRuntimeRecord } from "../runtime";
import { ensureSetupSchema, readLocalDatabaseConfig } from "./setup-store";

type SqlExecutor = Pick<mysql.Connection, "execute"> | Pick<mysql.Pool, "execute">;

let runtimePoolPromise: Promise<mysql.Pool | null> | null = null;
let runtimeSchemaReadyPromise: Promise<void> | null = null;

export async function ensureRuntimeSchema(connection: SqlExecutor): Promise<void> {
  await ensureSetupSchema(connection);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_hall_runtime_snapshot (
      hall_id VARCHAR(128) NOT NULL PRIMARY KEY,
      device_id VARCHAR(128) NULL,
      gdc_host VARCHAR(255) NULL,
      gdc_port INT NULL,
      snapshot_json JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_hall_runtime_event (
      event_id VARCHAR(128) NOT NULL PRIMARY KEY,
      hall_id VARCHAR(128) NOT NULL,
      device_id VARCHAR(128) NULL,
      event_type VARCHAR(64) NOT NULL,
      event_source VARCHAR(32) NOT NULL,
      occurred_at DATETIME NOT NULL,
      payload_json JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_tms_runtime_event_hall_time (hall_id, occurred_at),
      KEY idx_tms_runtime_event_type_time (event_type, occurred_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function persistRuntimeSnapshot(record: HallRuntimeRecord): Promise<void> {
  const pool = await getRuntimePool();
  if (!pool) {
    return;
  }

  await ensureRuntimeSchemaReady(pool);
  await pool.execute(
    `
      INSERT INTO tms_hall_runtime_snapshot
        (hall_id, device_id, gdc_host, gdc_port, snapshot_json)
      VALUES (?, ?, ?, ?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE
        device_id = VALUES(device_id),
        gdc_host = VALUES(gdc_host),
        gdc_port = VALUES(gdc_port),
        snapshot_json = VALUES(snapshot_json)
    `,
    [
      record.registration.hallId,
      record.registration.deviceId,
      record.registration.host,
      record.registration.port,
      JSON.stringify(record.snapshot),
    ],
  );
}

export async function persistRuntimeEvent(event: HallDeviceEvent): Promise<void> {
  const pool = await getRuntimePool();
  if (!pool) {
    return;
  }

  await ensureRuntimeSchemaReady(pool);
  await pool.execute(
    `
      INSERT INTO tms_hall_runtime_event
        (event_id, hall_id, device_id, event_type, event_source, occurred_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE
        device_id = VALUES(device_id),
        event_type = VALUES(event_type),
        event_source = VALUES(event_source),
        occurred_at = VALUES(occurred_at),
        payload_json = VALUES(payload_json)
    `,
    [
      event.eventId,
      event.hallId,
      event.deviceId ?? null,
      event.type,
      event.source,
      toMysqlDateTime(event.occurredAt),
      JSON.stringify(event.payload),
    ],
  );
}

export async function readPersistedRuntimeSnapshots(): Promise<HallRuntimeSnapshot[]> {
  const pool = await getRuntimePool();
  if (!pool) {
    return [];
  }

  await ensureRuntimeSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT snapshot_json
      FROM tms_hall_runtime_snapshot
      ORDER BY updated_at DESC
    `,
  );

  return rows.flatMap((row) => {
    const raw = typeof row.snapshot_json === "string" ? JSON.parse(row.snapshot_json) : row.snapshot_json;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? [raw as HallRuntimeSnapshot] : [];
  });
}

export async function readPersistedRuntimeEvents(limit = 200): Promise<HallDeviceEvent[]> {
  const pool = await getRuntimePool();
  if (!pool) {
    return [];
  }

  await ensureRuntimeSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT event_id, hall_id, device_id, event_type, event_source, occurred_at, payload_json
      FROM tms_hall_runtime_event
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT ?
    `,
    [limit],
  );

  return rows.map((row) => ({
    eventId: String(row.event_id),
    hallId: String(row.hall_id),
    deviceId: row.device_id ? String(row.device_id) : undefined,
    type: String(row.event_type) as HallDeviceEvent["type"],
    source: String(row.event_source) as HallDeviceEvent["source"],
    occurredAt: new Date(row.occurred_at).toISOString(),
    payload: normalizeJsonRecord(row.payload_json),
  })).map((event) => ({
    ...event,
    hallName: typeof event.payload.hallName === "string" ? event.payload.hallName : undefined,
  })).reverse();
}

async function getRuntimePool(): Promise<mysql.Pool | null> {
  runtimePoolPromise ??= (async () => {
    const database = await readLocalDatabaseConfig();
    if (!database) {
      return null;
    }

    return mysql.createPool({
      host: database.host,
      port: database.port,
      user: database.user,
      password: database.password,
      database: database.database,
      connectTimeout: 5_000,
      waitForConnections: true,
      connectionLimit: 4,
      maxIdle: 4,
      idleTimeout: 60_000,
      queueLimit: 0,
    });
  })();

  return runtimePoolPromise;
}

async function ensureRuntimeSchemaReady(pool: mysql.Pool): Promise<void> {
  runtimeSchemaReadyPromise ??= ensureRuntimeSchema(pool);
  return runtimeSchemaReadyPromise;
}

function toMysqlDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 19).replace("T", " ");
  }

  return formatLocalMysqlDateTime(date);
}

function formatLocalMysqlDateTime(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-") + " " + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
}

function normalizeJsonRecord(value: unknown): Record<string, unknown> {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}
