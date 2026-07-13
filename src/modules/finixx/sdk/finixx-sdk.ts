import { hostname } from "node:os";
import { FinixxHttpClient } from "../http/finixx-http-client";
import { createFinixxSerialNumber } from "../protocol/serial-number";
import { signFinixxParams } from "../protocol/signature";
import { FINIXX_RESULT_MESSAGE_MAP } from "./result-message-map";
import type {
  FinixxAllSystemSettingRequest,
  FinixxAllSystemSettingResponse,
  FinixxApiResponse,
  FinixxInitializationContext,
  FinixxPayloadValue,
  FinixxResolvedFilmInfo,
  FinixxScheduleWithFilmsRequest,
  FinixxScheduleWithFilmsResponse,
  FinixxSdkConfig,
  FinixxSessionFilmRequest,
  FinixxSessionFilmResponse,
  FinixxSessionNoMoreExtraRequest,
  FinixxSessionNoMoreExtraResponse,
} from "./types";

type FinixxRequestPayload = Record<string, FinixxPayloadValue | null | undefined>;
type FinixxCacheEntry<T> = {
  readonly expiresAt: number;
  readonly value: Promise<T>;
};

const ALL_SYSTEM_SETTING_CODE = "0426";
const SESSION_NO_MORE_EXTRA_CODE = "1056";
const SESSION_FILM_CODE = "1005";
const FINIXX_SERVICE_VERSION = "1.0.0.1";
const FINIXX_SERVICE_CHANNEL_CD = "BO";
const FINIXX_SERVICE_VIRTUAL_HOST = "Finixx105";
const HISTORICAL_SESSION_NO_MORE_EXTRA_TTL_MS = 12 * 60 * 60 * 1000;
const CURRENT_SESSION_NO_MORE_EXTRA_TTL_MS = 60 * 1000;
const FUTURE_SESSION_NO_MORE_EXTRA_TTL_MS = 5 * 60 * 1000;
const SESSION_FILMS_TTL_MS = 12 * 60 * 60 * 1000;

export class FinixxSdk {
  private readonly httpClient: FinixxHttpClient;
  private readonly sessionNoMoreExtraCache = new Map<string, FinixxCacheEntry<FinixxSessionNoMoreExtraResponse>>();
  private readonly sessionFilmsCache = new Map<string, FinixxCacheEntry<FinixxSessionFilmResponse>>();
  private initializationContext?: FinixxInitializationContext;

  constructor(private readonly config: FinixxSdkConfig) {
    this.httpClient = new FinixxHttpClient({
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      resultMessageMap: config.resultMessageMap ?? FINIXX_RESULT_MESSAGE_MAP,
    });
  }

  getInitializationContext(): FinixxInitializationContext | undefined {
    return this.initializationContext;
  }

  getResolvedLocationCd(): string | undefined {
    return this.initializationContext?.resolvedLocationCd;
  }

  getSystemSettings(): FinixxAllSystemSettingResponse {
    return this.getRequiredInitializationContext().response;
  }

  async initialize(): Promise<FinixxAllSystemSettingResponse> {
    if (this.initializationContext) {
      return this.initializationContext.response;
    }

    return this.refreshSystemSettings();
  }

  async refreshSystemSettings(
    request: FinixxAllSystemSettingRequest = {},
  ): Promise<FinixxAllSystemSettingResponse> {
    const response = await this.post<FinixxAllSystemSettingResponse>(
      "/api/basic/allsystemsetting",
      {
        code: ALL_SYSTEM_SETTING_CODE,
        locationcd: "1234",
        channelCd: request.channelCd ?? FINIXX_SERVICE_CHANNEL_CD,
        workStationId: request.workStationId ?? this.config.defaultWorkStationId ?? hostname(),
        boxOfficeSettingFlg: request.boxOfficeSettingFlg ?? true,
        posSettingFlg: request.posSettingFlg ?? false,
        cardSettingFlg: request.cardSettingFlg ?? false,
        posBigClassReturnPic: request.posBigClassReturnPic ?? false,
        virtualHost: request.virtualHost ?? FINIXX_SERVICE_VIRTUAL_HOST,
      },
    );

    this.initializationContext = {
      initializedAt: new Date(),
      response,
      resolvedLocationCd: response.workStationInfo?.LocationCd
        ?? response.allLocationInfo?.locationList?.find((item) => item.localFlag)?.id
        ?? "1234",
      workStationId: response.workStationInfo?.WorkstationId
        ?? request.workStationId
        ?? this.config.defaultWorkStationId
        ?? hostname(),
      virtualHost: response.mqConfigInfo?.virtualHost
        ?? request.virtualHost
        ?? FINIXX_SERVICE_VIRTUAL_HOST,
    };

    return response;
  }

