import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { ApiError } from "./http";
import { createDatabaseConnection, ensureSetupSchema } from "./setup-store";

export type FilmScheduleSource = "ticketing" | "custom";

export interface FilmScheduleEntryInput {
  readonly showDate: string;
  readonly startTime: string;
  readonly endTime?: string;
  readonly hallId: string;
  readonly hallName: string;
  readonly finixxHallId?: string;
  readonly filmCd: string;
  readonly filmName: string;
  readonly filmVisual?: string;
  readonly filmLanguage?: string;
  readonly ruleId: string;
  readonly ruleSnapshot: unknown;
  readonly source: FilmScheduleSource;
  readonly ticketingSessionId?: string;
  readonly ticketingRaw?: unknown;
  readonly notes?: string;
  readonly autoManaged?: boolean;
}

export interface FilmScheduleEntry extends FilmScheduleEntryInput {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FilmScheduleEntryRow extends mysql.RowDataPacket {
  readonly id: string;
  readonly show_date: Date | string;
  readonly start_time: Date | string;
  readonly end_time: Date | string | null;
  readonly hall_id: string;
  readonly hall_name: string;
  readonly finixx_hall_id: string | null;
  readonly film_cd: string;
  readonly film_name: string;
  readonly film_visual: string | null;
  readonly film_language: string | null;
  readonly rule_id: string;
  readonly rule_snapshot: string | unknown;
  readonly source: string;
  readonly ticketing_session_id: string | null;
  readonly ticketing_raw: string | unknown | null;
  readonly notes: string | null;
  readonly auto_managed: number | boolean | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export async function listFilmScheduleEntries(showDate: string): Promise<FilmScheduleEntry[]> {
  const normalizedDate = normalizeDateOnly(showDate);
  const connection = await openFilmScheduleConnection();
  try {
    const [rows] = await connection.execute<FilmScheduleEntryRow[]>(
      `
        SELECT *
        FROM tms_film_schedule_entries
        WHERE show_date = ?
        ORDER BY start_time ASC, hall_name ASC, film_name ASC
      `,
      [normalizedDate],
    );
    return rows.map(mapEntryRow);
  } finally {
    await connection.end();
  }
}

export async function createFilmScheduleEntry(input: FilmScheduleEntryInput): Promise<FilmScheduleEntry> {
  const normalized = normalizeEntryInput(input);
  const connection = await openFilmScheduleConnection();
  try {
    const id = randomUUID();
    await assertNoScheduleOverlap(connection, normalized);
    await connection.execute(
      `
        INSERT INTO tms_film_schedule_entries (
          id,
          show_date,
          start_time,
          end_time,
          hall_id,
          hall_name,
          finixx_hall_id,
          film_cd,
          film_name,
          film_visual,
          film_language,
          rule_id,
          rule_snapshot,
          source,
          ticketing_session_id,
          ticketing_raw,
          notes,
          auto_managed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, CAST(? AS JSON), ?, ?)
      `,
      [
        id,
        normalized.showDate,
        toMysqlDateTime(normalized.startTime),
        normalized.endTime ? toMysqlDateTime(normalized.endTime) : null,
        normalized.hallId,
        normalized.hallName,
        normalized.finixxHallId ?? null,
        normalized.filmCd,
        normalized.filmName,
        normalized.filmVisual ?? null,
        normalized.filmLanguage ?? null,
        normalized.ruleId,
        JSON.stringify(normalized.ruleSnapshot ?? null),
        normalized.source,
        normalized.ticketingSessionId ?? null,
        JSON.stringify(normalized.ticketingRaw ?? null),
        normalized.notes ?? null,
        normalized.autoManaged ? 1 : 0,
      ],
    );

    const entry = await readEntryById(connection, id);
    if (!entry) {
      throw new Error("排期创建失败。");
    }
    return entry;
  } finally {
    await connection.end();
  }
}

export async function updateFilmScheduleEntry(
  id: string,
  input: Partial<FilmScheduleEntryInput>,
): Promise<FilmScheduleEntry> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new ApiError(400, "缺少排期 ID。");
  }

