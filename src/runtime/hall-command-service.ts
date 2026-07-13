import type {
  GdcMovePlaybackInput,
  GdcIngestFileInput,
  GdcPutScheduleInput,
  GdcXmlResponse,
} from "../modules/gdc";
import type { HallRuntimeRegistry } from "./hall-runtime-registry";
import type { HallDeviceEvent } from "./types";

export type HallCommandType =
  | "INGEST_FILE"
  | "PUT_SCHEDULE"
  | "LOAD_SHOW"
  | "PLAY_SHOW"
  | "PAUSE_PLAYBACK"
  | "UNPAUSE_PLAYBACK"
  | "STOP_PLAYBACK"
  | "MOVE_PLAYBACK"
  | "SKIP_FORWARD"
  | "SKIP_BACKWARD"
  | "TRIGGER_AUTOMATION";

export interface HallCommandMetadata {
  readonly requestId?: string;
  readonly jobId?: string;
  readonly dedupeKey?: string;
  readonly requestedBy?: string;
}

export interface HallCommandReceipt {
  readonly commandId: string;
  readonly hallId: string;
  readonly type: HallCommandType;
  readonly acceptedAt: string;
  readonly metadata?: HallCommandMetadata;
}

export interface HallCommandGateway {
  ingestFile(hallId: string, input: GdcIngestFileInput): Promise<GdcXmlResponse>;
  putSchedule(hallId: string, input: GdcPutScheduleInput): Promise<GdcXmlResponse>;
  loadShow(hallId: string, showUuid: string): Promise<GdcXmlResponse>;
  playShow(hallId: string): Promise<GdcXmlResponse>;
  pausePlayback(hallId: string): Promise<GdcXmlResponse>;
  unpausePlayback(hallId: string): Promise<GdcXmlResponse>;
  stopPlayback(hallId: string): Promise<GdcXmlResponse>;
  movePlayback(hallId: string, input: GdcMovePlaybackInput): Promise<GdcXmlResponse>;
  skipForward(hallId: string): Promise<GdcXmlResponse>;
  skipBackward(hallId: string): Promise<GdcXmlResponse>;
  triggerAutomation(hallId: string, eventLabel: string): Promise<GdcXmlResponse>;
}

export class HallCommandService {
  constructor(
    private readonly registry: HallRuntimeRegistry,
    private readonly gateway: HallCommandGateway,
  ) {}

  async ingestFile(
    hallId: string,
    input: GdcIngestFileInput,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "INGEST_FILE", metadata, () => this.gateway.ingestFile(hallId, input));
  }

  async putSchedule(
    hallId: string,
    input: GdcPutScheduleInput,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "PUT_SCHEDULE", metadata, () => this.gateway.putSchedule(hallId, input));
  }

  async playShow(
    hallId: string,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "PLAY_SHOW", metadata, () => this.gateway.playShow(hallId));
  }

  async loadShow(
    hallId: string,
    showUuid: string,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "LOAD_SHOW", metadata, () => this.gateway.loadShow(hallId, showUuid));
  }

  async pausePlayback(
    hallId: string,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "PAUSE_PLAYBACK", metadata, () => this.gateway.pausePlayback(hallId));
  }

  async unpausePlayback(
    hallId: string,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "UNPAUSE_PLAYBACK", metadata, () => this.gateway.unpausePlayback(hallId));
  }

  async stopPlayback(
    hallId: string,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "STOP_PLAYBACK", metadata, () => this.gateway.stopPlayback(hallId));
  }

  async movePlayback(
    hallId: string,
    input: GdcMovePlaybackInput,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "MOVE_PLAYBACK", metadata, () => this.gateway.movePlayback(hallId, input));
  }

  async skipForward(
    hallId: string,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "SKIP_FORWARD", metadata, () => this.gateway.skipForward(hallId));
  }

  async skipBackward(
    hallId: string,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(hallId, "SKIP_BACKWARD", metadata, () => this.gateway.skipBackward(hallId));
  }

  async triggerAutomation(
    hallId: string,
    eventLabel: string,
    metadata?: HallCommandMetadata,
  ): Promise<HallCommandReceipt> {
    return this.acceptAndExecute(
      hallId,
      "TRIGGER_AUTOMATION",
      metadata,
      () => this.gateway.triggerAutomation(hallId, eventLabel),
    );
  }

  private async acceptAndExecute(
    hallId: string,
    type: HallCommandType,
    metadata: HallCommandMetadata | undefined,
    action: () => Promise<GdcXmlResponse>,
  ): Promise<HallCommandReceipt> {
    const runtime = this.registry.getRuntimeOrThrow(hallId);
    const receipt: HallCommandReceipt = {
      commandId: createCommandId(type),
      hallId,
      type,
      acceptedAt: new Date().toISOString(),
      metadata,
    };

    this.registry.publishEvent(this.buildCommandEvent(runtime.registration.deviceId, hallId, "COMMAND_ACCEPTED", {
      commandId: receipt.commandId,
      commandType: type,
      metadata,
    }));

    try {
      await action();
      return receipt;
    } catch (error) {
      this.registry.publishEvent(this.buildCommandEvent(runtime.registration.deviceId, hallId, "COMMAND_REJECTED", {
        commandId: receipt.commandId,
        commandType: type,
        metadata,
        error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  }

  private buildCommandEvent(
    deviceId: string | undefined,
    hallId: string,
    type: HallDeviceEvent["type"],
    payload: Record<string, unknown>,
  ): HallDeviceEvent {
    return {
      eventId: createCommandId(type),
      hallId,
      deviceId,
      type,
      occurredAt: new Date().toISOString(),
      payload,
      source: "command",
    };
  }
}

function createCommandId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
