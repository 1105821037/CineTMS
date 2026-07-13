import { GdcProtocolCodec } from "../protocol/codec";
import { GdcResponseError } from "../protocol/errors";
import type { GdcXmlResponse } from "../protocol/types";
import { GdcConnection } from "../connection/gdc-connection";
import { GdcCommandBuilder } from "./command-builder";
import { GdcSdkResponseParser } from "./response-parser";
import { GdcShowPlaylistBuilder } from "./show-playlist-builder";
import type {
  GdcTriggerAutomationInput,
  GdcCplDetail,
  GdcCplListOptions,
  GdcCplSummary,
  GdcEventLogInput,
  GdcEventLogResult,
  GdcIngestContentInput,
  GdcIngestFileInput,
  GdcIngestFileResult,
  GdcIngestListItem,
  GdcIngestStatus,
  GdcKdmDetail,
  GdcKdmSummary,
  GdcMovePlaybackInput,
  GdcPlaybackStatus,
  GdcProjectorStatus,
  GdcPutScheduleInput,
  GdcPutScheduleResult,
  GdcPutShowInput,
  GdcPutShowResult,
  GdcScheduleSummary,
  GdcSchedulerStatus,
  GdcServerDateTime,
  GdcServerInfo,
  GdcServerIpList,
  GdcServerSnapshot,
  GdcShowDetail,
  GdcShowSummary,
  GdcStorageInfo,
  GdcTimezoneInfo,
  GdcValidateCplResult,
  GdcValidateShowResult,
} from "./types";

export class GdcSdk {
  private readonly commandBuilder = new GdcCommandBuilder();
  private readonly protocolCodec = new GdcProtocolCodec();
  private readonly responseParser = new GdcSdkResponseParser();
  private readonly showPlaylistBuilder = new GdcShowPlaylistBuilder();

  constructor(private readonly connection: GdcConnection) {}

  async heartbeat(): Promise<GdcXmlResponse> {
    return this.sendCommand("HEARTBEAT");
  }

  async getSupportedCommands(): Promise<string[]> {
    const xml = await this.sendRawCommand("GET_SUPPORTED_COMMANDS");
    return this.responseParser.parseSupportedCommands(xml);
  }

  async getAutomationLabels(): Promise<string[]> {
    const xml = await this.sendRawCommand("GET_AUTOMATION_LABELS");
    return this.responseParser.parseAutomationLabels(xml);
  }

  async getEventLogs(input: GdcEventLogInput): Promise<GdcEventLogResult> {
    const xml = await this.sendRawCommand(
      "GET_EVENT_LOGS",
      `<log date="${escapeXmlText(input.date)}"/>`,
    );
    return this.responseParser.parseEventLogs(xml, input.date);
  }

  async triggerAutomation(input: GdcTriggerAutomationInput): Promise<GdcXmlResponse> {
    return this.sendCommand(
      "TRIGGER_AUTOMATION",
      `<event_label>${escapeXmlText(input.eventLabel)}</event_label>`,
    );
  }

  async getServerInfo(): Promise<GdcServerInfo> {
    const xml = await this.sendRawCommand("GET_SERVER_INFO");
    return this.responseParser.parseServerInfo(xml);
  }

  async getCplList(options?: GdcCplListOptions): Promise<GdcCplSummary[]> {
    const innerXml = this.buildCplListInnerXml(options);
    const xml = await this.sendRawCommand("GET_CPL_LIST", innerXml);
    return this.responseParser.parseCplList(xml);
  }

  async getCpl(cplUuid: string): Promise<GdcCplDetail> {
    const xml = await this.sendRawCommand("GET_CPL", `<cpl_uuid>${cplUuid}</cpl_uuid>`);
    return {
      ...this.responseParser.parseCplDetail(xml),
      cplUuid,
    };
  }

  async getKdmList(): Promise<GdcKdmSummary[]> {
    const xml = await this.sendRawCommand("GET_KDM_LIST");
    return this.responseParser.parseKdmList(xml);
  }

  async getKdm(assetUuid: string): Promise<GdcKdmDetail> {
    const xml = await this.sendRawCommand("GET_KDM", `<asset_uuid>${assetUuid}</asset_uuid>`);
    return this.responseParser.parseKdmDetail(xml);
  }