  const connection = await openFilmScheduleConnection();
  try {
    const existing = await readEntryById(connection, normalizedId);
    if (!existing) {
      throw new ApiError(404, "未找到指定排期。");
    }

    const merged = normalizeEntryInput({
      ...existing,
      ...input,
      showDate: input.showDate ?? existing.showDate,
      startTime: input.startTime ?? existing.startTime,
      endTime: input.endTime ?? existing.endTime,
      hallId: input.hallId ?? existing.hallId,
      hallName: input.hallName ?? existing.hallName,
      filmCd: input.filmCd ?? existing.filmCd,
      filmName: input.filmName ?? existing.filmName,
      ruleId: input.ruleId ?? existing.ruleId,
      ruleSnapshot: input.ruleSnapshot ?? existing.ruleSnapshot,
      source: input.source ?? existing.source,
    });

    await assertNoScheduleOverlap(connection, merged, normalizedId);
    await connection.execute(
      `
        UPDATE tms_film_schedule_entries
        SET
          show_date = ?,
          start_time = ?,
          end_time = ?,
          hall_id = ?,
          hall_name = ?,
          finixx_hall_id = ?,
          film_cd = ?,
          film_name = ?,
          film_visual = ?,
          film_language = ?,
          rule_id = ?,
          rule_snapshot = CAST(? AS JSON),
          source = ?,
          ticketing_session_id = ?,
          ticketing_raw = CAST(? AS JSON),
          notes = ?,
          auto_managed = ?
        WHERE id = ?
      `,
      [
        merged.showDate,
        toMysqlDateTime(merged.startTime),
        merged.endTime ? toMysqlDateTime(merged.endTime) : null,
        merged.hallId,
        merged.hallName,
        merged.finixxHallId ?? null,
        merged.filmCd,
        merged.filmName,
        merged.filmVisual ?? null,
        merged.filmLanguage ?? null,
        merged.ruleId,
        JSON.stringify(merged.ruleSnapshot ?? null),
        merged.source,
        merged.ticketingSessionId ?? null,
        JSON.stringify(merged.ticketingRaw ?? null),
        merged.notes ?? null,
        merged.autoManaged ? 1 : 0,
        normalizedId,
      ],
    );

    const updated = await readEntryById(connection, normalizedId);
    if (!updated) {
      throw new ApiError(404, "未找到指定排期。");
    }
    return updated;
  } finally {
    await connection.end();
  }
}

export async function deleteFilmScheduleEntry(id: string): Promise<FilmScheduleEntry> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new ApiError(400, "缺少排期 ID。");
  }

  const connection = await openFilmScheduleConnection();
  try {
    const existing = await readEntryById(connection, normalizedId);
    if (!existing) {
      throw new ApiError(404, "未找到指定排期。");
    }
    await connection.execute("DELETE FROM tms_film_schedule_entries WHERE id = ?", [normalizedId]);
    return existing;
  } finally {
    await connection.end();
  }
}

async function openFilmScheduleConnection(): Promise<mysql.Connection> {
  const connection = await createDatabaseConnection();
  await ensureFilmScheduleSchema(connection);
  return connection;
}