  getSessionNoMoreExtra(
    request: FinixxSessionNoMoreExtraRequest,
  ): Promise<FinixxSessionNoMoreExtraResponse> {
    const locationCd = this.getRequiredResolvedLocationCd();
    const channelCd = request.channelCd ?? FINIXX_SERVICE_CHANNEL_CD;
    const cacheKey = [
      locationCd,
      request.showDate,
      channelCd,
    ].join("|");
    const ttlMs = this.getSessionNoMoreExtraTtlMs(request.showDate);

    return this.getCachedValue(
      this.sessionNoMoreExtraCache,
      cacheKey,
      ttlMs,
      () => this.post<FinixxSessionNoMoreExtraResponse>(
        "/api/ticket/sessionnomoreextra",
        {
          code: SESSION_NO_MORE_EXTRA_CODE,
          locationcd: locationCd,
          showDate: request.showDate,
          channelCd,
        },
      ),
    );
  }

  getSessionFilms(
    request: FinixxSessionFilmRequest,
  ): Promise<FinixxSessionFilmResponse> {
    const locationCd = this.getRequiredResolvedLocationCd();
    const listFilmCd = normalizeFilmCodeList(request.listFilmCd);
    const cacheKey = [
      locationCd,
      listFilmCd.join(","),
    ].join("|");
    const ttlMs = this.config.cacheTtlMs?.sessionFilmsTtlMs ?? SESSION_FILMS_TTL_MS;

    return this.getCachedValue(
      this.sessionFilmsCache,
      cacheKey,
      ttlMs,
      () => this.post<FinixxSessionFilmResponse>(
        "/api/ticket/sessionfilm",
        {
          code: SESSION_FILM_CODE,
          locationcd: locationCd,
          listFilmCd,
        },
      ),
    );
  }

  async getScheduleWithFilms(
    request: FinixxScheduleWithFilmsRequest,
  ): Promise<FinixxScheduleWithFilmsResponse> {
    const sessions = await this.getSessionNoMoreExtra(request);
    const filmCds = collectUniqueStringValuesByKey(sessions, "filmCd");

    if (filmCds.length === 0) {
      return {
        sessions,
        films: null,
        filmCds,
        filmsByCode: {},
      };
    }

    const films = await this.getSessionFilms({
      listFilmCd: filmCds,
    });

    return {
      sessions,
      films,
      filmCds,
      filmsByCode: indexFilmRecordsByCode(films, filmCds),
    };
  }

  async post<TResponse extends FinixxApiResponse>(
    path: string,
    payload: FinixxRequestPayload,
  ): Promise<TResponse> {
    const requestPayload = this.buildSignedPayload(payload);
    const response = await this.httpClient.postJson<TResponse>(path, requestPayload);
    return response.body;
  }

  private buildSignedPayload(payload: FinixxRequestPayload): Record<string, FinixxPayloadValue | string> {
    const merged: FinixxRequestPayload = {
      version: FINIXX_SERVICE_VERSION,
      serialNumber: createFinixxSerialNumber(),
      userName: this.config.serviceUsername,
      password: this.config.servicePassword,
      locationcd: this.getResolvedLocationCd(),
      ...payload,
    };

    const normalized = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined && value !== null),
    ) as Record<string, FinixxPayloadValue>;

    normalized.signature = signFinixxParams(normalized, this.config.serviceApiKey);
    return normalized;
  }

  private getRequiredInitializationContext(): FinixxInitializationContext {
    if (!this.initializationContext) {
      throw new Error("Finixx client is not initialized. Call initialize() first.");
    }

    return this.initializationContext;
  }

  private getRequiredResolvedLocationCd(): string {
    const locationCd = this.getResolvedLocationCd();
    if (!locationCd) {
      throw new Error("Finixx client is not initialized. LocationCd is unavailable.");
    }

    return locationCd;
  }

  private getCachedValue<T>(
    cache: Map<string, FinixxCacheEntry<T>>,
    cacheKey: string,
    ttlMs: number,
    fetchValue: () => Promise<T>,
  ): Promise<T> {
    if (ttlMs <= 0) {
      return fetchValue();
    }

    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const entry: FinixxCacheEntry<T> = {
      expiresAt: now + ttlMs,
      value: fetchValue(),
    };

    entry.value.catch(() => {
      if (cache.get(cacheKey) === entry) {
        cache.delete(cacheKey);
      }
    });
    cache.set(cacheKey, entry);
    return entry.value;
  }

  private getSessionNoMoreExtraTtlMs(showDate: string): number {
    const category = categorizeShowDate(showDate);
    if (category === "historical") {
      return this.config.cacheTtlMs?.historicalSessionNoMoreExtraTtlMs ?? HISTORICAL_SESSION_NO_MORE_EXTRA_TTL_MS;
    }
    if (category === "future") {
      return this.config.cacheTtlMs?.futureSessionNoMoreExtraTtlMs ?? FUTURE_SESSION_NO_MORE_EXTRA_TTL_MS;
    }

    return this.config.cacheTtlMs?.todayOrTomorrowSessionNoMoreExtraTtlMs ?? CURRENT_SESSION_NO_MORE_EXTRA_TTL_MS;
  }
}

