import type { IncomingMessage, ServerResponse } from "node:http";
import { getActivityService } from "./activity-service";
import { ApiError, readJsonBody, sendJson } from "./http";
import { requireSession } from "./session";
import { readFinixxConfig } from "./setup-store";
import { getTicketingFinixxClient } from "./finixx-client-service";
import { requireStoredFinixxConfig } from "./finixx-config";
import { getRuntimeService } from "./runtime-service";
import {
  createFilmPlaybackRule,
  deleteFilmPlaybackRule,
  listFilmPlaybackRulePage,
  readFilmPlaybackRule,
  resolveFilmPlaybackRules,
  updateFilmPlaybackRule,
  type FilmPlaybackRule,
  type FilmPlaybackPlaylistRef,
  type FilmPlaybackRuleInput,
} from "./film-playback-store";

interface FilmPlaybackFilmOption {
  readonly filmCd: string;
  readonly filmName: string;
  readonly visual?: string;
  readonly language?: string;
  readonly label: string;
  readonly sessionCount: number;
  readonly showDates: readonly string[];
  readonly rawFilm: unknown;
}

export async function handleFilmPlaybackApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith("/api/film-playback")) {
    return false;
  }

  const session = await requireSession(request);

  if (request.method === "GET" && pathname === "/api/film-playback/rules") {
    const page = await listFilmPlaybackRulePage({
      filmCd: searchParams.get("filmCd") || undefined,
      hallId: searchParams.get("hallId") || undefined,
      search: searchParams.get("search") || undefined,
      page: readOptionalPositiveInteger(searchParams.get("page")),
      pageSize: readOptionalPositiveInteger(searchParams.get("pageSize")),
    });
    sendJson(response, 200, {
      ok: true,
      rules: page.rules,
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        total: page.total,
        totalPages: page.totalPages,
      },
      summary: page.summary,
      filterFilms: page.filterFilms,
      occupancies: page.occupancies,
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/film-playback/films") {
    const films = await listRecentFinixxFilms();
    sendJson(response, 200, {
      ok: true,
      range: { fromOffsetDays: -1, toOffsetDays: 3 },
      films,
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/film-playback/rules/resolve") {
    const body = await readJsonBody(request);
    const rules = await resolveFilmPlaybackRules({
      filmCds: readOptionalStringArray(body.filmCds),
      ruleIds: readOptionalStringArray(body.ruleIds),
    });
    sendJson(response, 200, { ok: true, rules });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/film-playback/rules") {
    const body = await readJsonBody(request);
    const input = normalizeRuleBody(body);
    await validatePlaylistSnapshotForSave(input);
    const rule = await getActivityService().capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "film-playback.rule.create",
      objectType: "film-playback-rule",
      objectId: input.filmCd,
      objectName: input.filmName,
      payload: buildActivityPayload(input),
    }, async () => createFilmPlaybackRule(input));
    sendJson(response, 200, { ok: true, rule });
    return true;
  }

  const ruleMatch = /^\/api\/film-playback\/rules\/([^/]+)$/.exec(pathname);
  if (ruleMatch && request.method === "POST") {
    const id = decodeURIComponent(ruleMatch[1]);
    const body = await readJsonBody(request);
    const input = normalizeRuleBody(body);
    const existing = await readFilmPlaybackRule(id);
    if (!existing) {
      throw new ApiError(404, "未找到指定的放映模板。");
    }
    await validatePlaylistSnapshotForSave(input, existing);
    const rule = await getActivityService().capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "film-playback.rule.update",
      objectType: "film-playback-rule",
      objectId: id,
      objectName: input.filmName,
      payload: buildActivityPayload(input),
    }, async () => updateFilmPlaybackRule(id, input));
    sendJson(response, 200, { ok: true, rule });
    return true;
  }

  if (ruleMatch && request.method === "DELETE") {
    const id = decodeURIComponent(ruleMatch[1]);
    const deleted = await getActivityService().capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "film-playback.rule.delete",
      objectType: "film-playback-rule",
      objectId: id,
      payload: { id },
    }, async () => deleteFilmPlaybackRule(id));
    sendJson(response, 200, { ok: true, deleted });
    return true;
  }

  return false;
}

