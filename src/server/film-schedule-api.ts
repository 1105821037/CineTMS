import type { IncomingMessage, ServerResponse } from "node:http";
import { getActivityService } from "./activity-service";
import { ApiError, readJsonBody, sendJson } from "./http";
import { requireSession } from "./session";
import { readConfiguredHalls, readFinixxConfig, type HallConfig } from "./setup-store";
import { getRuntimeService } from "./runtime-service";
import { getFilmSchedulerEngine } from "./film-scheduler-engine";
import { getTicketingFinixxClient } from "./finixx-client-service";
import { requireStoredFinixxConfig } from "./finixx-config";
import type { GdcScheduleSummary } from "../modules/gdc";
import {
  createFilmScheduleEntry,
  deleteFilmScheduleEntry,
  listFilmScheduleEntries,
  updateFilmScheduleEntry,
  type FilmScheduleEntryInput,
} from "./film-schedule-store";
import { listFilmPlaybackRules, type FilmPlaybackRule } from "./film-playback-store";

export interface TicketingScheduleSession {
  readonly id: string;
  readonly showDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly hallId: string;
  readonly hallName: string;
  readonly finixxHallId: string;
  readonly filmCd: string;
  readonly filmName: string;
  readonly filmVisual?: string;
  readonly filmLanguage?: string;
  readonly durationMinutes: number;
  readonly seatsCount?: number;
  readonly soldSeatsCount?: number;
  readonly marketPrice?: number;
  readonly leastPrice?: number;
  readonly freeSeatsCount?: number;
  readonly ticketingSessionId?: string;
  readonly raw: Record<string, unknown>;
}

interface GdcScheduleMarker {
  readonly id: string;
  readonly source: "gdc";
  readonly showDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly durationSeconds: number;
  readonly durationEstimated: boolean;
  readonly hallId: string;
  readonly hallName: string;
  readonly finixxHallId: string;
  readonly filmCd: string;
  readonly filmName: string;
  readonly playlistName: string;
  readonly scheduleUuid: string;
  readonly showContentVersionId?: string;
  readonly raw: GdcScheduleSummary;
}

interface GdcScheduleWarning {
  readonly hallId: string;
  readonly hallName: string;
  readonly message: string;
}

type MutablePartialFilmScheduleEntryInput = {
  -readonly [Key in keyof FilmScheduleEntryInput]?: FilmScheduleEntryInput[Key];
};

export async function handleFilmScheduleApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith("/api/film-schedule")) {
    return false;
  }

  const session = await requireSession(request);

  if (request.method === "GET" && pathname === "/api/film-schedule/ticketing") {
    const showDate = readDateParam(searchParams.get("date"));
    const schedule = await listTicketingSchedule(showDate);
    sendJson(response, 200, { ok: true, ...schedule });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/film-schedule/entries") {
    const showDate = readDateParam(searchParams.get("date"));
    const entries = await listFilmScheduleEntries(showDate);
    sendJson(response, 200, { ok: true, entries });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/film-schedule/gdc") {
    const showDate = readDateParam(searchParams.get("date"));
    const schedule = await listGdcScheduleMarkers(showDate);
    sendJson(response, 200, { ok: true, ...schedule });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/film-schedule/entries") {
    const body = await readJsonBody(request);
    const input = await normalizeEntryBody(body);
    const entry = await getActivityService().capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "film-schedule.entry.create",
      objectType: "film-schedule-entry",
      objectId: input.ticketingSessionId ?? input.filmCd,
      objectName: input.filmName,
      hallId: input.hallId,
      payload: buildActivityPayload(input),
    }, async () => createFilmScheduleEntry(input));
    sendJson(response, 200, { ok: true, entry });
    return true;
  }

  const entryMatch = /^\/api\/film-schedule\/entries\/([^/]+)$/.exec(pathname);
  if (entryMatch && request.method === "POST") {
    const id = decodeURIComponent(entryMatch[1]);
    const body = await readJsonBody(request);
    const input = await normalizePartialEntryBody(body);
    const entry = await getActivityService().capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "film-schedule.entry.update",
      objectType: "film-schedule-entry",
      objectId: id,
      objectName: typeof body.filmName === "string" ? body.filmName : undefined,
      hallId: typeof body.hallId === "string" ? body.hallId : undefined,
      payload: buildActivityPayload(input),
    }, async () => updateFilmScheduleEntry(id, input));
    sendJson(response, 200, { ok: true, entry });
    return true;
  }

  if (entryMatch && request.method === "DELETE") {
    const id = decodeURIComponent(entryMatch[1]);
    const deleted = await getActivityService().capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "film-schedule.entry.delete",
      objectType: "film-schedule-entry",
      objectId: id,
      payload: { id },
    }, async () => {
      await exitScheduleMonitoringBeforeDelete(id);
      return deleteFilmScheduleEntry(id);
    });
    sendJson(response, 200, { ok: true, deleted });
    return true;
  }

  return false;
}

