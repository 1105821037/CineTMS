import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { ApiError } from "./http";
import { createDatabaseConnection, ensureSetupSchema } from "./setup-store";

export interface FilmPlaybackPlaylistRef {
  readonly hallId: string;
  readonly playlistId: string;
  readonly playlistName: string;
}

export interface FilmPlaybackTimePoint {
  readonly id?: string;
  readonly type: "head" | "tail" | "point" | "range";
  readonly note: string;
  readonly startSeconds: number;
  readonly endSeconds?: number;
  readonly action?: unknown;
}

export interface FilmPlaybackRuleInput {
  readonly filmCd: string;
  readonly filmName: string;
  readonly filmVisual?: string;
  readonly filmLanguage?: string;
  readonly hallIds: readonly string[];
  readonly playlistName: string;
  readonly playlistRefs: readonly FilmPlaybackPlaylistRef[];
  readonly timePoints?: readonly FilmPlaybackTimePoint[];
  readonly playlistSnapshot?: unknown;
  readonly rawFilm?: unknown;
}

export interface FilmPlaybackRule extends FilmPlaybackRuleInput {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FilmPlaybackRuleListFilter {
  readonly filmCd?: string;
  readonly hallId?: string;
  readonly search?: string;
}

export interface FilmPlaybackRulePageOptions extends FilmPlaybackRuleListFilter {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface FilmPlaybackRuleResolveOptions {
  readonly filmCds?: readonly string[];
  readonly ruleIds?: readonly string[];
}

export interface FilmPlaybackRuleSummary {
  readonly ruleCount: number;
  readonly filmCount: number;
  readonly hallCount: number;
}

export interface FilmPlaybackRuleFilterFilm {
  readonly filmCd: string;
  readonly filmName: string;
  readonly filmVisual?: string;
  readonly filmLanguage?: string;
}

export interface FilmPlaybackRuleOccupancy {
  readonly id: string;
  readonly filmCd: string;
  readonly hallIds: readonly string[];
}

export interface FilmPlaybackRulePage {
  readonly rules: FilmPlaybackRule[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly summary: FilmPlaybackRuleSummary;
  readonly filterFilms: FilmPlaybackRuleFilterFilm[];
  readonly occupancies: FilmPlaybackRuleOccupancy[];
}

interface NormalizedFilmPlaybackRuleInput {
  readonly filmCd: string;
  readonly filmName: string;
  readonly filmVisual?: string;
  readonly filmLanguage?: string;
  readonly hallIds: readonly string[];
  readonly playlistName: string;
  readonly playlistRefs: readonly FilmPlaybackPlaylistRef[];
  readonly timePoints: readonly FilmPlaybackTimePoint[];
  readonly playlistSnapshot?: unknown;
  readonly rawFilm?: unknown;
}

interface FilmPlaybackRuleRow extends mysql.RowDataPacket {
  readonly id: string;
  readonly film_cd: string;
  readonly film_name: string;
  readonly film_visual: string | null;
  readonly film_language: string | null;
  readonly hall_ids: string | readonly string[];
  readonly playlist_name: string;
  readonly playlist_refs: string | readonly FilmPlaybackPlaylistRef[];
  readonly time_points: string | readonly FilmPlaybackTimePoint[] | null;
  readonly playlist_snapshot: string | null | unknown;
  readonly raw_film: string | null | unknown;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export async function listFilmPlaybackRules(filter: {
  readonly filmCd?: string;
  readonly hallId?: string;
} = {}): Promise<FilmPlaybackRule[]> {
  const connection = await openFilmPlaybackConnection();
  try {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];

    if (filter.filmCd) {
      conditions.push("film_cd = ?");
      params.push(filter.filmCd.trim());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const [rows] = await connection.execute<FilmPlaybackRuleRow[]>(
      `SELECT * FROM tms_film_playback_rules ${where} ORDER BY updated_at DESC, film_name ASC`,
      params,
    );

    const rules = rows.map(mapRuleRow);
    if (!filter.hallId) {
      return rules;
    }

    return rules.filter((rule) => rule.hallIds.includes(filter.hallId!.trim()));
  } finally {
    await connection.end();
  }
}

export async function resolveFilmPlaybackRules(options: FilmPlaybackRuleResolveOptions): Promise<FilmPlaybackRule[]> {
  const filmCds = uniqueNonEmptyStrings(options.filmCds || []);
  const ruleIds = uniqueNonEmptyStrings(options.ruleIds || []);
  if (filmCds.length === 0 && ruleIds.length === 0) {
    return [];
  }

  const connection = await openFilmPlaybackConnection();
  try {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filmCds.length > 0) {
      conditions.push(`film_cd IN (${filmCds.map(() => "?").join(", ")})`);
      params.push(...filmCds);
    }
    if (ruleIds.length > 0) {
      conditions.push(`id IN (${ruleIds.map(() => "?").join(", ")})`);
      params.push(...ruleIds);
    }

    const [rows] = await connection.execute<FilmPlaybackRuleRow[]>(
      `
        SELECT *
        FROM tms_film_playback_rules
        WHERE ${conditions.map((condition) => `(${condition})`).join(" OR ")}
        ORDER BY film_name ASC, playlist_name ASC, updated_at DESC
      `,
      params,
    );
    return rows.map(mapRuleRow);
  } finally {
    await connection.end();
  }
}

export async function createFilmPlaybackRule(input: FilmPlaybackRuleInput): Promise<FilmPlaybackRule> {
  const normalized = normalizeRuleInput(input);
  const connection = await openFilmPlaybackConnection();
  try {
    await assertNoHallConflict(connection, normalized.filmCd, normalized.hallIds);
    const id = randomUUID();
    await connection.execute(
      `
        INSERT INTO tms_film_playback_rules (
          id,
          film_cd,
          film_name,
          film_visual,
          film_language,
          hall_ids,
          playlist_name,
          playlist_refs,
          time_points,
          playlist_snapshot,
          raw_film
        ) VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON))
      `,
      [
        id,
        normalized.filmCd,
        normalized.filmName,
        normalized.filmVisual ?? null,
        normalized.filmLanguage ?? null,
        JSON.stringify(normalized.hallIds),
        normalized.playlistName,
        JSON.stringify(normalized.playlistRefs),
        JSON.stringify(normalized.timePoints),
        JSON.stringify(normalized.playlistSnapshot ?? null),
        JSON.stringify(normalized.rawFilm ?? null),
      ],
    );

    const rule = await readFilmPlaybackRuleById(connection, id);
    if (!rule) {
      throw new Error("影片放映模板创建失败。");
    }
    return rule;
  } finally {
    await connection.end();
  }
}

export async function updateFilmPlaybackRule(id: string, input: FilmPlaybackRuleInput): Promise<FilmPlaybackRule> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new ApiError(400, "缺少规则 ID。");
  }