async function ensureFilmScheduleSchema(connection: mysql.Connection): Promise<void> {
  await ensureSetupSchema(connection);
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_film_schedule_entries (
      id CHAR(36) PRIMARY KEY,
      show_date DATE NOT NULL,
      start_time DATETIME NOT NULL,
      end_time DATETIME NULL,
      hall_id VARCHAR(128) NOT NULL,
      hall_name VARCHAR(255) NOT NULL,
      finixx_hall_id VARCHAR(128) NULL,
      film_cd VARCHAR(128) NOT NULL,
      film_name VARCHAR(255) NOT NULL,
      film_visual VARCHAR(64) NULL,
      film_language VARCHAR(128) NULL,
      rule_id CHAR(36) NOT NULL,
      rule_snapshot JSON NOT NULL,
      source VARCHAR(32) NOT NULL,
      ticketing_session_id VARCHAR(128) NULL,
      ticketing_raw JSON NULL,
      notes VARCHAR(500) NULL,
      auto_managed TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_tms_film_schedule_date_time (show_date, start_time),
      KEY idx_tms_film_schedule_hall_date (hall_id, show_date),
      KEY idx_tms_film_schedule_rule (rule_id),
      KEY idx_tms_film_schedule_auto (auto_managed, show_date, hall_id, ticketing_session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumn(connection, "tms_film_schedule_entries", "auto_managed", `
    ALTER TABLE tms_film_schedule_entries
    ADD COLUMN auto_managed TINYINT(1) NOT NULL DEFAULT 0 AFTER notes
  `);
  await ensureIndex(connection, "tms_film_schedule_entries", "idx_tms_film_schedule_auto", `
    ALTER TABLE tms_film_schedule_entries
    ADD KEY idx_tms_film_schedule_auto (auto_managed, show_date, hall_id, ticketing_session_id)
  `);
}

async function readEntryById(connection: mysql.Connection, id: string): Promise<FilmScheduleEntry | null> {
  const [rows] = await connection.execute<FilmScheduleEntryRow[]>(
    "SELECT * FROM tms_film_schedule_entries WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0] ? mapEntryRow(rows[0]) : null;
}

async function assertNoScheduleOverlap(
  connection: mysql.Connection,
  input: FilmScheduleEntryInput,
  ignoreId?: string,
): Promise<void> {
  if (!input.endTime) {
    return;
  }

  const conditions = [
    "show_date = ?",
    "hall_id = ?",
    "start_time < ?",
    "COALESCE(end_time, start_time) > ?",
  ];
  const params: string[] = [
    input.showDate,
    input.hallId,
    toMysqlDateTime(input.endTime),
    toMysqlDateTime(input.startTime),
  ];

  if (ignoreId) {
    conditions.push("id <> ?");
    params.push(ignoreId);
  }

  const [rows] = await connection.execute<FilmScheduleEntryRow[]>(
    `
      SELECT *
      FROM tms_film_schedule_entries
      WHERE ${conditions.join(" AND ")}
      ORDER BY start_time ASC
      LIMIT 1
    `,
    params,
  );

  const conflict = rows[0] ? mapEntryRow(rows[0]) : null;
  if (!conflict) {
    return;
  }

  throw new ApiError(
    409,
    `该影厅 ${formatClock(input.startTime)}-${formatClock(input.endTime)} 已与 ${conflict.filmName} ${formatClock(conflict.startTime)}-${formatClock(conflict.endTime)} 重叠。`,
  );
}

function normalizeEntryInput(input: FilmScheduleEntryInput): FilmScheduleEntryInput {
  const showDate = normalizeDateOnly(input.showDate);
  const startTime = normalizeLocalDateTime(input.startTime, "开始时间");
  const endTime = input.endTime ? normalizeLocalDateTime(input.endTime, "结束时间") : undefined;
  const hallId = readNonEmpty(input.hallId, "缺少影厅。");
  const hallName = readNonEmpty(input.hallName, "缺少影厅名称。");
  const filmCd = readNonEmpty(input.filmCd, "缺少影片版本。");
  const filmName = readNonEmpty(input.filmName, "缺少影片名称。");
  const ruleId = readNonEmpty(input.ruleId, "缺少影片放映模板。");
  const source = input.source === "custom" ? "custom" : "ticketing";

  if (!sameDate(startTime, showDate)) {
    throw new ApiError(400, "开始时间必须属于当前排期日期。");
  }
  assertSchedulableStartTime(startTime);
  if (endTime && new Date(endTime).getTime() <= new Date(startTime).getTime()) {
    throw new ApiError(400, "结束时间必须晚于开始时间。");
  }

  return {
    showDate,
    startTime,
    endTime,
    hallId,
    hallName,
    finixxHallId: trimOptional(input.finixxHallId),
    filmCd,
    filmName,
    filmVisual: trimOptional(input.filmVisual),
    filmLanguage: trimOptional(input.filmLanguage),
    ruleId,
    ruleSnapshot: input.ruleSnapshot,
    source,
    ticketingSessionId: trimOptional(input.ticketingSessionId),
    ticketingRaw: input.ticketingRaw,
    notes: trimOptional(input.notes),
    autoManaged: input.autoManaged === true,
  };
}

function mapEntryRow(row: FilmScheduleEntryRow): FilmScheduleEntry {
  return {
    id: row.id,
    showDate: normalizeDateOnly(String(row.show_date instanceof Date ? toDateOnly(row.show_date) : row.show_date)),
    startTime: normalizeDateTimeForClient(row.start_time),
    endTime: row.end_time ? normalizeDateTimeForClient(row.end_time) : undefined,
    hallId: row.hall_id,
    hallName: row.hall_name,
    finixxHallId: row.finixx_hall_id ?? undefined,
    filmCd: row.film_cd,
    filmName: row.film_name,
    filmVisual: row.film_visual ?? undefined,
    filmLanguage: row.film_language ?? undefined,
    ruleId: row.rule_id,
    ruleSnapshot: parseJsonValue(row.rule_snapshot),
    source: row.source === "custom" ? "custom" : "ticketing",
    ticketingSessionId: row.ticketing_session_id ?? undefined,
    ticketingRaw: parseJsonValue(row.ticketing_raw),
    notes: row.notes ?? undefined,
    autoManaged: Boolean(row.auto_managed),
    createdAt: normalizeDateTimeForClient(row.created_at),
    updatedAt: normalizeDateTimeForClient(row.updated_at),
  };
}

async function ensureColumn(
  connection: mysql.Connection,
  tableName: string,
  columnName: string,
  alterSql: string,
): Promise<void> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    `
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [tableName, columnName],
  );
  if (rows.length === 0) {
    await connection.execute(alterSql);
  }
}

async function ensureIndex(
  connection: mysql.Connection,
  tableName: string,
  indexName: string,
  alterSql: string,
): Promise<void> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    `
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1
    `,
    [tableName, indexName],
  );
  if (rows.length === 0) {
    await connection.execute(alterSql);
  }
}

function readNonEmpty(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, message);
  }
  return value.trim();
}

function trimOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    throw new ApiError(400, "日期格式不正确。");
  }
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(date.getTime()) || toDateOnly(date) !== normalized) {
    throw new ApiError(400, "日期格式不正确。");
  }
  return normalized;
}

function normalizeLocalDateTime(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, `${label}格式不正确。`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) {
    throw new ApiError(400, `${label}格式不正确。`);
  }
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime()) || normalizeDateTimeForClient(date) !== normalized) {
    throw new ApiError(400, `${label}格式不正确。`);
  }
  return normalized;
}

function sameDate(dateTime: string, showDate: string): boolean {
  return dateTime.slice(0, 10) === showDate;
}

function assertSchedulableStartTime(startTime: string): void {
  const start = new Date(startTime);
  const minimum = new Date(Date.now() + 60_000);
  if (Number.isNaN(start.getTime()) || start.getTime() < minimum.getTime()) {
    throw new ApiError(400, "只能添加未来排期，开始时间不得早于当前时间 1 分钟后。");
  }
}

function toMysqlDateTime(value: string): string {
  const normalized = normalizeDateTimeString(value);
  return `${normalized.slice(0, 10)} ${normalized.slice(11, 19)}`;
}

function normalizeDateTimeForClient(value: Date | string): string {
  if (value instanceof Date) {
    return `${toDateOnly(value)}T${[
      String(value.getHours()).padStart(2, "0"),
      String(value.getMinutes()).padStart(2, "0"),
      String(value.getSeconds()).padStart(2, "0"),
    ].join(":")}`;
  }
  return normalizeDateTimeString(String(value));
}

function normalizeDateTimeString(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) {
    return value.replace(" ", "T").slice(0, 19);
  }
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] || "00"}`;
}

function toDateOnly(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatClock(value: string | undefined): string {
  return value ? normalizeDateTimeString(value).slice(11, 19) : "--:--";
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