async function listRecentFinixxFilms(): Promise<FilmPlaybackFilmOption[]> {
  const config = await readFinixxConfig();
  if (!config?.baseUrl) {
    throw new ApiError(400, "请先在系统设置中配置售票系统连接。");
  }

  const client = await getTicketingFinixxClient({
    ...requireStoredFinixxConfig(config),
    requestTimeoutMs: 15_000,
  });

  const aggregate = new Map<string, {
    filmCd: string;
    rawFilm: unknown;
    sessionCount: number;
    showDates: Set<string>;
  }>();

  for (let offset = -1; offset <= 3; offset += 1) {
    const showDate = formatOffsetDate(offset);
    const schedule = await client.getScheduleWithFilms({ showDate });
    for (const filmCd of schedule.filmCds) {
      const existing = aggregate.get(filmCd) ?? {
        filmCd,
        rawFilm: schedule.filmsByCode[filmCd]?.raw ?? {},
        sessionCount: 0,
        showDates: new Set<string>(),
      };
      existing.rawFilm = mergeFilmRecord(existing.rawFilm, schedule.filmsByCode[filmCd]?.raw ?? {});
      for (const sessionFilm of collectFilmSessionRecords(schedule.sessions, filmCd)) {
        existing.rawFilm = mergeFilmRecord(existing.rawFilm, sessionFilm);
      }
      existing.sessionCount += countFilmSessions(schedule.sessions, filmCd);
      existing.showDates.add(showDate);
      aggregate.set(filmCd, existing);
    }
  }

  return [...aggregate.values()]
    .map((item) => normalizeFilmOption(item.filmCd, item.rawFilm, item.sessionCount, [...item.showDates].sort()))
    .sort((left, right) => left.filmName.localeCompare(right.filmName, "zh-Hans-CN") || left.filmCd.localeCompare(right.filmCd));
}

function normalizeRuleBody(body: Record<string, unknown>): FilmPlaybackRuleInput {
  return {
    filmCd: readNonEmptyString(body.filmCd, "请选择影片版本。"),
    filmName: readNonEmptyString(body.filmName, "缺少影片名称。"),
    filmVisual: readOptionalString(body.filmVisual),
    filmLanguage: readOptionalString(body.filmLanguage),
    hallIds: readStringArray(body.hallIds, "请选择适用影厅。"),
    playlistName: readNonEmptyString(body.playlistName, "请选择对应播放表。"),
    playlistRefs: readPlaylistRefs(body.playlistRefs),
    timePoints: readTimePoints(body.timePoints),
    playlistSnapshot: body.playlistSnapshot,
    rawFilm: body.rawFilm,
  };
}

function readPlaylistRefs(value: unknown): FilmPlaybackPlaylistRef[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, "请选择对应播放表。");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError(400, "播放表数据格式错误。");
    }
    const record = item as Record<string, unknown>;
    return {
      hallId: readNonEmptyString(record.hallId, "播放表缺少影厅。"),
      playlistId: readNonEmptyString(record.playlistId, "播放表缺少 ID。"),
      playlistName: readNonEmptyString(record.playlistName, "播放表缺少名称。"),
    };
  });
}

function readStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, message);
  }
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  if (values.length === 0) {
    throw new ApiError(400, message);
  }
  return [...new Set(values)];
}

function readOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim()))];
}

function readTimePoints(value: unknown): FilmPlaybackRuleInput["timePoints"] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ApiError(400, "时间点信息必须是数组。");
  }
  return value as FilmPlaybackRuleInput["timePoints"];
}

function readNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, message);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalPositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function buildActivityPayload(input: FilmPlaybackRuleInput): Record<string, unknown> {
  return {
    filmCd: input.filmCd,
    filmName: input.filmName,
    hallIds: input.hallIds,
    playlistName: input.playlistName,
    playlistRefs: input.playlistRefs.map((ref) => ({
      hallId: ref.hallId,
      playlistId: ref.playlistId,
      playlistName: ref.playlistName,
    })),
    timePoints: input.timePoints,
    playlistSnapshot: input.playlistSnapshot,
  };
}