  const normalized = normalizeRuleInput(input);
  const connection = await openFilmPlaybackConnection();
  try {
    const existing = await readFilmPlaybackRuleById(connection, normalizedId);
    if (!existing) {
      throw new ApiError(404, "未找到指定的放映模板。");
    }

    await assertNoHallConflict(connection, normalized.filmCd, normalized.hallIds, normalizedId);
    await connection.execute(
      `
        UPDATE tms_film_playback_rules
        SET
          film_cd = ?,
          film_name = ?,
          film_visual = ?,
          film_language = ?,
          hall_ids = CAST(? AS JSON),
          playlist_name = ?,
          playlist_refs = CAST(? AS JSON),
          time_points = CAST(? AS JSON),
          playlist_snapshot = CAST(? AS JSON),
          raw_film = CAST(? AS JSON)
        WHERE id = ?
      `,
      [
        normalized.filmCd,
        normalized.filmName,
        normalized.filmVisual ?? null,
        normalized.filmLanguage ?? null,
        JSON.stringify(normalized.hallIds),
        normalized.playlistName,
        JSON.stringify(normalized.playlistRefs),
        JSON.stringify(normalized.timePoints),
        JSON.stringify(normalized.playlistSnapshot ?? null),
        JSON.stringify(normalized.rawFilm ?? null),
        normalizedId,
      ],
    );

    const updated = await readFilmPlaybackRuleById(connection, normalizedId);
    if (!updated) {
      throw new ApiError(404, "未找到指定的放映模板。");
    }
    return updated;
  } finally {
    await connection.end();
  }
}

export async function deleteFilmPlaybackRule(id: string): Promise<FilmPlaybackRule> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new ApiError(400, "缺少规则 ID。");
  }

  const connection = await openFilmPlaybackConnection();
  try {
    const existing = await readFilmPlaybackRuleById(connection, normalizedId);
    if (!existing) {
      throw new ApiError(404, "未找到指定的放映模板。");
    }

    await connection.execute("DELETE FROM tms_film_playback_rules WHERE id = ?", [normalizedId]);
    return existing;
  } finally {
    await connection.end();
  }
}