async function exitScheduleMonitoringBeforeDelete(scheduleId: string): Promise<void> {
  try {
    await getFilmSchedulerEngine().exitScheduleMonitoring(scheduleId, {
      reason: "排期已被删除，已退出排程监控，后续自动化动作将不会执行。",
    });
  } catch (error) {
    if (error instanceof ApiError && (error.statusCode === 404 || error.statusCode === 409)) {
      return;
    }
    throw error;
  }
}

async function listGdcScheduleMarkers(showDate: string): Promise<{
  readonly showDate: string;
  readonly schedules: readonly GdcScheduleMarker[];
  readonly warnings: readonly GdcScheduleWarning[];
}> {
  const halls = (await readConfiguredHalls().catch(() => []))
    .filter((hall) => hall.host && hall.port);
  const runtimeService = getRuntimeService();
  const schedules: GdcScheduleMarker[] = [];
  const warnings: GdcScheduleWarning[] = [];

  await Promise.all(halls.map(async (hall) => {
    try {
      const deviceSchedules = await runtimeService.listDeviceSchedules(hall.id);
      schedules.push(
        ...deviceSchedules
          .map((schedule) => normalizeGdcScheduleMarker(schedule, hall, showDate))
          .filter((item): item is GdcScheduleMarker => Boolean(item)),
      );
    } catch (error) {
      warnings.push({
        hallId: hall.id,
        hallName: hall.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  schedules.sort((left, right) => left.startMinutes - right.startMinutes || left.hallName.localeCompare(right.hallName, "zh-Hans-CN"));
  warnings.sort((left, right) => left.hallName.localeCompare(right.hallName, "zh-Hans-CN"));
  return { showDate, schedules, warnings };
}

export async function listTicketingSchedule(showDate: string): Promise<{
  readonly showDate: string;
  readonly halls: readonly { readonly id: string; readonly name: string; readonly finixxHallId: string }[];
  readonly sessions: readonly TicketingScheduleSession[];
  readonly rawShape: Record<string, unknown>;
}> {
  const config = await readFinixxConfig();
  if (!config?.baseUrl) {
    throw new ApiError(400, "请先在系统设置中配置售票系统连接。");
  }

  const [halls, client] = await Promise.all([
    readConfiguredHalls().catch(() => []),
    getTicketingFinixxClient({
      ...requireStoredFinixxConfig(config),
      requestTimeoutMs: 15_000,
    }),
  ]);

  const schedule = await client.getScheduleWithFilms({ showDate });
  const hallMap = buildHallMap(halls);
  const hallSeatMap = buildHallSeatMap(client.getSystemSettings());
  const records = collectSessionRecords(schedule.sessions);
  const sessions = records
    .map((record) => normalizeTicketingSession(record, schedule.filmsByCode, hallMap, hallSeatMap, showDate))
    .filter((item): item is TicketingScheduleSession => Boolean(item))
    .sort((left, right) => left.startMinutes - right.startMinutes || left.hallName.localeCompare(right.hallName, "zh-Hans-CN"));
  const scheduleHalls = [...new Map(sessions.map((item) => [
    item.hallId,
    { id: item.hallId, name: item.hallName, finixxHallId: item.finixxHallId },
  ])).values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));

  return {
    showDate,
    halls: scheduleHalls,
    sessions,
    rawShape: {
      sessionKeys: Object.keys(schedule.sessions || {}),
      filmCount: schedule.filmCds.length,
      sessionCount: sessions.length,
    },
  };
}

function normalizeGdcScheduleMarker(
  schedule: GdcScheduleSummary,
  hall: HallConfig,
  showDate: string,
): GdcScheduleMarker | null {
  const startTime = normalizeGdcScheduleDateTime(schedule.isoDateTime);
  if (!startTime) {
    return null;
  }

  const durationSeconds = normalizeGdcScheduleDurationSeconds(schedule.playlistDuration);
  const endTime = addSeconds(startTime, durationSeconds);
  if (!isLocalRangeOverlappingDate(startTime, endTime, showDate)) {
    return null;
  }

  const showContentVersionId = schedule.showContentVersionId || schedule.showContentVerId;
  const filmCd = showContentVersionId || schedule.scheduleUuid;
  const filmName = showContentVersionId
    ? `GDC内置排期 ${shortUuid(showContentVersionId)}`
    : `GDC内置排期 ${shortUuid(schedule.scheduleUuid)}`;

  return {
    id: `gdc-${hall.id}-${schedule.scheduleUuid}`,
    source: "gdc",
    showDate,
    startTime,
    endTime,
    startMinutes: minutesFromDateTime(startTime, showDate),
    endMinutes: minutesFromDateTime(endTime, showDate),
    durationSeconds,
    durationEstimated: !isFinitePositive(schedule.playlistDuration),
    hallId: hall.id,
    hallName: hall.name,
    finixxHallId: hall.finixxHallId,
    filmCd,
    filmName,
    playlistName: "GDC内置排期器",
    scheduleUuid: schedule.scheduleUuid,
    showContentVersionId,
    raw: schedule,
  };
}

async function normalizeEntryBody(body: Record<string, unknown>): Promise<FilmScheduleEntryInput> {
  const input = normalizeEntryFields(body);
  const rule = await resolveRuleForSchedule(input.ruleId, input.filmCd, input.hallId);
  return {
    ...input,
    endTime: input.endTime ?? estimateScheduleEndTime(input.startTime, rule),
    ruleSnapshot: rule,
    filmName: input.filmName || rule.filmName,
    filmVisual: input.filmVisual || rule.filmVisual,
    filmLanguage: input.filmLanguage || rule.filmLanguage,
  };
}

async function normalizePartialEntryBody(body: Record<string, unknown>): Promise<Partial<FilmScheduleEntryInput>> {
  const result: MutablePartialFilmScheduleEntryInput = {};
  if ("showDate" in body) result.showDate = readDateParam(readOptionalString(body.showDate));
  if ("startTime" in body) result.startTime = readLocalDateTime(body.startTime, "开始时间");
  if ("endTime" in body) result.endTime = readOptionalString(body.endTime) ? readLocalDateTime(body.endTime, "结束时间") : undefined;
  if ("hallId" in body) result.hallId = readNonEmptyString(body.hallId, "缺少影厅。");
  if ("hallName" in body) result.hallName = readNonEmptyString(body.hallName, "缺少影厅名称。");
  if ("finixxHallId" in body) result.finixxHallId = readOptionalString(body.finixxHallId);
  if ("filmCd" in body) result.filmCd = readNonEmptyString(body.filmCd, "缺少影片版本。");
  if ("filmName" in body) result.filmName = readNonEmptyString(body.filmName, "缺少影片名称。");
  if ("filmVisual" in body) result.filmVisual = readOptionalString(body.filmVisual);
  if ("filmLanguage" in body) result.filmLanguage = readOptionalString(body.filmLanguage);
  if ("ruleId" in body) result.ruleId = readNonEmptyString(body.ruleId, "缺少影片放映模板。");
  if ("source" in body) result.source = body.source === "custom" ? "custom" : "ticketing";
  if ("ticketingSessionId" in body) result.ticketingSessionId = readOptionalString(body.ticketingSessionId);
  if ("ticketingRaw" in body) result.ticketingRaw = body.ticketingRaw;
  if ("notes" in body) result.notes = readOptionalString(body.notes);

  if (result.ruleId && result.filmCd && result.hallId) {
    result.ruleSnapshot = await resolveRuleForSchedule(result.ruleId, result.filmCd, result.hallId);
  }

  return result;
}

function normalizeEntryFields(body: Record<string, unknown>): FilmScheduleEntryInput {
  return {
    showDate: readDateParam(readOptionalString(body.showDate)),
    startTime: readLocalDateTime(body.startTime, "开始时间"),
    endTime: readOptionalString(body.endTime) ? readLocalDateTime(body.endTime, "结束时间") : undefined,
    hallId: readNonEmptyString(body.hallId, "缺少影厅。"),
    hallName: readNonEmptyString(body.hallName, "缺少影厅名称。"),
    finixxHallId: readOptionalString(body.finixxHallId),
    filmCd: readNonEmptyString(body.filmCd, "缺少影片版本。"),
    filmName: readNonEmptyString(body.filmName, "缺少影片名称。"),
    filmVisual: readOptionalString(body.filmVisual),
    filmLanguage: readOptionalString(body.filmLanguage),
    ruleId: readNonEmptyString(body.ruleId, "缺少影片放映模板。"),
    ruleSnapshot: body.ruleSnapshot,
    source: body.source === "custom" ? "custom" : "ticketing",
    ticketingSessionId: readOptionalString(body.ticketingSessionId),
    ticketingRaw: body.ticketingRaw,
    notes: readOptionalString(body.notes),
  };
}

async function resolveRuleForSchedule(ruleId: string, filmCd: string, hallId: string): Promise<FilmPlaybackRule> {
  const rules = await listFilmPlaybackRules({ filmCd, hallId });
  const rule = rules.find((item) => item.id === ruleId)
    || (await listFilmPlaybackRules()).find((item) => item.id === ruleId);
  if (!rule) {
    throw new ApiError(409, "未找到所选影片放映模板，请先在影片放映模板页添加。");
  }
  return rule;
}

function normalizeTicketingSession(
  record: Record<string, unknown>,
  filmsByCode: Readonly<Record<string, { readonly raw: Record<string, unknown> }>>,
  hallMap: Map<string, HallConfig>,
  hallSeatMap: Map<string, number>,
  fallbackShowDate: string,
): TicketingScheduleSession | null {
  const filmCd = readFirstString(record, ["filmCd"]);
  const finixxHallId = readFirstString(record, ["cinemaCd", "hallCd", "hallId", "screenCd"]);
  const showDate = readFirstString(record, ["showDate"]) || fallbackShowDate;
  const showTimeInt = readFirstNumber(record, ["showTimeInt", "showTime", "startTimeInt"]);

  if (!filmCd || !finixxHallId || !Number.isFinite(showTimeInt)) {
    return null;
  }

  const startMinutes = parseShowTimeInt(showTimeInt);
  if (!Number.isFinite(startMinutes)) {
    return null;
  }

  const film = filmsByCode[filmCd]?.raw ?? {};
  const durationMinutes = Math.max(1, Math.round(readFirstNumber(film, ["filmDuration", "duration", "runningTime"]) || 120));
  const hall = hallMap.get(finixxHallId);
  const startTime = toLocalDateTime(showDate, startMinutes);
  const endTime = toLocalDateTime(showDate, startMinutes + durationMinutes);
  const filmName = readFirstString(film, [
    "filmLongTitle",
    "filmShortTitle",
    "filmName",
    "filmTitle",
    "movieName",
  ]) || filmCd;
  const filmVisual = readFirstString(film, ["dimensional", "filmVisual", "version", "filmVersion"]);
  const filmLanguage = readFirstString(film, ["languageName", "filmLanguage", "language"]);
  const seatsCount = hallSeatMap.get(finixxHallId);
  const freeSeatsCount = readOptionalNumber(record.freeSeatsCount);
  const soldSeatsCount = seatsCount !== undefined && freeSeatsCount !== undefined
    ? Math.max(0, seatsCount - freeSeatsCount)
    : undefined;

  return {
    id: readFirstString(record, ["refSeqNo", "sessionCode"]) || `${finixxHallId}-${filmCd}-${startMinutes}`,
    showDate,
    startTime,
    endTime,
    startMinutes,
    endMinutes: startMinutes + durationMinutes,
    hallId: hall?.id ?? finixxHallId,
    hallName: hall?.name ?? `售票影厅 ${shortHallId(finixxHallId)}`,
    finixxHallId,
    filmCd,
    filmName,
    filmVisual,
    filmLanguage,
    durationMinutes,
    seatsCount,
    soldSeatsCount,
    marketPrice: readOptionalNumber(record.marketPrice),
    leastPrice: readOptionalNumber(record.leastPrice),
    freeSeatsCount,
    ticketingSessionId: readFirstString(record, ["sessionCode", "refSeqNo"]),
    raw: record,
  };
}

function collectSessionRecords(value: unknown): Record<string, unknown>[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const direct = (value as Record<string, unknown>).sessions;
    if (Array.isArray(direct)) {
      return direct.filter((item): item is Record<string, unknown> => (
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
      ));
    }
  }

  const records: Record<string, unknown>[] = [];
  const visited = new Set<object>();
  const walk = (current: unknown): void => {
    if (!current || typeof current !== "object" || visited.has(current)) return;
    visited.add(current);
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    const record = current as Record<string, unknown>;
    if (readFirstString(record, ["filmCd"]) && Number.isFinite(readFirstNumber(record, ["showTimeInt"]))) {
      records.push(record);
    }
    Object.values(record).forEach(walk);
  };
  walk(value);
  return records;
}

function buildHallMap(halls: readonly HallConfig[]): Map<string, HallConfig> {
  const map = new Map<string, HallConfig>();
  for (const hall of halls) {
    map.set(hall.finixxHallId, hall);
    map.set(hall.id, hall);
  }
  return map;
}

function buildHallSeatMap(settings: unknown): Map<string, number> {
  const map = new Map<string, number>();
  const settingsRecord = asRecord(settings);
  const hallsInfo = asRecord(settingsRecord?.hallsInfo);
  const halls = Array.isArray(hallsInfo?.halls) ? hallsInfo.halls : [];
  for (const item of halls) {
    const hall = asRecord(item);
    const cinemaCd = typeof hall?.cinemaCd === "string" ? hall.cinemaCd : undefined;
    const seatsCount = readOptionalNumber(hall?.seatsCount);
    if (cinemaCd && seatsCount !== undefined) {
      map.set(cinemaCd, seatsCount);
    }
  }
  return map;
}

function buildActivityPayload(input: Partial<FilmScheduleEntryInput>): Record<string, unknown> {
  return {
    showDate: input.showDate,
    startTime: input.startTime,
    endTime: input.endTime,
    hallId: input.hallId,
    filmCd: input.filmCd,
    filmName: input.filmName,
    ruleId: input.ruleId,
    source: input.source,
    ticketingSessionId: input.ticketingSessionId,
  };
}

function readDateParam(value: string | null | undefined): string {
  const raw = value || new Date().toISOString().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) {
    throw new ApiError(400, "日期格式不正确。");
  }
  return raw;
}

function readLocalDateTime(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, `${label}格式不正确。`);
  }
  const normalized = normalizeLocalDateTime(value);
  if (!normalized) {
    throw new ApiError(400, `${label}格式不正确。`);
  }
  return normalized;
}

function readNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, message);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFirstString(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const normalizedKeys = new Set(keys.map(normalizeKey));
  for (const [key, raw] of Object.entries(value)) {
    if (normalizedKeys.has(normalizeKey(key)) && typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return undefined;
}

function readFirstNumber(value: unknown, keys: readonly string[]): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Number.NaN;
  }
  const normalizedKeys = new Set(keys.map(normalizeKey));
  for (const [key, raw] of Object.entries(value)) {
    if (!normalizedKeys.has(normalizeKey(key))) {
      continue;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function readOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function estimateScheduleEndTime(startTime: string, rule: FilmPlaybackRule): string {
  const durationSeconds = getEstimatedScheduleDurationSeconds(rule);
  const date = new Date(startTime);
  date.setSeconds(date.getSeconds() + durationSeconds);
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

function getEstimatedScheduleDurationSeconds(rule: FilmPlaybackRule): number {
  const playlistSeconds = getPlaylistSnapshotDurationSeconds(rule.playlistSnapshot);
  if (playlistSeconds > 0) {
    return Math.max(1, Math.round(playlistSeconds));
  }

  const filmDuration = readNestedNumber(rule.rawFilm, ["filmDuration", "duration", "runningTime"]);
  if (filmDuration > 0) {
    return Math.max(1, Math.round(filmDuration * 60));
  }

  return 120 * 60;
}

function getPlaylistSnapshotDurationSeconds(snapshot: unknown): number {
  const record = asRecord(snapshot);
  const details = Array.isArray(record?.details) ? record.details : [];
  const detail = asRecord(details[0]);
  const segmentDetails = Array.isArray(detail?.segmentDetails) ? detail.segmentDetails : [];
  const duration = segmentDetails.reduce((sum, item) => {
    const seconds = Number(asRecord(item)?.durationSeconds);
    return Number.isFinite(seconds) && seconds > 0 ? sum + seconds : sum;
  }, 0);
  if (duration > 0) {
    return duration;
  }

  const segments = Array.isArray(detail?.segments) ? detail.segments : [];
  return segments.reduce((sum, item) => {
    const seconds = readNestedNumber(item, ["durationSeconds"]);
    return seconds > 0 ? sum + seconds : sum;
  }, 0);
}

function readNestedNumber(value: unknown, keys: readonly string[]): number {
  const normalizedKeys = new Set(keys.map(normalizeKey));
  const stack: unknown[] = [value];
  const visited = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, raw] of Object.entries(current)) {
      if (normalizedKeys.has(normalizeKey(key))) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) return parsed;
      }
      if (raw && typeof raw === "object") {
        stack.push(raw);
      }
    }
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseShowTimeInt(value: number): number {
  const raw = Math.trunc(value);
  const hour = Math.floor(raw / 100);
  const minute = raw % 100;
  if (hour < 0 || hour > 47 || minute < 0 || minute > 59) {
    return Number.NaN;
  }
  return hour * 60 + minute;
}

function toLocalDateTime(showDate: string, minutes: number): string {
  const [year, month, day] = showDate.split("-").map(Number);
  const date = new Date(year, month - 1, day, 0, minutes, 0, 0);
  return formatLocalDateTime(date);
}

function normalizeGdcScheduleDateTime(value: string | undefined): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }

  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : formatLocalDateTime(date);
  }

  return normalizeLocalDateTime(raw);
}