  async ingestFile(input: GdcIngestFileInput): Promise<GdcIngestFileResult> {
    const credentialsInSource = shouldEmbedCredentialsInSource(input.source, input.username, input.password);
    const lines = [
      `<source>${escapeXmlText(buildIngestSource(input.source, input.username, input.password))}</source>`,
    ];
    if (input.path !== undefined) {
      lines.push(`<path>${escapeXmlText(input.path)}</path>`);
    }
    if (input.assetType !== undefined) {
      lines.push(`<asset_type>${escapeXmlText(input.assetType)}</asset_type>`);
    }
    if (input.fileType !== undefined) {
      lines.push(`<file_type>${escapeXmlText(input.fileType)}</file_type>`);
    }
    if (!credentialsInSource && input.username !== undefined) {
      lines.push(`<username>${escapeXmlText(input.username)}</username>`);
    }
    if (!credentialsInSource && input.password !== undefined) {
      lines.push(`<password>${escapeXmlText(input.password)}</password>`);
    }

    const rawXml = await this.sendRawCommand("INGEST_FILE", lines.join(""));
    const ingestUuid = this.responseParser.parseIngestList(rawXml)[0]?.ingestUuid;
    if (!ingestUuid) {
      throw new GdcResponseError("INGEST_FILE response did not contain ingest_uuid", rawXml);
    }

    return {
      ingestUuid,
      rawXml,
    };
  }

  async ingestContent(input: GdcIngestContentInput): Promise<GdcIngestFileResult> {
    const credentialsInSource = shouldEmbedCredentialsInSource(input.source, input.username, input.password);
    const lines = [
      `<source>${escapeXmlText(buildIngestSource(input.source, input.username, input.password))}</source>`,
      `<path>${escapeXmlText(input.path)}</path>`,
      `<asset_uuid>${escapeXmlText(input.assetUuid)}</asset_uuid>`,
      `<asset_type>${escapeXmlText(input.assetType)}</asset_type>`,
    ];
    if (!credentialsInSource && input.username !== undefined) {
      lines.push(`<username>${escapeXmlText(input.username)}</username>`);
    }
    if (!credentialsInSource && input.password !== undefined) {
      lines.push(`<password>${escapeXmlText(input.password)}</password>`);
    }

    const rawXml = await this.sendRawCommand("INGEST_CONTENT", lines.join(""));
    const ingestUuid = this.responseParser.parseIngestList(rawXml)[0]?.ingestUuid;
    if (!ingestUuid) {
      throw new GdcResponseError("INGEST_CONTENT response did not contain ingest_uuid", rawXml);
    }

    return {
      ingestUuid,
      rawXml,
    };
  }

  async getIngestStatus(ingestUuid: string): Promise<GdcIngestStatus> {
    const xml = await this.sendRawCommand("GET_INGEST_STATUS", `<ingest_uuid>${ingestUuid}</ingest_uuid>`);
    return this.responseParser.parseIngestStatus(xml);
  }

  async getIngestList(): Promise<GdcIngestListItem[]> {
    const xml = await this.sendRawCommand("GET_INGEST_LIST");
    return this.responseParser.parseIngestList(xml);
  }

  async cancelIngest(ingestUuid: string): Promise<GdcXmlResponse> {
    return this.sendCommand("CANCEL_INGEST", `<ingest_uuid>${ingestUuid}</ingest_uuid>`);
  }

  async getPlaybackStatus(): Promise<GdcPlaybackStatus> {
    const xml = await this.sendRawCommand("GET_PLAYBACK_STATUS");
    return this.responseParser.parsePlaybackStatus(xml);
  }

  async loadShow(showUuid: string): Promise<GdcXmlResponse> {
    return this.sendCommand("LOAD_SHOW", `<show_uuid>${showUuid}</show_uuid>`);
  }

  async clearShow(): Promise<GdcXmlResponse> {
    return this.sendCommand("CLEAR_SHOW");
  }

  async playShow(): Promise<GdcXmlResponse> {
    return this.sendCommand("PLAY_SHOW");
  }

  async pausePlayback(): Promise<GdcXmlResponse> {
    return this.sendCommand("PAUSE_PLAYBACK");
  }

  async unpausePlayback(): Promise<GdcXmlResponse> {
    return this.sendCommand("UNPAUSE_PLAYBACK");
  }

  async stopPlayback(): Promise<GdcXmlResponse> {
    return this.sendCommand("STOP_PLAYBACK");
  }

  async movePlayback(input: GdcMovePlaybackInput): Promise<GdcXmlResponse> {
    if (input.absolute) {
      return this.sendCommand("MOVE_PLAYBACK", `<absolute>${input.absolute}</absolute>`);
    }

    if (typeof input.offset === "number" && Number.isFinite(input.offset)) {
      return this.sendCommand("MOVE_PLAYBACK", `<offset>${Math.trunc(input.offset)}</offset>`);
    }

    throw new Error("movePlayback requires either absolute or offset");
  }