async function openFilmPlaybackConnection(): Promise<mysql.Connection> {
  const connection = await createDatabaseConnection();
  await ensureSetupSchema(connection);
  await ensureFilmPlaybackSchema(connection);
  return connection;
}

async function ensureFilmPlaybackSchema(connection: mysql.Connection): Promise<void> {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_film_playback_rules (
      id CHAR(36) PRIMARY KEY,
      film_cd VARCHAR(128) NOT NULL,
      film_name VARCHAR(255) NOT NULL,
      film_visual VARCHAR(64) NULL,
      film_language VARCHAR(128) NULL,
      hall_ids JSON NOT NULL,
      playlist_name VARCHAR(255) NOT NULL,
      playlist_refs JSON NOT NULL,
      time_points JSON NULL,
      playlist_snapshot JSON NULL,
      raw_film JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tms_film_playback_rules_film_cd (film_cd),
      INDEX idx_tms_film_playback_rules_updated_at (updated_at)
    )
  `);
  await ensureColumn(connection, "time_points", "JSON NULL AFTER playlist_refs");
  await ensureColumn(connection, "playlist_snapshot", "JSON NULL AFTER time_points");
  for (const columnName of [
    "feature_start_seconds",
    "credits_start_seconds",
    "egg_start_seconds",
    "egg_end_seconds",
    "feature_start_frames",
    "credits_start_frames",
    "egg_start_frames",
    "fps",
    "time_mode",
  ]) {
    await dropColumnIfExists(connection, columnName);
  }
}

export async function listFilmPlaybackRulePage(options: FilmPlaybackRulePageOptions = {}): Promise<FilmPlaybackRulePage> {
  const pageSize = normalizePageSize(options.pageSize);
  const requestedPage = normalizePage(options.page);
  const connection = await openFilmPlaybackConnection();
  try {
    const filter = {
      filmCd: options.filmCd,
      hallId: options.hallId,
      search: options.search,
    };
    const { where, params } = buildRuleListWhere(filter);
    const [countRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM tms_film_playback_rules ${where}`,
      params,
    );
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = total > 0 ? (page - 1) * pageSize : 0;
    const limitClause = `LIMIT ${pageSize} OFFSET ${offset}`;

    const [rows] = await connection.execute<FilmPlaybackRuleRow[]>(
      `
        SELECT *
        FROM tms_film_playback_rules
        ${where}
        ORDER BY updated_at DESC, film_name ASC
        ${limitClause}
      `,
      params,
    );
    const summary = await readFilmPlaybackRuleSummary(connection);
    const filterFilms = await readFilmPlaybackRuleFilterFilms(connection);
    const occupancies = await readFilmPlaybackRuleOccupancies(connection);

    return {
      rules: rows.map(mapRuleRow),
      total,
      page,
      pageSize,
      totalPages,
      summary,
      filterFilms,
      occupancies,
    };
  } finally {
    await connection.end();
  }
}

