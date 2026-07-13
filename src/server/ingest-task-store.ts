import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { GdcIngestErrorItem, GdcIngestStatus } from "../modules/gdc";
import { ensureSetupSchema, readLocalDatabaseConfig } from "./setup-store";

type SqlExecutor = Pick<mysql.Connection, "execute"> | Pick<mysql.Pool, "execute">;

export type IngestTaskType = "KDM" | "DCP" | "FILE";
export type IngestTaskStatus =
  | "accepted"
  | "queued"
  | "running"
  | "paused"
  | "unreachable"
  | "complete"
  | "failed"
  | "cancelled"
  | "removed"
  | "unknown";

export interface IngestTaskRecord {
  readonly id: string;
  readonly type: IngestTaskType;
  readonly hallId: string;
  readonly hallName?: string;
  readonly assetId: string;
  readonly assetTitle?: string;
  readonly ingestUuid: string;
  readonly source?: string;
  readonly path?: string;
  readonly status: IngestTaskStatus;
  readonly remoteStatus?: string;
  readonly transferredSize?: number;
  readonly totalSize?: number;
  readonly description?: string;
  readonly errorList: readonly GdcIngestErrorItem[];
  readonly warningList: readonly GdcIngestErrorItem[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface CreateIngestTaskInput {
  readonly type: IngestTaskType;
  readonly hallId: string;
  readonly hallName?: string;
  readonly assetId: string;
  readonly assetTitle?: string;
  readonly ingestUuid: string;
  readonly source?: string;
  readonly path?: string;
  readonly metadata?: Record<string, unknown>;
}

let ingestTaskPoolPromise: Promise<mysql.Pool | null> | null = null;
let ingestTaskSchemaReadyPromise: Promise<void> | null = null;

export async function ensureIngestTaskSchema(connection: SqlExecutor): Promise<void> {
  await ensureSetupSchema(connection);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_ingest_task (
      task_id VARCHAR(128) NOT NULL PRIMARY KEY,
      task_type VARCHAR(32) NOT NULL,
      hall_id VARCHAR(128) NOT NULL,
      hall_name VARCHAR(255) NULL,
      asset_id VARCHAR(255) NOT NULL,
      asset_title VARCHAR(512) NULL,
      ingest_uuid VARCHAR(128) NOT NULL,
      source_uri TEXT NULL,
      source_path TEXT NULL,
      task_status VARCHAR(32) NOT NULL,
      remote_status VARCHAR(64) NULL,
      transferred_size BIGINT NULL,
      total_size BIGINT NULL,
      description_text TEXT NULL,
      error_json JSON NULL,
      warning_json JSON NULL,
      metadata_json JSON NULL,
      completed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tms_ingest_task_ingest_uuid (ingest_uuid),
      KEY idx_tms_ingest_task_hall_status (hall_id, task_status, updated_at),
      KEY idx_tms_ingest_task_asset (task_type, hall_id, asset_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function createIngestTask(input: CreateIngestTaskInput): Promise<IngestTaskRecord | null> {
  const pool = await getIngestTaskPool();
  if (!pool) {
    return null;
  }

  await ensureIngestTaskSchemaReady(pool);
  const id = `ingest-task-${randomUUID()}`;
  await pool.execute(
    `
      INSERT INTO tms_ingest_task
        (task_id, task_type, hall_id, hall_name, asset_id, asset_title, ingest_uuid, source_uri, source_path, task_status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', CAST(? AS JSON))
    `,
    [
      id,
      input.type,
      input.hallId,
      input.hallName ?? null,
      input.assetId,
      input.assetTitle ?? null,
      input.ingestUuid,
      input.source ?? null,
      input.path ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  return readIngestTaskById(id);
}

export async function listIngestTasks(options: {
  readonly type?: IngestTaskType;
  readonly hallId?: string;
  readonly assetId?: string;
  readonly limit?: number;
} = {}): Promise<IngestTaskRecord[]> {
  const pool = await getIngestTaskPool();
  if (!pool) {
    return [];
  }

  await ensureIngestTaskSchemaReady(pool);
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (options.type) {
    conditions.push("task_type = ?");
    params.push(options.type);
  }
  if (options.hallId) {
    conditions.push("hall_id = ?");
    params.push(options.hallId);
  }
  if (options.assetId) {
    conditions.push("asset_id = ?");
    params.push(options.assetId);
  }

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT *
      FROM tms_ingest_task
      ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `,
    params,
  );

  return rows.map(mapTaskRow);
}

export async function readActiveIngestTask(
  type: IngestTaskType,
  hallId: string,
  assetId: string,
): Promise<IngestTaskRecord | null> {
  const tasks = await listIngestTasks({ type, hallId, assetId, limit: 20 });
  return tasks.find((task) => !isTerminalIngestTaskStatus(task.status)) ?? null;
}

export async function readIngestTaskById(id: string): Promise<IngestTaskRecord | null> {
  const pool = await getIngestTaskPool();
  if (!pool) {
    return null;
  }

  await ensureIngestTaskSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM tms_ingest_task WHERE task_id = ? LIMIT 1",
    [id],
  );
  return rows[0] ? mapTaskRow(rows[0]) : null;
}

export async function readIngestTaskByIngestUuid(ingestUuid: string): Promise<IngestTaskRecord | null> {
  const pool = await getIngestTaskPool();
  if (!pool) {
    return null;
  }

  await ensureIngestTaskSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM tms_ingest_task WHERE ingest_uuid = ? LIMIT 1",
    [ingestUuid],
  );
  return rows[0] ? mapTaskRow(rows[0]) : null;
}

export async function updateIngestTaskFromStatus(
  task: IngestTaskRecord,
  status: GdcIngestStatus,
  options: { verifiedComplete?: boolean; requireVerifiedComplete?: boolean } = {},
): Promise<IngestTaskRecord | null> {
  const pool = await getIngestTaskPool();
  if (!pool) {
    return null;
  }

  await ensureIngestTaskSchemaReady(pool);
  const nextStatus = mapRemoteStatus(status, options.verifiedComplete, options.requireVerifiedComplete);
  const completedAt = isTerminalIngestTaskStatus(nextStatus)
    ? task.completedAt ?? new Date().toISOString()
    : undefined;

  await pool.execute(
    `
      UPDATE tms_ingest_task
      SET
        task_status = ?,
        remote_status = ?,
        transferred_size = ?,
        total_size = ?,
        description_text = ?,
        error_json = CAST(? AS JSON),
        warning_json = CAST(? AS JSON),
        completed_at = ?
      WHERE task_id = ?
    `,
    [
      nextStatus,
      status.status ?? null,
      status.transferredSize ?? null,
      status.totalSize ?? null,
      status.description ?? null,
      JSON.stringify(status.errorList ?? []),
      JSON.stringify(status.warningList ?? []),
      completedAt ? toMysqlDateTime(completedAt) : null,
      task.id,
    ],
  );

  return readIngestTaskById(task.id);
}

export async function updateIngestTaskStatus(
  task: IngestTaskRecord,
  status: IngestTaskStatus,
  options: {
    readonly remoteStatus?: string;
    readonly description?: string;
    readonly transferredSize?: number;
    readonly totalSize?: number;
  } = {},
): Promise<IngestTaskRecord | null> {
  const pool = await getIngestTaskPool();
  if (!pool) {
    return null;
  }

  await ensureIngestTaskSchemaReady(pool);
  const completedAt = isTerminalIngestTaskStatus(status)
    ? task.completedAt ?? new Date().toISOString()
    : undefined;

  await pool.execute(
    `
      UPDATE tms_ingest_task
      SET
        task_status = ?,
        remote_status = ?,
        transferred_size = ?,
        total_size = ?,
        description_text = ?,
        completed_at = ?
      WHERE task_id = ?
    `,
    [
      status,
      options.remoteStatus ?? task.remoteStatus ?? null,
      options.transferredSize ?? task.transferredSize ?? null,
      options.totalSize ?? task.totalSize ?? null,
      options.description ?? task.description ?? null,
      completedAt ? toMysqlDateTime(completedAt) : null,
      task.id,
    ],
  );

  return readIngestTaskById(task.id);
}

export function isTerminalIngestTaskStatus(status: IngestTaskStatus): boolean {
  return status === "complete" || status === "failed" || status === "cancelled" || status === "removed";
}

export function isMissingRemoteIngestStatus(status: GdcIngestStatus): boolean {
  return normalizeRemoteStatus(status.status) === "unknown"
    && !String(status.assetUuid || "").trim()
    && !String(status.assetUri || "").trim()
    && !String(status.description || "").trim();
}

function mapRemoteStatus(
  status: GdcIngestStatus,
  verifiedComplete = false,
  requireVerifiedComplete = false,
): IngestTaskStatus {
  const normalized = normalizeRemoteStatus(status.status);
  if (verifiedComplete || (!requireVerifiedComplete && (normalized === "complete" || normalized === "completed"))) {
    return "complete";
  }
  if (requireVerifiedComplete && (normalized === "complete" || normalized === "completed")) {
    return "unknown";
  }
  if (["cancelled", "canceled"].includes(normalized)) {
    return "cancelled";
  }
  if (normalized === "removed") {
    return "removed";
  }
  if (["exception", "error", "failed", "failure"].includes(normalized)) {
    return "failed";
  }
  if (isPausedIngestStatus(status)) {
    return "paused";
  }
  if (["running", "in_progress", "in progress"].includes(normalized)) {
    return "running";
  }
  if (["scheduled", "pending", "queued", "new"].includes(normalized)) {
    return "queued";
  }
  return "unknown";
}

function isPausedIngestStatus(status: GdcIngestStatus): boolean {
  const normalized = normalizeRemoteStatus(status.status);
  const description = String(status.description || "").trim().toLowerCase();
  return normalized === "paused"
    || normalized === "pause"
    || description.includes("paused")
    || description.includes("pause");
}

function normalizeRemoteStatus(status: string | undefined): string {
  return String(status || "").trim().toLowerCase();
}

async function getIngestTaskPool(): Promise<mysql.Pool | null> {
  ingestTaskPoolPromise ??= (async () => {
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

  return ingestTaskPoolPromise;
}

async function ensureIngestTaskSchemaReady(pool: mysql.Pool): Promise<void> {
  ingestTaskSchemaReadyPromise ??= ensureIngestTaskSchema(pool);
  return ingestTaskSchemaReadyPromise;
}

function mapTaskRow(row: mysql.RowDataPacket): IngestTaskRecord {
  return {
    id: String(row.task_id),
    type: String(row.task_type) as IngestTaskType,
    hallId: String(row.hall_id),
    hallName: row.hall_name ? String(row.hall_name) : undefined,
    assetId: String(row.asset_id),
    assetTitle: row.asset_title ? String(row.asset_title) : undefined,
    ingestUuid: String(row.ingest_uuid),
    source: row.source_uri ? String(row.source_uri) : undefined,
    path: row.source_path ? String(row.source_path) : undefined,
    status: String(row.task_status) as IngestTaskStatus,
    remoteStatus: row.remote_status ? String(row.remote_status) : undefined,
    transferredSize: row.transferred_size === null || row.transferred_size === undefined
      ? undefined
      : Number(row.transferred_size),
    totalSize: row.total_size === null || row.total_size === undefined
      ? undefined
      : Number(row.total_size),
    description: row.description_text ? String(row.description_text) : undefined,
    errorList: normalizeJsonArray(row.error_json) as GdcIngestErrorItem[],
    warningList: normalizeJsonArray(row.warning_json) as GdcIngestErrorItem[],
    metadata: normalizeJsonRecord(row.metadata_json),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
  };
}

function normalizeJsonArray(value: unknown): unknown[] {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(raw) ? raw : [];
}

function normalizeJsonRecord(value: unknown): Record<string, unknown> {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function toMysqlDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 19).replace("T", " ");
  }

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