  async skipForward(): Promise<GdcXmlResponse> {
    return this.sendCommand("SKIP_FORWARD");
  }

  async skipBackward(): Promise<GdcXmlResponse> {
    return this.sendCommand("SKIP_BACKWARD");
  }

  async getSchedules(): Promise<GdcScheduleSummary[]> {
    const xml = await this.sendRawCommand("GET_SCHEDULES");
    return this.responseParser.parseSchedules(xml);
  }

  async getSchedule(scheduleUuid: string): Promise<GdcScheduleSummary | undefined> {
    const xml = await this.sendRawCommand("GET_SCHEDULE", `<schedule_uuid>${scheduleUuid}</schedule_uuid>`);
    return this.responseParser.parseSchedules(xml)[0];
  }

  async getCurrentSchedule(): Promise<GdcScheduleSummary | undefined> {
    try {
      const xml = await this.sendRawCommand("GET_CURRENT_SCHEDULE");
      return this.responseParser.parseSchedules(xml)[0];
    } catch (error) {
      if (error instanceof GdcResponseError && error.responseXml.includes("No schedule playing at the moment")) {
        return undefined;
      }
      throw error;
    }
  }

  async getNextSchedule(): Promise<GdcScheduleSummary | undefined> {
    const xml = await this.sendRawCommand("GET_NEXT_SCHEDULE");
    return this.responseParser.parseSchedules(xml)[0];
  }

  async putSchedule(input: GdcPutScheduleInput): Promise<GdcPutScheduleResult> {
    const before = await this.getSchedules();
    const innerXml =
      `<schedule iso_date_time="${input.isoDateTime}" show_content_version_id="${input.showContentVersionId}" show_content_ver_id="${input.showContentVersionId}">` +
      `${input.showUuid}</schedule>`;
    await this.sendRawCommand("PUT_SCHEDULE", innerXml);

    const after = await this.getSchedules();
    const created =
      after.find((schedule) => !before.some((item) => item.scheduleUuid === schedule.scheduleUuid)) ??
      after.find(
        (schedule) =>
          schedule.scheduleUuid === input.showUuid &&
          schedule.showContentVersionId === input.showContentVersionId &&
          schedule.isoDateTime === input.isoDateTime,
      );

    return {
      scheduleUuid: created?.scheduleUuid ?? input.showUuid,
      showContentVersionId: created?.showContentVersionId ?? input.showContentVersionId,
      isoDateTime: created?.isoDateTime ?? input.isoDateTime,
    };
  }

  async cancelSchedule(scheduleUuid: string): Promise<GdcXmlResponse> {
    return this.sendCommand("CANCEL_SCHEDULE", `<schedule_uuid>${scheduleUuid}</schedule_uuid>`);
  }

  async enableScheduler(): Promise<GdcXmlResponse> {
    return this.sendCommand("ENABLE_SCHEDULER");
  }

  async disableScheduler(): Promise<GdcXmlResponse> {
    return this.sendCommand("DISABLE_SCHEDULER");
  }

  async validateCpl(cplUuid: string): Promise<GdcValidateCplResult> {
    try {
      const rawXml = await this.sendRawCommand("VALIDATE_CPL", `<cpl_uuid>${cplUuid}</cpl_uuid>`);
      this.responseParser.parseResponse(rawXml);
      return { ok: true, rawXml };
    } catch (error) {
      if (error instanceof GdcResponseError) {
        return { ok: false, rawXml: error.responseXml };
      }
      throw error;
    }
  }

  async getServerDateTime(): Promise<GdcServerDateTime> {
    const xml = await this.sendRawCommand("GET_DATE_TIME");
    return this.responseParser.parseServerDateTime(xml);
  }

  async getStorageInfo(): Promise<GdcStorageInfo> {
    const xml = await this.sendRawCommand("GET_STORAGE_INFO");
    return this.responseParser.parseStorageInfo(xml);
  }

  async getTimezoneInfo(): Promise<GdcTimezoneInfo> {
    const xml = await this.sendRawCommand("GET_TIMEZONE");
    return this.responseParser.parseTimezoneInfo(xml);
  }

  async getServerIpList(): Promise<GdcServerIpList> {
    const xml = await this.sendRawCommand("GET_SERVER_IP_LIST");
    return this.responseParser.parseServerIpList(xml);
  }

  async getSchedulerStatus(): Promise<GdcSchedulerStatus> {
    const xml = await this.sendRawCommand("GET_SCHEDULER_STATUS");
    return this.responseParser.parseSchedulerStatus(xml);
  }