async function ensureColumn(connection: mysql.Connection, columnName: string, definition: string): Promise<void> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'tms_film_playback_rules'
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [columnName],
  );
  if (rows.length > 0) {
    return;
  }
  await connection.execute(`ALTER TABLE tms_film_playback_rules ADD COLUMN ${columnName} ${definition}`);
}

async function dropColumnIfExists(connection: mysql.Connection, columnName: string): Promise<void> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'tms_film_playback_rules'
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [columnName],
  );
  if (rows.length === 0) {
    return;
  }
  await connection.execute(`ALTER TABLE tms_film_playback_rules DROP COLUMN ${columnName}`);
}

async function readFilmPlaybackRuleById(connection: mysql.Connection, id: string): Promise<FilmPlaybackRule | null> {
  const [rows] = await connection.execute<FilmPlaybackRuleRow[]>(
    "SELECT * FROM tms_film_playback_rules WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0] ? mapRuleRow(rows[0]) : null;
}

export async function readFilmPlaybackRule(id: string): Promise<FilmPlaybackRule | null> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return null;
  }

  const connection = await openFilmPlaybackConnection();
  try {
    return readFilmPlaybackRuleById(connection, normalizedId);
  } finally {
    await connection.end();
  }
}

function buildRuleListWhere(filter: FilmPlaybackRuleListFilter): {
  readonly where: string;
  readonly params: (string | number | null)[];
} {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (filter.filmCd?.trim()) {
    conditions.push("film_cd = ?");
    params.push(filter.filmCd.trim());
  }

  if (filter.hallId?.trim()) {
    conditions.push("JSON_CONTAINS(hall_ids, JSON_QUOTE(?))");
    params.push(filter.hallId.trim());
  }

  if (filter.search?.trim()) {
    const pattern = `%${filter.search.trim()}%`;
    conditions.push(`(
      film_name LIKE ?
      OR film_cd LIKE ?
      OR playlist_name LIKE ?
      OR film_visual LIKE ?
      OR film_language LIKE ?
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

async function readFilmPlaybackRuleSummary(connection: mysql.Connection): Promise<FilmPlaybackRuleSummary> {
  const [countRows] = await connection.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS rule_count, COUNT(DISTINCT film_cd) AS film_count FROM tms_film_playback_rules",
  );
  const [hallRows] = await connection.execute<mysql.RowDataPacket[]>(
    "SELECT hall_ids FROM tms_film_playback_rules",
  );
  const halls = new Set<string>();
  for (const row of hallRows) {
    for (const hallId of parseJsonArray<string>(row.hall_ids)) {
      if (typeof hallId === "string" && hallId.trim()) {
        halls.add(hallId.trim());
      }
    }
  }

  return {
    ruleCount: Number(countRows[0]?.rule_count || 0),
    filmCount: Number(countRows[0]?.film_count || 0),
    hallCount: halls.size,
  };
}

async function readFilmPlaybackRuleFilterFilms(connection: mysql.Connection): Promise<FilmPlaybackRuleFilterFilm[]> {
  const [rows] = await connection.execute<FilmPlaybackRuleRow[]>(`
    SELECT film_cd, film_name, film_visual, film_language, MAX(updated_at) AS updated_at
    FROM tms_film_playback_rules
    GROUP BY film_cd, film_name, film_visual, film_language
    ORDER BY film_name ASC, film_cd ASC
  `);
  return rows.map((row) => ({
    filmCd: row.film_cd,
    filmName: row.film_name,
    filmVisual: row.film_visual ?? undefined,
    filmLanguage: row.film_language ?? undefined,
  }));
}

async function readFilmPlaybackRuleOccupancies(connection: mysql.Connection): Promise<FilmPlaybackRuleOccupancy[]> {
  const [rows] = await connection.execute<FilmPlaybackRuleRow[]>(`
    SELECT id, film_cd, hall_ids
    FROM tms_film_playback_rules
    ORDER BY film_cd ASC, id ASC
  `);
  return rows.map((row) => ({
    id: row.id,
    filmCd: row.film_cd,
    hallIds: parseJsonArray<string>(row.hall_ids).filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  }));
}

function normalizePage(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 1;
}

function normalizePageSize(value: unknown): number {
  const numeric = Number(value);
  return [10, 20, 50].includes(numeric) ? numeric : 10;
}

async function assertNoHallConflict(
  connection: mysql.Connection,
  filmCd: string,
  hallIds: readonly string[],
  ignoreId?: string,
): Promise<void> {
  const [rows] = await connection.execute<FilmPlaybackRuleRow[]>(
    "SELECT * FROM tms_film_playback_rules WHERE film_cd = ?",
    [filmCd],
  );
  const selectedHalls = new Set(hallIds);

  for (const row of rows) {
    const rule = mapRuleRow(row);
    if (ignoreId && rule.id === ignoreId) {
      continue;
    }

    const overlaps = rule.hallIds.filter((hallId) => selectedHalls.has(hallId));
    if (overlaps.length > 0) {
      throw new ApiError(409, `该影片版本在影厅 ${overlaps.join("、")} 已存在放映模板。`);
    }
  }
}

function normalizeRuleInput(input: FilmPlaybackRuleInput): NormalizedFilmPlaybackRuleInput {
  const filmCd = input.filmCd.trim();
  const filmName = input.filmName.trim();
  const filmVisual = input.filmVisual?.trim() || undefined;
  const filmLanguage = input.filmLanguage?.trim() || undefined;
  const hallIds = uniqueNonEmptyStrings(input.hallIds);
  const playlistName = input.playlistName.trim();
  const playlistRefs = normalizePlaylistRefs(input.playlistRefs, hallIds);
  const timePoints = normalizeTimePoints(input.timePoints);
  const headStartSeconds = readTimePointSeconds(timePoints, "head") ?? 0;
  const tailStartSeconds = readTimePointSeconds(timePoints, "tail") ?? 0;

  if (!filmCd) {
    throw new ApiError(400, "请选择影片版本。");
  }
  if (!filmName) {
    throw new ApiError(400, "缺少影片名称。");
  }
  if (hallIds.length === 0) {
    throw new ApiError(400, "请至少选择一个适用影厅。");
  }
  if (!playlistName) {
    throw new ApiError(400, "请选择对应播放表。");
  }
  if (timePoints.filter((point) => point.type === "head").length > 1) {
    throw new ApiError(400, "片头时间点不能重复。");
  }
  if (timePoints.filter((point) => point.type === "tail").length > 1) {
    throw new ApiError(400, "片尾时间点不能重复。");
  }
  if (headStartSeconds > 0 && tailStartSeconds > 0 && tailStartSeconds <= headStartSeconds) {
    throw new ApiError(400, "片尾字幕出现时间必须晚于正片出现时间。");
  }

  return {
    filmCd,
    filmName,
    filmVisual,
    filmLanguage,
    hallIds,
    playlistName,
    playlistRefs,
    timePoints,
    playlistSnapshot: input.playlistSnapshot,
    rawFilm: input.rawFilm,
  };
}

function normalizeTimePoints(value: unknown): FilmPlaybackTimePoint[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): FilmPlaybackTimePoint[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const type = normalizeTimePointType(record.type);
    if (!type) {
      return [];
    }
    const startSeconds = normalizeSeconds(record.startSeconds, "时间点");
    const endSeconds = type === "range" ? normalizeSeconds(record.endSeconds, "时间段结束时间") : undefined;
    if (type === "range" && endSeconds !== undefined && endSeconds <= startSeconds) {
      throw new ApiError(400, "时间段结束时间必须晚于开始时间。");
    }
    return [{
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined,
      type,
      note: normalizeTimePointNote(type, record.note),
      startSeconds,
      endSeconds,
      action: normalizeTimePointAction(record.action, type),
    }];
  });
}

function normalizeTimePointType(value: unknown): FilmPlaybackTimePoint["type"] | undefined {
  return value === "head" || value === "tail" || value === "point" || value === "range" ? value : undefined;
}

function normalizeTimePointNote(type: FilmPlaybackTimePoint["type"], value: unknown): string {
  if (type === "head") return "正片出现时间";
  if (type === "tail") return "片尾字幕出现时间";
  return typeof value === "string" && value.trim() ? value.trim() : "时间点";
}

function normalizeTimePointAction(value: unknown, pointType: FilmPlaybackTimePoint["type"]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "skipRange" && pointType !== "range") {
    throw new ApiError(400, "跳过该时间段操作只能用于时间段。");
  }
  if (pointType === "range" && typeof record.type === "string" && record.type !== "skipRange") {
    return {
      ...record,
      executeAt: record.executeAt === "end" ? "end" : "start",
    };
  }
  if (pointType !== "range") {
    const { executeAt: _executeAt, ...action } = record;
    return action;
  }
  return record;
}

function readTimePointSeconds(
  timePoints: readonly FilmPlaybackTimePoint[],
  type: "head" | "tail",
): number | undefined {
  const point = timePoints.find((item) => item.type === type);
  return point ? point.startSeconds : undefined;
}

function normalizePlaylistRefs(
  refs: readonly FilmPlaybackPlaylistRef[],
  hallIds: readonly string[],
): FilmPlaybackPlaylistRef[] {
  if (!Array.isArray(refs)) {
    throw new ApiError(400, "播放表引用必须是数组。");
  }

  const hallSet = new Set(hallIds);
  const normalized: FilmPlaybackPlaylistRef[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") {
      continue;
    }
    const hallId = ref.hallId.trim();
    const playlistId = ref.playlistId.trim();
    const playlistName = ref.playlistName.trim();
    if (!hallSet.has(hallId) || !playlistId || !playlistName) {
      continue;
    }
    if (!normalized.some((item) => item.hallId === hallId)) {
      normalized.push({ hallId, playlistId, playlistName });
    }
  }

  const missing = hallIds.filter((hallId) => !normalized.some((ref) => ref.hallId === hallId));
  if (missing.length > 0) {
    throw new ApiError(400, `请选择影厅 ${missing.join("、")} 的对应播放表。`);
  }

  return normalized;
}

function normalizeSeconds(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw new ApiError(400, `${label}必须是非负秒数。`);
  }
  return Math.round(numberValue);
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  if (!Array.isArray(values)) {
    throw new ApiError(400, "影厅列表必须是数组。");
  }

  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function mapRuleRow(row: FilmPlaybackRuleRow): FilmPlaybackRule {
  const hallIds = parseJsonArray<string>(row.hall_ids).filter((value): value is string => typeof value === "string");
  const playlistRefs = parseJsonArray<FilmPlaybackPlaylistRef>(row.playlist_refs)
    .filter((value): value is FilmPlaybackPlaylistRef => (
      Boolean(value)
      && typeof value === "object"
      && typeof value.hallId === "string"
      && typeof value.playlistId === "string"
      && typeof value.playlistName === "string"
    ));
  const timePoints = parseJsonArray<FilmPlaybackTimePoint>(row.time_points);

  return {
    id: row.id,
    filmCd: row.film_cd,
    filmName: row.film_name,
    filmVisual: row.film_visual ?? undefined,
    filmLanguage: row.film_language ?? undefined,
    hallIds,
    playlistName: row.playlist_name,
    playlistRefs,
    timePoints: normalizeTimePoints(timePoints),
    playlistSnapshot: parseJsonValue(row.playlist_snapshot),
    rawFilm: parseJsonValue(row.raw_film),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function parseJsonArray<T>(value: unknown): T[] {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed as T[] : [];
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

function normalizeDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