async function validatePlaylistSnapshotForSave(
  input: FilmPlaybackRuleInput,
  existing?: FilmPlaybackRule,
): Promise<void> {
  const snapshot = asRecordOrNull(input.playlistSnapshot);
  const details = Array.isArray(snapshot?.details) ? snapshot.details.map(asRecordOrNull).filter(isRecord) : [];
  if (!snapshot || details.length === 0) {
    throw new ApiError(400, "播放表快照不能为空。");
  }

  const runtimeService = getRuntimeService();
  const signatures: Array<{ hallId: string; signature: unknown }> = [];

  for (const ref of input.playlistRefs) {
    const submittedDetail = details.find((detail) => detail.hallId === ref.hallId && detail.showUuid === ref.playlistId)
      || details.find((detail) => detail.hallId === ref.hallId);
    if (!submittedDetail) {
      throw new ApiError(400, `播放表快照缺少影厅 ${ref.hallId} 的详情。`);
    }

    const existingRef = existing?.playlistRefs.find((item) => (
      item.hallId === ref.hallId && sameUuid(item.playlistId, ref.playlistId)
    ));
    const existingDetail = existing && existingRef
      ? findSnapshotDetail(existing.playlistSnapshot, existingRef)
      : undefined;

    const runtime = runtimeService.getRuntimeRecord(ref.hallId);
    const online = runtime?.snapshot.connectivity.state === "online";
    if (online) {
      const liveDetail = await runtimeService.getShowForEditor(ref.hallId, ref.playlistId).catch(() => undefined);
      if (!liveDetail) {
        if (!existingDetail) {
          throw new ApiError(400, `无法读取影厅 ${ref.hallId} 的播放表，且没有可用旧快照。`);
        }
        if (!samePlaylistSignature(existingDetail, submittedDetail)) {
          throw new ApiError(400, `${runtime?.registration.hallName || ref.hallId} 当前无法读取播放表，只能沿用上次保存的快照。`);
        }
      } else {
        if (existingDetail && !samePlaylistSignature(liveDetail, existingDetail)) {
          throw new ApiError(
            409,
            `${runtime?.registration.hallName || ref.hallId} 播放表与上次保存快照不一致，请同步该影厅播放表或从模板中移除该影厅。`,
          );
        }
        if (!samePlaylistSignature(liveDetail, submittedDetail)) {
          throw new ApiError(400, `${runtime?.registration.hallName || ref.hallId} 提交的播放表快照与当前 GDC 不一致，请刷新后重试。`);
        }
      }
    } else if (!existingDetail) {
      throw new ApiError(400, `影厅 ${ref.hallId} 当前离线，不能绑定新的播放表。`);
    } else if (!samePlaylistSignature(existingDetail, submittedDetail)) {
      throw new ApiError(400, `影厅 ${ref.hallId} 当前离线，只能沿用上次保存的快照。`);
    }

    signatures.push({
      hallId: ref.hallId,
      signature: buildPlaylistSignature(submittedDetail),
    });
  }

  const base = signatures[0]?.signature;
  const mismatch = signatures.find((item) => JSON.stringify(item.signature) !== JSON.stringify(base));
  if (mismatch) {
    throw new ApiError(400, `影厅 ${mismatch.hallId} 的播放表内容与其它影厅不一致。`);
  }
}

function findSnapshotDetail(snapshot: unknown, ref: FilmPlaybackPlaylistRef): Record<string, unknown> | undefined {
  const snapshotRecord = asRecordOrNull(snapshot);
  const details = Array.isArray(snapshotRecord?.details) ? snapshotRecord.details.map(asRecordOrNull).filter(isRecord) : [];
  return details.find((detail) => detail.hallId === ref.hallId && sameUuid(String(detail.showUuid || ""), ref.playlistId))
    || details.find((detail) => detail.hallId === ref.hallId);
}

function samePlaylistSignature(left: unknown, right: unknown): boolean {
  return JSON.stringify(buildPlaylistSignature(left)) === JSON.stringify(buildPlaylistSignature(right));
}

function buildPlaylistSignature(detail: unknown): unknown {
  const record = asRecordOrNull(detail);
  const segments = Array.isArray(record?.segments) ? record.segments.map(asRecordOrNull).filter(isRecord) : [];
  const segmentDetails = Array.isArray(record?.segmentDetails)
    ? record.segmentDetails.map(asRecordOrNull).filter(isRecord)
    : [];
  return {
    cplUuids: segments.map((segment) => normalizeUuid(String(segment.cplUuid || ""))),
    commands: segments.map((segment, segmentIndex) => {
      const commands = Array.isArray(segment.commands) ? segment.commands.map(asRecordOrNull).filter(isRecord) : [];
      return commands.map((command) => ({
        label: String(command.label || ""),
        annotationText: String(command.annotationText || command.label || ""),
        offsetFrames: getCommandOffsetFramesForCompare(command, segmentDetails[segmentIndex]),
        editRate: String(command.editRate || ""),
      }));
    }),
  };
}

function getCommandOffsetFramesForCompare(command: Record<string, unknown>, cpl: Record<string, unknown> | undefined): number {
  const rawOffset = Number(command.offsetFrames);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.round(rawOffset)) : 0;
  const durationFrames = Number(cpl?.durationFrames);
  if (!Number.isFinite(durationFrames) || durationFrames <= 0) {
    return offset;
  }
  return Math.min(offset, Math.max(0, Math.round(durationFrames) - 1));
}

