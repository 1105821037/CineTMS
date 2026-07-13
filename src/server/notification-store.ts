import mysql from "mysql2/promise";
import type {
  CreateNotificationInput,
  NotificationListFilter,
  NotificationRecord,
  NotificationStatus,
  NotificationSummary,
} from "./notification-types";
import { ensureSetupSchema, readLocalDatabaseConfig } from "./setup-store";

type SqlExecutor = Pick<mysql.Connection, "execute"> | Pick<mysql.Pool, "execute">;

let notificationPoolPromise: Promise<mysql.Pool | null> | null = null;
let notificationSchemaReadyPromise: Promise<void> | null = null;

export async function ensureNotificationSchema(connection: SqlExecutor): Promise<void> {
  await ensureSetupSchema(connection);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_notification (
      id VARCHAR(128) NOT NULL PRIMARY KEY,
      notification_type VARCHAR(64) NOT NULL,
      severity VARCHAR(16) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      source VARCHAR(32) NOT NULL,
      object_type VARCHAR(64) NULL,
      object_id VARCHAR(128) NULL,
      hall_id VARCHAR(128) NULL,
      notification_status VARCHAR(16) NOT NULL,
      dedupe_key VARCHAR(255) NULL,
      occurred_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME NULL,
      resolved_at DATETIME NULL,
      payload_json JSON NOT NULL,
      KEY idx_tms_notification_status_time (notification_status, occurred_at),
      KEY idx_tms_notification_hall_time (hall_id, occurred_at),
      KEY idx_tms_notification_dedupe_status (dedupe_key, notification_status),
      KEY idx_tms_notification_severity_time (severity, occurred_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function createNotification(input: CreateNotificationInput): Promise<NotificationRecord | null> {
  const pool = await getNotificationPool();
  if (!pool) {
    return null;
  }

  await ensureNotificationSchemaReady(pool);
  const id = input.id ?? `notification-${Date.now()}`;
  const status = input.status ?? "unread";
  await pool.execute(
    `
      INSERT INTO tms_notification
        (
          id,
          notification_type,
          severity,
          title,
          message,
          source,
          object_type,
          object_id,
          hall_id,
          notification_status,
          dedupe_key,
          occurred_at,
          read_at,
          resolved_at,
          payload_json
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE
        notification_type = VALUES(notification_type),
        severity = VALUES(severity),
        title = VALUES(title),
        message = VALUES(message),
        source = VALUES(source),
        object_type = VALUES(object_type),
        object_id = VALUES(object_id),
        hall_id = VALUES(hall_id),
        notification_status = VALUES(notification_status),
        dedupe_key = VALUES(dedupe_key),
        occurred_at = VALUES(occurred_at),
        payload_json = VALUES(payload_json)
    `,
    [
      id,
      input.type,
      input.severity,
      input.title,
      input.message,
      input.source,
      input.objectType ?? null,
      input.objectId ?? null,
      input.hallId ?? null,
      status,
      input.dedupeKey ?? null,
      toMysqlDateTime(input.occurredAt ?? new Date().toISOString()),
      status === "read" ? toMysqlDateTime(new Date().toISOString()) : null,
      status === "resolved" ? toMysqlDateTime(new Date().toISOString()) : null,
      JSON.stringify(input.payload ?? {}),
    ],
  );

  return readNotificationById(id);
}

export async function readNotificationById(id: string): Promise<NotificationRecord | null> {
  const pool = await getNotificationPool();
  if (!pool) {
    return null;
  }

  await ensureNotificationSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT *
      FROM tms_notification
      WHERE id = ?
      LIMIT 1
    `,
    [id],
  );
  return rows[0] ? mapNotificationRow(rows[0]) : null;
}

export async function findActiveNotificationByDedupeKey(dedupeKey: string): Promise<NotificationRecord | null> {
  const pool = await getNotificationPool();
  if (!pool) {
    return null;
  }

  await ensureNotificationSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT *
      FROM tms_notification
      WHERE dedupe_key = ? AND notification_status IN ('unread', 'read')
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT 1
    `,
    [dedupeKey],
  );
  return rows[0] ? mapNotificationRow(rows[0]) : null;
}

export async function listNotifications(filter: NotificationListFilter = {}): Promise<NotificationRecord[]> {
  const pool = await getNotificationPool();
  if (!pool) {
    return [];
  }

  await ensureNotificationSchemaReady(pool);
  const conditions: string[] = [];
  const params: Array<string | number | null> = [];

  if (filter.unreadOnly) {
    conditions.push("notification_status = 'unread'");
  } else if (filter.activeOnly) {
    conditions.push("notification_status IN ('unread', 'read')");
  } else if (filter.statuses?.length) {
    conditions.push(`notification_status IN (${filter.statuses.map(() => "?").join(", ")})`);
    params.push(...filter.statuses);
  }

  if (filter.severities?.length) {
    conditions.push(`severity IN (${filter.severities.map(() => "?").join(", ")})`);
    params.push(...filter.severities);
  }

  if (filter.sources?.length) {
    conditions.push(`source IN (${filter.sources.map(() => "?").join(", ")})`);
    params.push(...filter.sources);
  }

  if (filter.hallId) {
    conditions.push("hall_id = ?");
    params.push(filter.hallId);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = normalizeLimit(filter.limit, 50, 500);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT *
      FROM tms_notification
      ${whereClause}
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT ${limit}
    `,
    params,
  );

  return rows.map(mapNotificationRow);
}

export async function readNotificationSummary(): Promise<NotificationSummary> {
  const pool = await getNotificationPool();
  if (!pool) {
    return {
      total: 0,
      unread: 0,
      active: 0,
      warning: 0,
      error: 0,
      critical: 0,
    };
  }

  await ensureNotificationSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(`
    SELECT
      COUNT(*) AS total,
      SUM(notification_status = 'unread') AS unread,
      SUM(notification_status IN ('unread', 'read')) AS active,
      SUM(severity = 'warning' AND notification_status IN ('unread', 'read')) AS warning,
      SUM(severity = 'error' AND notification_status IN ('unread', 'read')) AS error,
      SUM(severity = 'critical' AND notification_status IN ('unread', 'read')) AS critical
    FROM tms_notification
  `);
  const row = rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    unread: Number(row.unread ?? 0),
    active: Number(row.active ?? 0),
    warning: Number(row.warning ?? 0),
    error: Number(row.error ?? 0),
    critical: Number(row.critical ?? 0),
  };
}

export async function updateNotificationStatus(
  id: string,
  status: NotificationStatus,
): Promise<NotificationRecord | null> {
  const pool = await getNotificationPool();
  if (!pool) {
    return null;
  }

  await ensureNotificationSchemaReady(pool);
  const now = toMysqlDateTime(new Date().toISOString());
  await pool.execute(
    `
      UPDATE tms_notification
      SET
        notification_status = ?,
        read_at = CASE
          WHEN ? = 'read' AND read_at IS NULL THEN ?
          WHEN ? IN ('resolved', 'dismissed') AND read_at IS NULL THEN ?
          ELSE read_at
        END,
        resolved_at = CASE
          WHEN ? = 'resolved' THEN ?
          ELSE resolved_at
        END
      WHERE id = ?
    `,
    [status, status, now, status, now, status, now, id],
  );

  return readNotificationById(id);
}

export async function markAllNotificationsRead(): Promise<number> {
  const pool = await getNotificationPool();
  if (!pool) {
    return 0;
  }

  await ensureNotificationSchemaReady(pool);
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `
      UPDATE tms_notification
      SET notification_status = 'read',
          read_at = COALESCE(read_at, ?)
      WHERE notification_status = 'unread'
    `,
    [toMysqlDateTime(new Date().toISOString())],
  );
  return result.affectedRows;
}

export async function resolveNotificationsByDedupeKey(dedupeKey: string): Promise<number> {
  const pool = await getNotificationPool();
  if (!pool) {
    return 0;
  }

  await ensureNotificationSchemaReady(pool);
  const now = toMysqlDateTime(new Date().toISOString());
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `
      UPDATE tms_notification
      SET notification_status = 'resolved',
          read_at = COALESCE(read_at, ?),
          resolved_at = COALESCE(resolved_at, ?)
      WHERE dedupe_key = ? AND notification_status IN ('unread', 'read')
    `,
    [now, now, dedupeKey],
  );
  return result.affectedRows;
}

async function getNotificationPool(): Promise<mysql.Pool | null> {
  notificationPoolPromise ??= (async () => {
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

  return notificationPoolPromise;
}

async function ensureNotificationSchemaReady(pool: mysql.Pool): Promise<void> {
  notificationSchemaReadyPromise ??= ensureNotificationSchema(pool);
  return notificationSchemaReadyPromise;
}

function mapNotificationRow(row: mysql.RowDataPacket): NotificationRecord {
  return {
    id: String(row.id),
    type: String(row.notification_type),
    severity: String(row.severity) as NotificationRecord["severity"],
    title: String(row.title),
    message: String(row.message),
    source: String(row.source) as NotificationRecord["source"],
    objectType: optionalString(row.object_type),
    objectId: optionalString(row.object_id),
    hallId: optionalString(row.hall_id),
    status: String(row.notification_status) as NotificationRecord["status"],
    dedupeKey: optionalString(row.dedupe_key),
    occurredAt: new Date(row.occurred_at).toISOString(),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : undefined,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined,
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
