import type {
  GdcClient,
  GdcClientManager,
  GdcConnectionOptions,
  GdcIngestFileInput,
  GdcMovePlaybackInput,
  GdcPutScheduleInput,
  GdcXmlResponse,
} from "../modules/gdc";
import type { HallCommandGateway } from "./hall-command-service";
import type { HallRuntimeRegistry } from "./hall-runtime-registry";

export class GdcHallCommandGateway implements HallCommandGateway {
  constructor(
    private readonly registry: HallRuntimeRegistry,
    private readonly clientManager: GdcClientManager,
  ) {}

  async ingestFile(hallId: string, input: GdcIngestFileInput): Promise<GdcXmlResponse> {
    const client = this.resolveClient(hallId);
    const result = await client.ingestFile(input);
    return {
      status: "OK",
      rawXml: result.rawXml,
    };
  }

  async putSchedule(hallId: string, input: GdcPutScheduleInput): Promise<GdcXmlResponse> {
    const client = this.resolveClient(hallId);
    const result = await client.putSchedule(input);
    return {
      status: "OK",
      rawXml: JSON.stringify(result),
    };
  }

  async loadShow(hallId: string, showUuid: string): Promise<GdcXmlResponse> {
    return this.resolveClient(hallId).loadShow(showUuid);
  }

  async playShow(hallId: string): Promise<GdcXmlResponse> {
    return this.resolveClient(hallId).playShow();
  }

  async pausePlayback(hallId: string): Promise<GdcXmlResponse> {
    return this.resolveClient(hallId).pausePlayback();
  }

  async unpausePlayback(hallId: string): Promise<GdcXmlResponse> {
    return this.resolveClient(hallId).unpausePlayback();
  }

  async stopPlayback(hallId: string): Promise<GdcXmlResponse> {
    return this.resolveClient(hallId).stopPlayback();
  }

  async movePlayback(hallId: string, input: GdcMovePlaybackInput): Promise<GdcXmlResponse> {
    return this.resolveClient(hallId).movePlayback(input);
  }

  async skipForward(hallId: string): Promise<GdcXmlResponse> {
    return this.resolveClient(hallId).skipForward();
  }

  async skipBackward(hallId: string): Promise<GdcXmlResponse> {
    return this.resolveClient(hallId).skipBackward();
  }

  async triggerAutomation(hallId: string, eventLabel: string): Promise<GdcXmlResponse> {
    return this.resolveClient(hallId).triggerAutomation({ eventLabel });
  }

  private resolveClient(hallId: string): GdcClient {
    const runtime = this.registry.getRuntimeOrThrow(hallId);
    const config: GdcConnectionOptions & { deviceId: string; auditoriumId?: string } = {
      deviceId: runtime.registration.deviceId,
      auditoriumId: runtime.registration.auditoriumId,
      host: runtime.registration.host,
      port: runtime.registration.port,
    };
    return this.clientManager.upsertClient(config);
  }
}
