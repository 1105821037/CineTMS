import mysql from "mysql2/promise";
import type {
  ActivityListFilter,
  ActivityRecord,
  CreateActivityInput,
} from "./notification-types";
import { ensureSetupSchema, readLocalDatabaseConfig } from "./setup-store";

type SqlExecutor = Pick<mysql.Connection, "execute"> | Pick<mysql.Pool, "execute">;

let activityPoolPromise: Promise<mysql.Pool | null> | null = null;
let activitySchemaReadyPromise: Promise<void> | null = null;

export async function ensureActivitySchema(connection: SqlExecutor): Promise<void> {
  await ensureSetupSchema(connection);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_activity_log (
      id VARCHAR(128) NOT NULL PRIMARY KEY,
      actor_type VARCHAR(32) NOT NULL,
      actor_id VARCHAR(128) NULL,
      actor_name VARCHAR(128) NULL,
      action VARCHAR(64) NOT NULL,
      object_type VARCHAR(64) NOT NULL,
      object_id VARCHAR(128) NULL,
      object_name VARCHAR(255) NULL,
      hall_id VARCHAR(128) NULL,
      activity_status VARCHAR(16) NOT NULL,
      result_message TEXT NULL,
      occurred_at DATETIME NOT NULL,
      duration_ms INT NULL,
      request_id VARCHAR(128) NULL,
      payload_json JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_tms_activity_time (occurred_at),
      KEY idx_tms_activity_actor_time (actor_id, occurred_at),
      KEY idx_tms_activity_hall_time (hall_id, occurred_at),
      KEY idx_tms_activity_status_time (activity_status, occurred_at),
      KEY idx_tms_activity_object_time (object_type, object_id, occurred_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function createActivity(input: CreateActivityInput): Promise<ActivityRecord | null> {
  const pool = await getActivityPool();
  if (!pool) {
    return null;
  }

  await ensureActivitySchemaReady(pool);
  const id = input.id ?? `activity-${Date.now()}`;
  await pool.execute(
    `
      INSERT INTO tms_activity_log
        (
          id,
          actor_type,
          actor_id,
          actor_name,
          action,
          object_type,
          object_id,
          object_name,
          hall_id,
          activity_status,
          result_message,
          occurred_at,
          duration_ms,
          request_id,
          payload_json
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE
        actor_type = VALUES(actor_type),
        actor_id = VALUES(actor_id),
        actor_name = VALUES(actor_name),
        action = VALUES(action),
        object_type = VALUES(object_type),
        object_id = VALUES(object_id),
        object_name = VALUES(object_name),
        hall_id = VALUES(hall_id),
        activity_status = VALUES(activity_status),
        result_message = VALUES(result_message),
        occurred_at = VALUES(occurred_at),
        duration_ms = VALUES(duration_ms),
        request_id = VALUES(request_id),
        payload_json = VALUES(payload_json)
    `,
    [
      id,
      input.actorType,
      input.actorId ?? null,
      input.actorName ?? null,
      input.action,
      input.objectType,
      input.objectId ?? null,
      input.objectName ?? null,
      input.hallId ?? null,
      input.status,
      input.resultMessage ?? null,
      toMysqlDateTime(input.occurredAt ?? new Date().toISOString()),
      Number.isFinite(input.durationMs) ? Number(input.durationMs) : null,
      input.requestId ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );

  return readActivityById(id);
}

export async function readActivityById(id: string): Promise<ActivityRecord | null> {
  const pool = await getActivityPool();
  if (!pool) {
    return null;
  }

  await ensureActivitySchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT *
      FROM tms_activity_log
      WHERE id = ?
      LIMIT 1
    `,
    [id],
  );
  return rows[0] ? mapActivityRow(rows[0]) : null;
}

export async function listActivities(filter: ActivityListFilter = {}): Promise<ActivityRecord[]> {
  const pool = await getActivityPool();
  if (!pool) {
    return [];
  }

  await ensureActivitySchemaReady(pool);
  const conditions: string[] = [];
  const params: Array<string | number | null> = [];

  if (filter.actorId) {
    conditions.push("actor_id = ?");
    params.push(filter.actorId);
  }

  if (filter.actorType) {
    conditions.push("actor_type = ?");
    params.push(filter.actorType);
  }

  if (filter.action) {
    conditions.push("action = ?");
    params.push(filter.action);
  }

  if (filter.objectType) {
    conditions.push("object_type = ?");
    params.push(filter.objectType);
  }

  if (filter.hallId) {
    conditions.push("hall_id = ?");
    params.push(filter.hallId);
  }

  if (filter.status) {
    conditions.push("activity_status = ?");
    params.push(filter.status);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = normalizeLimit(filter.limit, 50, 500);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT *
      FROM tms_activity_log
      ${whereClause}
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT ${limit}
    `,
    params,
  );

  return rows.map(mapActivityRow);
}

async function getActivityPool(): Promise<mysql.Pool | null> {
  activityPoolPromise ??= (async () => {
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

  return activityPoolPromise;
}

async function ensureActivitySchemaReady(pool: mysql.Pool): Promise<void> {
  activitySchemaReadyPromise ??= ensureActivitySchema(pool);
  return activitySchemaReadyPromise;
}

function mapActivityRow(row: mysql.RowDataPacket): ActivityRecord {
  return {
    id: String(row.id),
    actorType: String(row.actor_type) as ActivityRecord["actorType"],
    actorId: optionalString(row.actor_id),
    actorName: optionalString(row.actor_name),
    action: String(row.action),
    objectType: String(row.object_type),
    objectId: optionalString(row.object_id),
    objectName: optionalString(row.object_name),
    hallId: optionalString(row.hall_id),
    status: String(row.activity_status) as ActivityRecord["status"],
    resultMessage: optionalString(row.result_message),
    occurredAt: new Date(row.occurred_at).toISOString(),
    durationMs: Number.isFinite(row.duration_ms) ? Number(row.duration_ms) : undefined,
    requestId: optionalString(row.request_id),
    payload: normalizeJsonRecord(row.payload_json),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
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