  async getProjectorStatus(): Promise<GdcProjectorStatus> {
    const xml = await this.sendRawCommand("GET_PROJECTOR_STATUS");
    return this.responseParser.parseProjectorStatus(xml);
  }

  async getServerSnapshot(): Promise<GdcServerSnapshot> {
    const [
      serverInfo,
      dateTime,
      storageInfo,
      timezoneInfo,
      ipList,
      projectorStatus,
      schedulerStatus,
    ] = await Promise.all([
      this.getServerInfo(),
      this.getServerDateTime(),
      this.getStorageInfo(),
      this.getTimezoneInfo(),
      this.getServerIpList(),
      this.getProjectorStatus(),
      this.getSchedulerStatus(),
    ]);

    return {
      serverInfo,
      dateTime,
      storageInfo,
      timezoneInfo,
      ipList,
      projectorStatus,
      schedulerStatus,
    };
  }

  async getShowList(): Promise<GdcShowSummary[]> {
    const xml = await this.sendRawCommand("GET_SHOW_LIST");
    return this.responseParser.parseShowList(xml);
  }

  async getShow(showUuid: string): Promise<GdcShowDetail> {
    const xml = await this.sendRawCommand("GET_SHOW", `<show_uuid>${showUuid}</show_uuid>`);
    return this.responseParser.parseShowDetail(xml);
  }

  async putShow(input: GdcPutShowInput): Promise<GdcPutShowResult> {
    const built = this.showPlaylistBuilder.build(input);
    const innerXml = this.showPlaylistBuilder.wrapCommandText(built.showXml);
    await this.sendRawCommand("PUT_SHOW", innerXml);
    return built;
  }

  async deleteShow(showUuid: string): Promise<GdcXmlResponse> {
    return this.sendCommand("DELETE_SHOW", `<show_uuid>${showUuid}</show_uuid>`);
  }

  async deleteFile(assetUuid: string): Promise<GdcXmlResponse> {
    return this.sendCommand("DELETE_FILE", `<asset_uuid>${assetUuid}</asset_uuid>`);
  }

  async deleteContent(assetUuid: string): Promise<GdcXmlResponse> {
    return this.sendCommand(
      "DELETE_CONTENT",
      `<asset_uuid>${escapeXmlText(stripUuidUrn(assetUuid))}</asset_uuid>`,
      { version: "2" },
    );
  }

  async validateShow(showUuid: string): Promise<GdcValidateShowResult> {
    try {
      const rawXml = await this.sendRawCommand("VALIDATE_SHOW", `<show_uuid>${showUuid}</show_uuid>`);
      this.responseParser.parseResponse(rawXml);
      return { ok: true, rawXml };
    } catch (error) {
      if (error instanceof GdcResponseError) {
        return { ok: false, rawXml: error.responseXml };
      }
      throw error;
    }
  }

  async sendCommand(
    commandName: string,
    innerXml?: string,
    options: { version?: string } = {},
  ): Promise<GdcXmlResponse> {
    const xml = await this.sendRawCommand(commandName, innerXml, options);
    return this.responseParser.parseResponse(xml);
  }

  async sendRawCommand(
    commandName: string,
    innerXml?: string,
    options: { version?: string } = {},
  ): Promise<string> {
    const xml = this.commandBuilder.buildXml({ commandName, innerXml, version: options.version });
    const frame = this.protocolCodec.encodeXmlCommand(xml);
    const response = await this.connection.send(frame.payload);
    return response.xml;
  }

  private buildCplListInnerXml(options?: GdcCplListOptions): string | undefined {
    if (!options) {
      return undefined;
    }

    const lines: string[] = [];
    if (options.listAll !== undefined) {
      lines.push(`<list_all>${options.listAll}</list_all>`);
    }
    if (options.storage) {
      lines.push(`<storage>${options.storage}</storage>`);
    }

    return lines.length > 0 ? lines.join("\n") : undefined;
  }
}

function escapeXmlText(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripUuidUrn(value: string): string {
  return String(value || "").trim().replace(/^urn:uuid:/i, "");
}

function shouldEmbedCredentialsInSource(source: string, username?: string, password?: string): boolean {
  return /^ftp:\/\//i.test(source) && (username !== undefined || password !== undefined);
}

function buildIngestSource(source: string, username?: string, password?: string): string {
  if (!shouldEmbedCredentialsInSource(source, username, password)) {
    return source;
  }

  try {
    const url = new URL(source);
    if (!url.username && !url.password) {
      url.username = username || "anonymous";
      if (password !== undefined) {
        url.password = password;
      }
    }
    return url.toString();
  } catch {
    return source;
  }
}
