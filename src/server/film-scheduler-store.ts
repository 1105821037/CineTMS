import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { ApiError } from "./http";
import { createDatabaseConnection, ensureSetupSchema } from "./setup-store";

export type FilmScheduleRuntimeStatus =
  | "pending"
  | "preparing"
  | "ready"
  | "playing"
  | "manual_hold"
  | "monitor_lost"
  | "transitioning"
  | "completed"
  | "aborted"
  | "failed"
  | "skipped";

export type FilmScheduleActionStatus =
  | "running"
  | "success"
  | "failed";

export interface FilmScheduleRuntimeRecord {
  readonly scheduleId: string;
  readonly hallId: string;
  readonly showDate: string;
  readonly status: FilmScheduleRuntimeStatus;
  readonly activeShowUuid?: string;
  readonly lastPlaybackState?: string;
  readonly lastPositionSeconds?: number;
  readonly lastPositionAt?: string;
  readonly loadedAt?: string;
  readonly playedAt?: string;
  readonly completedAt?: string;
  readonly interruptedAt?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export interface FilmScheduleActionExecution {
  readonly id: string;
  readonly scheduleId: string;
  readonly hallId: string;
  readonly actionKey: string;
  readonly actionType: string;
  readonly triggerKind: string;
  readonly plannedAt?: string;
  readonly triggeredAt?: string;
  readonly status: FilmScheduleActionStatus;
  readonly retryCount: number;
  readonly payload: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeObservationInput {
  readonly scheduleId: string;
  readonly hallId: string;
  readonly showDate: string;
  readonly status: FilmScheduleRuntimeStatus;
  readonly activeShowUuid?: string;
  readonly lastPlaybackState?: string;
  readonly lastPositionSeconds?: number;
  readonly lastPositionAt?: string;
  readonly loadedAt?: string;
  readonly playedAt?: string;
  readonly completedAt?: string;
  readonly interruptedAt?: string;
  readonly lastError?: string;
}

export interface ClaimActionInput {
  readonly scheduleId: string;
  readonly hallId: string;
  readonly actionKey: string;
  readonly actionType: string;
  readonly triggerKind: string;
  readonly plannedAt?: string;
  readonly payload?: Record<string, unknown>;
  readonly maxRetryCount?: number;
  readonly retryAfterMs?: number;
}

export interface FilmSchedulerManagedHall {
  readonly hallId: string;
  readonly enabled: boolean;
  readonly alignFeatureStart: boolean;
  readonly autoDisableAt?: string;
  readonly updatedAt: string;
}

interface RuntimeRow extends mysql.RowDataPacket {
  readonly schedule_id: string;
  readonly hall_id: string;
  readonly show_date: Date | string;
  readonly runtime_status: string;
  readonly active_show_uuid: string | null;
  readonly last_playback_state: string | null;
  readonly last_position_seconds: string | number | null;
  readonly last_position_at: Date | string | null;
  readonly loaded_at: Date | string | null;
  readonly played_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly interrupted_at: Date | string | null;
  readonly last_error: string | null;
  readonly updated_at: Date | string;
}

interface ActionRow extends mysql.RowDataPacket {
  readonly id: string;
  readonly schedule_id: string;
  readonly hall_id: string;
  readonly action_key: string;
  readonly action_type: string;
  readonly trigger_kind: string;
  readonly planned_at: Date | string | null;
  readonly triggered_at: Date | string | null;
  readonly action_status: string;
  readonly retry_count: number;
  readonly payload_json: string | Record<string, unknown> | null;
  readonly result_json: string | Record<string, unknown> | null;
  readonly error_message: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface ManagedHallRow extends mysql.RowDataPacket {
  readonly hall_id: string;
  readonly enabled: number | boolean;
  readonly align_feature_start: number | boolean | null;
  readonly auto_disable_at: Date | string | null;
  readonly updated_at: Date | string;
}

export async function ensureFilmSchedulerSchema(connection: mysql.Connection): Promise<void> {
  await ensureSetupSchema(connection);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_film_schedule_runtime (
      schedule_id CHAR(36) NOT NULL PRIMARY KEY,
      hall_id VARCHAR(128) NOT NULL,
      show_date DATE NOT NULL,
      runtime_status VARCHAR(32) NOT NULL,
      active_show_uuid VARCHAR(128) NULL,
      last_playback_state VARCHAR(64) NULL,
      last_position_seconds DECIMAL(12,3) NULL,
      last_position_at DATETIME NULL,
      loaded_at DATETIME NULL,
      played_at DATETIME NULL,
      completed_at DATETIME NULL,
      interrupted_at DATETIME NULL,
      last_error TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_tms_film_schedule_runtime_date_hall (show_date, hall_id),
      KEY idx_tms_film_schedule_runtime_status (runtime_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_film_schedule_action_execution (
      id CHAR(36) NOT NULL PRIMARY KEY,
      schedule_id CHAR(36) NOT NULL,
      hall_id VARCHAR(128) NOT NULL,
      action_key VARCHAR(255) NOT NULL,
      action_type VARCHAR(64) NOT NULL,
      trigger_kind VARCHAR(64) NOT NULL,
      planned_at DATETIME NULL,
      triggered_at DATETIME NULL,
      action_status VARCHAR(16) NOT NULL,
      retry_count INT NOT NULL DEFAULT 0,
      payload_json JSON NOT NULL,
      result_json JSON NULL,
      error_message TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tms_film_schedule_action_key (action_key),
      KEY idx_tms_film_schedule_action_schedule (schedule_id),
      KEY idx_tms_film_schedule_action_hall_time (hall_id, triggered_at),
      KEY idx_tms_film_schedule_action_status (action_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_film_scheduler_managed_hall (
      hall_id VARCHAR(128) NOT NULL PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      align_feature_start TINYINT(1) NOT NULL DEFAULT 1,
      auto_disable_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_tms_film_scheduler_managed_enabled (enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumn(connection, "tms_film_scheduler_managed_hall", "align_feature_start", `
    ALTER TABLE tms_film_scheduler_managed_hall
    ADD COLUMN align_feature_start TINYINT(1) NOT NULL DEFAULT 1 AFTER enabled
  `);
  await ensureColumn(connection, "tms_film_scheduler_managed_hall", "auto_disable_at", `
    ALTER TABLE tms_film_scheduler_managed_hall
    ADD COLUMN auto_disable_at DATETIME NULL AFTER align_feature_start
  `);
}

export async function listFilmSchedulerManagedHalls(): Promise<FilmSchedulerManagedHall[]> {
  const connection = await openFilmSchedulerConnection();
  try {
    await expireManagedHalls(connection);
    const [rows] = await connection.execute<ManagedHallRow[]>(`
      SELECT hall_id, enabled, align_feature_start, auto_disable_at, updated_at
      FROM tms_film_scheduler_managed_hall
      ORDER BY hall_id ASC
    `);
    return rows.map(mapManagedHallRow);
  } finally {
    await connection.end();
  }
}

export async function listEnabledFilmSchedulerHallIds(): Promise<string[]> {
  const connection = await openFilmSchedulerConnection();
  try {
    await expireManagedHalls(connection);
    const [rows] = await connection.execute<ManagedHallRow[]>(`
      SELECT hall_id, enabled, align_feature_start, auto_disable_at, updated_at
      FROM tms_film_scheduler_managed_hall
      WHERE enabled = 1 AND (auto_disable_at IS NULL OR auto_disable_at > NOW())
      ORDER BY hall_id ASC
    `);
    return rows.map((row) => row.hall_id).filter(Boolean);
  } finally {
    await connection.end();
  }
}

export async function listEnabledFilmSchedulerManagedHalls(): Promise<FilmSchedulerManagedHall[]> {
  const connection = await openFilmSchedulerConnection();
  try {
    await expireManagedHalls(connection);
    const [rows] = await connection.execute<ManagedHallRow[]>(`
      SELECT hall_id, enabled, align_feature_start, auto_disable_at, updated_at
      FROM tms_film_scheduler_managed_hall
      WHERE enabled = 1 AND (auto_disable_at IS NULL OR auto_disable_at > NOW())
      ORDER BY hall_id ASC
    `);
    return rows.map(mapManagedHallRow);
  } finally {
    await connection.end();
  }
}

export async function setFilmSchedulerManagedHall(
  hallId: string,
  enabled: boolean,
  options: { readonly alignFeatureStart?: boolean; readonly autoDisableAt?: string } = {},
): Promise<FilmSchedulerManagedHall> {
  const normalizedHallId = hallId.trim();
  if (!normalizedHallId) {
    throw new Error("缺少影厅。");
  }

  const connection = await openFilmSchedulerConnection();
  try {
    await expireManagedHalls(connection);
    const autoDisableAt = enabled && options.autoDisableAt ? toMysqlDateTime(options.autoDisableAt) : null;
    await connection.execute(
      `
        INSERT INTO tms_film_scheduler_managed_hall (hall_id, enabled, align_feature_start, auto_disable_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          enabled = VALUES(enabled),
          align_feature_start = VALUES(align_feature_start),
          auto_disable_at = VALUES(auto_disable_at)
      `,
      [normalizedHallId, enabled ? 1 : 0, options.alignFeatureStart === false ? 0 : 1, autoDisableAt],
    );
    const [rows] = await connection.execute<ManagedHallRow[]>(
      `
        SELECT hall_id, enabled, align_feature_start, auto_disable_at, updated_at
        FROM tms_film_scheduler_managed_hall
        WHERE hall_id = ?
        LIMIT 1
      `,
      [normalizedHallId],
    );
    return mapManagedHallRow(rows[0]);
  } finally {
    await connection.end();
  }
}

export async function listFilmScheduleRuntimeRecords(showDate: string): Promise<FilmScheduleRuntimeRecord[]> {
  const connection = await openFilmSchedulerConnection();
  try {
    const [rows] = await connection.execute<RuntimeRow[]>(
      `
        SELECT *
        FROM tms_film_schedule_runtime
        WHERE show_date = ?
        ORDER BY hall_id ASC, updated_at DESC
      `,
      [showDate],
    );
    return rows.map(mapRuntimeRow);
  } finally {
    await connection.end();
  }
}

export async function listFilmScheduleActionExecutions(filter: {
  readonly showDate?: string;
  readonly scheduleId?: string;
  readonly limit?: number;
} = {}): Promise<FilmScheduleActionExecution[]> {
  const connection = await openFilmSchedulerConnection();
  try {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter.scheduleId) {
      conditions.push("action.schedule_id = ?");
      params.push(filter.scheduleId);
    }
    if (filter.showDate) {
      conditions.push("runtime.show_date = ?");
      params.push(filter.showDate);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = normalizeLimit(filter.limit, 200, 1000);
    const [rows] = await connection.execute<ActionRow[]>(
      `
        SELECT action.*
        FROM tms_film_schedule_action_execution action
        LEFT JOIN tms_film_schedule_runtime runtime ON runtime.schedule_id = action.schedule_id
        ${where}
        ORDER BY action.triggered_at DESC, action.updated_at DESC
        LIMIT ${limit}
      `,
      params,
    );
    return rows.map(mapActionRow);
  } finally {
    await connection.end();
  }
}

export async function readFilmScheduleRuntime(
  scheduleId: string,
): Promise<FilmScheduleRuntimeRecord | null> {
  const connection = await openFilmSchedulerConnection();
  try {
    return readRuntimeByScheduleId(connection, scheduleId);
  } finally {
    await connection.end();
  }
}

export async function abortFilmScheduleRuntimeMonitoring(
  scheduleId: string,
  input: {
    readonly activeShowUuid?: string;
    readonly lastPlaybackState?: string;
    readonly lastPositionSeconds?: number;
    readonly interruptedAt: string;
    readonly lastError: string;
  },
): Promise<FilmScheduleRuntimeRecord> {
  const normalizedId = scheduleId.trim();
  if (!normalizedId) {
    throw new ApiError(400, "缺少排程 ID。");
  }

  const connection = await openFilmSchedulerConnection();
  try {
    const existing = await readRuntimeByScheduleId(connection, normalizedId);
    if (!existing) {
      throw new ApiError(404, "未找到当前排程运行状态。");
    }

    await connection.execute(
      `
        UPDATE tms_film_schedule_runtime
        SET
          runtime_status = 'aborted',
          active_show_uuid = COALESCE(?, active_show_uuid),
          last_playback_state = COALESCE(?, last_playback_state),
          last_position_seconds = COALESCE(?, last_position_seconds),
          last_position_at = ?,
          interrupted_at = ?,
          last_error = ?
        WHERE schedule_id = ?
      `,
      [
        input.activeShowUuid ?? null,
        input.lastPlaybackState ?? null,
        input.lastPositionSeconds ?? null,
        toMysqlDateTime(input.interruptedAt),
        toMysqlDateTime(input.interruptedAt),
        input.lastError,
        normalizedId,
      ],
    );

    const updated = await readRuntimeByScheduleId(connection, normalizedId);
    if (!updated) {
      throw new ApiError(500, "退出排程监控后读取状态失败。");
    }
    return updated;
  } finally {
    await connection.end();
  }
}

export async function upsertFilmScheduleRuntime(input: RuntimeObservationInput): Promise<void> {
  const connection = await openFilmSchedulerConnection();
  try {
    await connection.execute(
      `
        INSERT INTO tms_film_schedule_runtime (
          schedule_id,
          hall_id,
          show_date,
          runtime_status,
          active_show_uuid,
          last_playback_state,
          last_position_seconds,
          last_position_at,
          loaded_at,
          played_at,
          completed_at,
          interrupted_at,
          last_error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          hall_id = VALUES(hall_id),
          show_date = VALUES(show_date),
          active_show_uuid = VALUES(active_show_uuid),
          last_playback_state = VALUES(last_playback_state),
          last_position_seconds = VALUES(last_position_seconds),
          last_position_at = VALUES(last_position_at),
          loaded_at = COALESCE(VALUES(loaded_at), loaded_at),
          played_at = COALESCE(VALUES(played_at), played_at),
          completed_at = COALESCE(VALUES(completed_at), completed_at),
          interrupted_at = CASE
            WHEN runtime_status <> VALUES(runtime_status) THEN VALUES(interrupted_at)
            WHEN interrupted_at IS NULL THEN VALUES(interrupted_at)
            ELSE interrupted_at
          END,
          runtime_status = VALUES(runtime_status),
          last_error = VALUES(last_error)
      `,
      [
        input.scheduleId,
        input.hallId,
        input.showDate,
        input.status,
        input.activeShowUuid ?? null,
        input.lastPlaybackState ?? null,
        input.lastPositionSeconds ?? null,
        input.lastPositionAt ? toMysqlDateTime(input.lastPositionAt) : null,
        input.loadedAt ? toMysqlDateTime(input.loadedAt) : null,
        input.playedAt ? toMysqlDateTime(input.playedAt) : null,
        input.completedAt ? toMysqlDateTime(input.completedAt) : null,
        input.interruptedAt ? toMysqlDateTime(input.interruptedAt) : null,
        input.lastError ?? null,
      ],
    );
  } finally {
    await connection.end();
  }
}

export async function tryClaimFilmScheduleAction(
  input: ClaimActionInput,
): Promise<FilmScheduleActionExecution | null> {
  const connection = await openFilmSchedulerConnection();
  const now = new Date().toISOString();
  const id = randomUUID();
  const maxRetryCount = input.maxRetryCount ?? 3;
  const retryAfterMs = input.retryAfterMs ?? 5_000;

  try {
    const [insertResult] = await connection.execute<mysql.ResultSetHeader>(
      `
        INSERT IGNORE INTO tms_film_schedule_action_execution (
          id,
          schedule_id,
          hall_id,
          action_key,
          action_type,
          trigger_kind,
          planned_at,
          triggered_at,
          action_status,
          retry_count,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, CAST(? AS JSON))
      `,
      [
        id,
        input.scheduleId,
        input.hallId,
        input.actionKey,
        input.actionType,
        input.triggerKind,
        input.plannedAt ? toMysqlDateTime(input.plannedAt) : null,
        toMysqlDateTime(now),
        JSON.stringify(input.payload ?? {}),
      ],
    );

    if (insertResult.affectedRows > 0) {
      return readActionById(connection, id);
    }

    const existing = await readActionByKey(connection, input.actionKey);
    if (!existing || existing.status === "success" || existing.status === "running") {
      return null;
    }

    const updatedAtMs = Date.parse(existing.updatedAt);
    const retryDue = Number.isNaN(updatedAtMs) || Date.now() - updatedAtMs >= retryAfterMs;
    if (!retryDue || existing.retryCount >= maxRetryCount) {
      return null;
    }

    const [updateResult] = await connection.execute<mysql.ResultSetHeader>(
      `
        UPDATE tms_film_schedule_action_execution
        SET
          action_status = 'running',
          retry_count = retry_count + 1,
          triggered_at = ?,
          payload_json = CAST(? AS JSON),
          error_message = NULL,
          result_json = NULL
        WHERE action_key = ?
          AND action_status = 'failed'
          AND retry_count < ?
      `,
      [
        toMysqlDateTime(now),
        JSON.stringify(input.payload ?? existing.payload),
        input.actionKey,
        maxRetryCount,
      ],
    );

    return updateResult.affectedRows > 0 ? readActionByKey(connection, input.actionKey) : null;
  } finally {
    await connection.end();
  }
}

export async function markFilmScheduleActionSuccess(
  id: string,
  result: Record<string, unknown> = {},
): Promise<void> {
  const connection = await openFilmSchedulerConnection();
  try {
    await connection.execute(
      `
        UPDATE tms_film_schedule_action_execution
        SET action_status = 'success',
            result_json = CAST(? AS JSON),
            error_message = NULL
        WHERE id = ?
      `,
      [JSON.stringify(result), id],
    );
  } finally {
    await connection.end();
  }
}

export async function markFilmScheduleActionFailure(id: string, error: unknown): Promise<void> {
  const connection = await openFilmSchedulerConnection();
  try {
    await connection.execute(
      `
        UPDATE tms_film_schedule_action_execution
        SET action_status = 'failed',
            error_message = ?
        WHERE id = ?
      `,
      [error instanceof Error ? error.message : String(error), id],
    );
  } finally {
    await connection.end();
  }
}

export async function expireStaleRunningFilmScheduleActions(
  timeoutMs: number,
  message = "排程动作执行中断，系统已释放该动作以便重试。",
): Promise<number> {
  const connection = await openFilmSchedulerConnection();
  const threshold = new Date(Date.now() - Math.max(0, timeoutMs)).toISOString();
  try {
    const [result] = await connection.execute<mysql.ResultSetHeader>(
      `
        UPDATE tms_film_schedule_action_execution
        SET action_status = 'failed',
            error_message = ?,
            result_json = NULL
        WHERE action_status = 'running'
          AND updated_at < ?
      `,
      [message, toMysqlDateTime(threshold)],
    );
    return result.affectedRows;
  } finally {
    await connection.end();
  }
}

export async function hasSuccessfulFilmScheduleAction(actionKey: string): Promise<boolean> {
  const connection = await openFilmSchedulerConnection();
  try {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `
        SELECT 1
        FROM tms_film_schedule_action_execution
        WHERE action_key = ? AND action_status = 'success'
        LIMIT 1
      `,
      [actionKey],
    );
    return rows.length > 0;
  } finally {
    await connection.end();
  }
}

async function openFilmSchedulerConnection(): Promise<mysql.Connection> {
  const connection = await createDatabaseConnection();
  await ensureFilmSchedulerSchema(connection);
  return connection;
}

async function readRuntimeByScheduleId(
  connection: mysql.Connection,
  scheduleId: string,
): Promise<FilmScheduleRuntimeRecord | null> {
  const [rows] = await connection.execute<RuntimeRow[]>(
    "SELECT * FROM tms_film_schedule_runtime WHERE schedule_id = ? LIMIT 1",
    [scheduleId],
  );
  return rows[0] ? mapRuntimeRow(rows[0]) : null;
}

async function readActionById(
  connection: mysql.Connection,
  id: string,
): Promise<FilmScheduleActionExecution | null> {
  const [rows] = await connection.execute<ActionRow[]>(
    "SELECT * FROM tms_film_schedule_action_execution WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0] ? mapActionRow(rows[0]) : null;
}

async function readActionByKey(
  connection: mysql.Connection,
  actionKey: string,
): Promise<FilmScheduleActionExecution | null> {
  const [rows] = await connection.execute<ActionRow[]>(
    "SELECT * FROM tms_film_schedule_action_execution WHERE action_key = ? LIMIT 1",
    [actionKey],
  );
  return rows[0] ? mapActionRow(rows[0]) : null;
}

function mapRuntimeRow(row: RuntimeRow): FilmScheduleRuntimeRecord {
  return {
    scheduleId: row.schedule_id,
    hallId: row.hall_id,
    showDate: normalizeDateOnly(row.show_date),
    status: normalizeRuntimeStatus(row.runtime_status),
    activeShowUuid: optionalString(row.active_show_uuid),
    lastPlaybackState: optionalString(row.last_playback_state),
    lastPositionSeconds: optionalNumber(row.last_position_seconds),
    lastPositionAt: optionalDateTime(row.last_position_at),
    loadedAt: optionalDateTime(row.loaded_at),
    playedAt: optionalDateTime(row.played_at),
    completedAt: optionalDateTime(row.completed_at),
    interruptedAt: optionalDateTime(row.interrupted_at),
    lastError: optionalString(row.last_error),
    updatedAt: normalizeDateTime(row.updated_at),
  };
}

function mapActionRow(row: ActionRow): FilmScheduleActionExecution {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    hallId: row.hall_id,
    actionKey: row.action_key,
    actionType: row.action_type,
    triggerKind: row.trigger_kind,
    plannedAt: optionalDateTime(row.planned_at),
    triggeredAt: optionalDateTime(row.triggered_at),
    status: normalizeActionStatus(row.action_status),
    retryCount: Number(row.retry_count) || 0,
    payload: normalizeJsonRecord(row.payload_json),
    result: row.result_json === null ? undefined : normalizeJsonRecord(row.result_json),
    errorMessage: optionalString(row.error_message),
    createdAt: normalizeDateTime(row.created_at),
    updatedAt: normalizeDateTime(row.updated_at),
  };
}

function mapManagedHallRow(row: ManagedHallRow): FilmSchedulerManagedHall {
  return {
    hallId: row.hall_id,
    enabled: Boolean(row.enabled),
    alignFeatureStart: row.align_feature_start !== null ? Boolean(row.align_feature_start) : true,
    autoDisableAt: optionalDateTime(row.auto_disable_at),
    updatedAt: normalizeDateTime(row.updated_at),
  };
}

async function expireManagedHalls(connection: mysql.Connection): Promise<void> {
  await connection.execute(`
    UPDATE tms_film_scheduler_managed_hall
    SET enabled = 0
    WHERE enabled = 1
      AND auto_disable_at IS NOT NULL
      AND auto_disable_at <= NOW()
  `);
}

function normalizeRuntimeStatus(value: string): FilmScheduleRuntimeStatus {
  return value === "preparing"
    || value === "ready"
    || value === "playing"
    || value === "manual_hold"
    || value === "monitor_lost"
    || value === "transitioning"
    || value === "completed"
    || value === "aborted"
    || value === "failed"
    || value === "skipped"
    ? value
    : "pending";
}

function normalizeActionStatus(value: string): FilmScheduleActionStatus {
  return value === "success" || value === "failed" ? value : "running";
}

async function ensureColumn(
  connection: mysql.Connection,
  tableName: string,
  columnName: string,
  alterSql: string,
): Promise<void> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [tableName, columnName],
  );
  if (rows.length > 0) {
    return;
  }
  await connection.execute(alterSql);
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || !value || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function normalizeJsonRecord(value: unknown): Record<string, unknown> {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalDateTime(value: Date | string | null): string | undefined {
  return value === null ? undefined : normalizeDateTime(value);
}

function normalizeDateOnly(value: Date | string): string {
  if (value instanceof Date) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-");
  }
  return String(value).slice(0, 10);
}

function normalizeDateTime(value: Date | string): string {
  if (value instanceof Date) {
    return formatLocalDateTime(value);
  }
  return String(value).replace(" ", "T").slice(0, 19);
}

function toMysqlDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 19).replace("T", " ");
  }
  return formatLocalDateTime(date).replace("T", " ");
}

function formatLocalDateTime(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-") + "T" + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
}
