export type FinixxPrimitive = string | number | boolean | bigint;
export type FinixxPayloadValue =
  | FinixxPrimitive
  | readonly FinixxPrimitive[];

export type FinixxResultMessageMap = Readonly<Record<string, string>>;

export interface FinixxRequestBase {
  readonly code: string;
  readonly version?: string;
  readonly serialNumber?: string;
  readonly userName?: string;
  readonly password?: string;
  readonly locationcd?: string;
}

export interface FinixxSdkConfig {
  readonly baseUrl: string;
  readonly serviceUsername: string;
  readonly servicePassword: string;
  readonly serviceApiKey: string;
  readonly requestTimeoutMs?: number;
  readonly defaultWorkStationId?: string;
  readonly resultMessageMap?: FinixxResultMessageMap;
  readonly cacheTtlMs?: FinixxSdkCacheTtlConfig;
}

export interface FinixxSdkCacheTtlConfig {
  readonly historicalSessionNoMoreExtraTtlMs?: number;
  readonly todayOrTomorrowSessionNoMoreExtraTtlMs?: number;
  readonly futureSessionNoMoreExtraTtlMs?: number;
  readonly sessionFilmsTtlMs?: number;
}

export interface FinixxApiResponse {
  readonly status?: unknown;
  readonly code?: string | null;
  readonly version?: string | null;
  readonly serialNumber?: string | null;
  readonly result?: number | null;
  readonly message?: string | null;
  readonly [key: string]: unknown;
}

export interface FinixxParameterItem {
  readonly parms_Name: string;
  readonly parms_Values: string;
}

export interface FinixxLocationInfo {
  readonly id?: string;
  readonly locationCode?: string;
  readonly name?: string;
  readonly localFlag?: boolean;
  readonly [key: string]: unknown;
}

export interface FinixxWorkStationInfo extends FinixxApiResponse {
  readonly WorkstationId?: string;
  readonly WorkstationDesc?: string;
  readonly LocationCd?: string;
  readonly LocationName?: string;
  readonly WorkstationKindCd?: string;
  readonly WorkstationKindName?: string | null;
  readonly PosFlg?: boolean;
  readonly GaFlg?: boolean;
  readonly EnableFlg?: boolean;
  readonly [key: string]: unknown;
}

export interface FinixxMqConfigInfo extends FinixxApiResponse {
  readonly hostName?: string;
  readonly Port?: number;
  readonly userName?: string;
  readonly passCode?: string;
  readonly virtualHost?: string;
  readonly prefetchCount?: number;
  readonly durable?: boolean;
  readonly exclusive?: boolean;
  readonly autoDelete?: boolean;
}

export interface FinixxAllSystemSettingRequest {
  readonly channelCd?: string;
  readonly workStationId?: string;
  readonly boxOfficeSettingFlg?: boolean;
  readonly posSettingFlg?: boolean;
  readonly cardSettingFlg?: boolean;
  readonly posBigClassReturnPic?: boolean;
  readonly virtualHost?: string;
}

export interface FinixxAllSystemSettingResponse extends FinixxApiResponse {
  readonly systemTime?: string;
  readonly workStationInfo?: FinixxWorkStationInfo;
  readonly mqConfigInfo?: FinixxMqConfigInfo;
  readonly boParmeterInfo?: {
    readonly boparms?: FinixxParameterItem[];
    readonly [key: string]: unknown;
  } | null;
  readonly allLocationInfo?: {
    readonly locationList?: FinixxLocationInfo[];
    readonly [key: string]: unknown;
  } | null;
  readonly hallsInfo?: {
    readonly halls?: Array<Record<string, unknown>>;
    readonly [key: string]: unknown;
  } | null;
  readonly [key: string]: unknown;
}

export interface FinixxInitializationContext {
  readonly initializedAt: Date;
  readonly response: FinixxAllSystemSettingResponse;
  readonly resolvedLocationCd?: string;
  readonly workStationId?: string;
  readonly virtualHost?: string;
}

export interface FinixxSessionNoMoreExtraRequest {
  readonly showDate: string;
  readonly channelCd?: string;
}

export interface FinixxSessionFilmRequest {
  readonly listFilmCd: readonly string[];
}

export interface FinixxSessionNoMoreExtraResponse extends FinixxApiResponse {
  readonly [key: string]: unknown;
}

export interface FinixxSessionFilmResponse extends FinixxApiResponse {
  readonly [key: string]: unknown;
}

export interface FinixxResolvedFilmInfo {
  readonly filmCd: string;
  readonly raw: Record<string, unknown>;
}

export interface FinixxScheduleWithFilmsRequest extends FinixxSessionNoMoreExtraRequest {}

export interface FinixxScheduleWithFilmsResponse {
  readonly sessions: FinixxSessionNoMoreExtraResponse;
  readonly films: FinixxSessionFilmResponse | null;
  readonly filmCds: readonly string[];
  readonly filmsByCode: Readonly<Record<string, FinixxResolvedFilmInfo>>;
}