function normalizeFilmCodeList(listFilmCd: readonly string[]): string[] {
  return [...new Set(listFilmCd.filter((filmCd) => filmCd.length > 0))].sort();
}

function categorizeShowDate(showDate: string): "historical" | "current" | "future" {
  const parsed = parseDateOnly(showDate);
  if (!parsed) {
    return "current";
  }

  const today = new Date();
  const todayDay = utcDayNumber(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const showDay = utcDayNumber(parsed.year, parsed.month, parsed.day);
  const dayOffset = showDay - todayDay;

  if (dayOffset < 0) {
    return "historical";
  }
  if (dayOffset <= 1) {
    return "current";
  }

  return "future";
}

function parseDateOnly(value: string): { readonly year: number; readonly month: number; readonly day: number } | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) {
    return null;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() + 1 !== month
    || normalized.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function utcDayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function collectUniqueStringValuesByKey(
  value: unknown,
  targetKey: string,
): string[] {
  const matched = new Set<string>();
  const visited = new Set<object>();
  const normalizedTargetKey = targetKey.toLowerCase();

  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) {
        walk(item);
      }
      return;
    }

    if (!current || typeof current !== "object") {
      return;
    }

    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    for (const [key, nestedValue] of Object.entries(current)) {
      if (key.toLowerCase() === normalizedTargetKey && typeof nestedValue === "string" && nestedValue.length > 0) {
        matched.add(nestedValue);
      }
      walk(nestedValue);
    }
  };

  walk(value);
  return [...matched];
}

function indexFilmRecordsByCode(
  films: FinixxSessionFilmResponse,
  requestedFilmCds: readonly string[],
): Readonly<Record<string, FinixxResolvedFilmInfo>> {
  const records = collectObjectsContainingStringKey(films, "filmCd");
  const indexedRecords = new Map<string, FinixxResolvedFilmInfo>();

  for (const record of records) {
    const filmCd = readStringValueByKey(record, "filmCd");
    if (!filmCd || indexedRecords.has(filmCd)) {
      continue;
    }

    indexedRecords.set(filmCd, {
      filmCd,
      raw: record,
    });
  }

  for (const filmCd of requestedFilmCds) {
    if (indexedRecords.has(filmCd)) {
      continue;
    }

    indexedRecords.set(filmCd, {
      filmCd,
      raw: {},
    });
  }

  return Object.fromEntries(indexedRecords);
}

function collectObjectsContainingStringKey(
  value: unknown,
  targetKey: string,
): Record<string, unknown>[] {
  const matched: Record<string, unknown>[] = [];
  const visited = new Set<object>();
  const normalizedTargetKey = targetKey.toLowerCase();

  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) {
        walk(item);
      }
      return;
    }

    if (!current || typeof current !== "object") {
      return;
    }

    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    const record = current as Record<string, unknown>;
    if (typeof readStringValueByKey(record, normalizedTargetKey) === "string") {
      matched.push(record);
    }

    for (const nestedValue of Object.values(record)) {
      walk(nestedValue);
    }
  };

  walk(value);
  return matched;
}

function readStringValueByKey(
  record: Record<string, unknown>,
  targetKey: string,
): string | undefined {
  const normalizedTargetKey = targetKey.toLowerCase();

  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === normalizedTargetKey && typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}