function sameUuid(left: string, right: string): boolean {
  return normalizeUuid(left) === normalizeUuid(right);
}

function normalizeUuid(value: string): string {
  return String(value || "").trim().replace(/^urn:uuid:/i, "").toLowerCase();
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null;
}

function normalizeFilmOption(
  filmCd: string,
  rawFilm: unknown,
  sessionCount: number,
  showDates: readonly string[],
): FilmPlaybackFilmOption {
  const filmName = readFirstString(rawFilm, [
    "filmName",
    "filmNm",
    "filmCname",
    "filmCnName",
    "filmNameCn",
    "filmChineseName",
    "filmFullName",
    "filmDisplayName",
    "filmLongTitle",
    "filmShortTitle",
    "filmEnglishTitle",
    "filmTitle",
    "filmDesc",
    "movieNm",
    "title",
    "movieName",
    "movieTitle",
    "showFilmName",
  ]) || filmCd;
  const rawVisual = readFirstString(rawFilm, [
    "filmVisual",
    "visual",
    "dimensional",
    "viewType",
    "viewMode",
    "version",
    "versionName",
    "filmVersion",
    "filmVersionName",
    "filmType",
    "dimension",
    "dimensionType",
    "movieVersion",
    "movieVersionName",
  ]);
  const rawLanguage = readFirstString(rawFilm, [
    "filmLanguage",
    "filmLanguageName",
    "language",
    "languageName",
    "lang",
    "dialogue",
    "dialogueLanguage",
    "filmLang",
    "movieLanguage",
    "movieLanguageName",
    "versionLanguage",
  ]);
  const visual = normalizeVisual(rawVisual) || inferVisual(`${filmName} ${JSON.stringify(rawFilm)}`);
  const language = rawLanguage || inferLanguage(`${filmName} ${JSON.stringify(rawFilm)}`);
  const labelParts = [filmName, visual, language].filter(Boolean);

  return {
    filmCd,
    filmName,
    visual,
    language,
    label: labelParts.join(" · "),
    sessionCount,
    showDates,
    rawFilm,
  };
}

function readFirstString(value: unknown, keys: readonly string[]): string | undefined {
  const stack = [value];
  const normalizedKeys = new Set(keys.map(normalizeRecordKey));

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, raw] of Object.entries(current)) {
      if (normalizedKeys.has(normalizeRecordKey(key)) && typeof raw === "string" && raw.trim()) {
        return raw.trim();
      }
      if (raw && typeof raw === "object") {
        stack.push(raw);
      }
    }
  }
  return undefined;
}

function countFilmSessions(value: unknown, filmCd: string): number {
  let count = 0;
  walk(value, (record) => {
    for (const [key, raw] of Object.entries(record)) {
      if (normalizeRecordKey(key) === "filmcd" && raw === filmCd) {
        count += 1;
        return;
      }
    }
  });
  return count;
}

function collectFilmSessionRecords(value: unknown, filmCd: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  walk(value, (record) => {
    for (const [key, raw] of Object.entries(record)) {
      if (normalizeRecordKey(key) === "filmcd" && raw === filmCd) {
        records.push(record);
        return;
      }
    }
  });
  return records;
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const item of Object.values(record)) {
    walk(item, visit);
  }
}

function mergeFilmRecord(left: unknown, right: unknown): unknown {
  if (!left || typeof left !== "object" || Array.isArray(left)) {
    return right;
  }
  if (!right || typeof right !== "object" || Array.isArray(right)) {
    return left;
  }
  return { ...left as Record<string, unknown>, ...right as Record<string, unknown> };
}

function inferVisual(text: string): string | undefined {
  const upper = text.toUpperCase();
  if (upper.includes("IMAX")) return "IMAX";
  if (upper.includes("3D")) return "3D";
  if (upper.includes("2D")) return "2D";
  return undefined;
}

function normalizeVisual(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const upper = value.toUpperCase();
  if (upper.includes("3D")) return "3D";
  if (upper.includes("2D")) return "2D";
  if (upper.includes("IMAX")) return "IMAX";
  return value;
}

function inferLanguage(text: string): string | undefined {
  const upper = text.toUpperCase();
  if (/粤|CANTONESE|YUE/.test(upper)) return "粤语";
  if (/英|ENGLISH|\bEN\b/.test(upper)) return "英语";
  if (/中|国语|普通话|MANDARIN|CHINESE|\bCN\b/.test(upper)) return "中文";
  return undefined;
}

function formatOffsetDate(offsetDays: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeRecordKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