function normalizeGdcScheduleDurationSeconds(value: number | undefined): number {
  return isFinitePositive(value) ? Math.max(1, Math.round(Number(value))) : 120 * 60;
}

function isLocalRangeOverlappingDate(startTime: string, endTime: string, showDate: string): boolean {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const dayStart = new Date(`${showDate}T00:00:00`).getTime();
  const dayEnd = new Date(`${showDate}T00:00:00`).getTime() + 24 * 60 * 60 * 1000;
  return Number.isFinite(start) && Number.isFinite(end) && start < dayEnd && end > dayStart;
}

function minutesFromDateTime(value: string, showDate: string): number {
  return (new Date(value).getTime() - new Date(`${showDate}T00:00:00`).getTime()) / 60000;
}

function addSeconds(value: string, seconds: number): string {
  const date = new Date(value);
  date.setSeconds(date.getSeconds() + seconds);
  return formatLocalDateTime(date);
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

function normalizeLocalDateTime(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) {
    return null;
  }
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return normalized;
}

function isFinitePositive(value: unknown): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function shortUuid(value: string | undefined): string {
  return String(value || "").replace(/^urn:uuid:/i, "").slice(0, 8) || "未知";
}

function shortHallId(value: string): string {
  return value.replace(/^0+/, "") || value;
}
