import { FinixxSdk } from "../sdk/finixx-sdk";
import type {
  FinixxAllSystemSettingRequest,
  FinixxAllSystemSettingResponse,
  FinixxInitializationContext,
  FinixxScheduleWithFilmsRequest,
  FinixxScheduleWithFilmsResponse,
  FinixxSdkConfig,
  FinixxSessionFilmRequest,
  FinixxSessionFilmResponse,
  FinixxSessionNoMoreExtraRequest,
  FinixxSessionNoMoreExtraResponse,
} from "../sdk/types";

export interface FinixxClientConfig extends FinixxSdkConfig {
  readonly deviceId: string;
  readonly auditoriumId?: string;
}

export class FinixxClient {
  readonly sdk: FinixxSdk;

  constructor(readonly config: FinixxClientConfig) {
    this.sdk = new FinixxSdk(config);
  }

  static async create(config: FinixxClientConfig): Promise<FinixxClient> {
    const client = new FinixxClient(config);
    await client.sdk.initialize();
    return client;
  }

  get deviceId(): string {
    return this.config.deviceId;
  }

  get auditoriumId(): string | undefined {
    return this.config.auditoriumId;
  }

  get initializationContext(): FinixxInitializationContext | undefined {
    return this.sdk.getInitializationContext();
  }

  getSystemSettings(): FinixxAllSystemSettingResponse {
    return this.sdk.getSystemSettings();
  }

  refreshSystemSettings(
    request?: FinixxAllSystemSettingRequest,
  ): Promise<FinixxAllSystemSettingResponse> {
    return this.sdk.refreshSystemSettings(request);
  }

  getSessionNoMoreExtra(
    request: FinixxSessionNoMoreExtraRequest,
  ): Promise<FinixxSessionNoMoreExtraResponse> {
    return this.sdk.getSessionNoMoreExtra(request);
  }

  getSessionFilms(
    request: FinixxSessionFilmRequest,
  ): Promise<FinixxSessionFilmResponse> {
    return this.sdk.getSessionFilms(request);
  }

  getScheduleWithFilms(
    request: FinixxScheduleWithFilmsRequest,
  ): Promise<FinixxScheduleWithFilmsResponse> {
    return this.sdk.getScheduleWithFilms(request);
  }
}
