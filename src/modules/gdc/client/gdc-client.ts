import { EventEmitter } from "node:events";
import {
  GdcConnection,
  type GdcConnectionOptions,
} from "../connection/gdc-connection";
import type { GdcConnectionState } from "../connection/connection-state";
import { GdcSdk } from "../sdk/gdc-sdk";
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
} from "../sdk/types";

export interface GdcClientConfig extends GdcConnectionOptions {
  readonly deviceId: string;
  readonly auditoriumId?: string;
}

export class GdcClient extends EventEmitter {
  readonly connection: GdcConnection;
  readonly sdk: GdcSdk;

  constructor(readonly config: GdcClientConfig) {
    super();
    this.connection = new GdcConnection(config);
    this.sdk = new GdcSdk(this.connection);

    this.connection.on("state", (state) => this.emit("state", state));
    this.connection.on("error", (error) => this.emit("error", error));
  }

  get deviceId(): string {
    return this.config.deviceId;
  }

  get auditoriumId(): string | undefined {
    return this.config.auditoriumId;
  }

  get state(): GdcConnectionState {
    return this.connection.currentState;
  }

  connect(): Promise<void> {
    return this.connection.connect();
  }

  disconnect(): Promise<void> {
    return this.connection.disconnect();
  }

  heartbeat() {
    return this.sdk.heartbeat();
  }

  getSupportedCommands(): Promise<string[]> {
    return this.sdk.getSupportedCommands();
  }

  getAutomationLabels(): Promise<string[]> {
    return this.sdk.getAutomationLabels();
  }

  getEventLogs(input: GdcEventLogInput): Promise<GdcEventLogResult> {
    return this.sdk.getEventLogs(input);
  }

  triggerAutomation(input: GdcTriggerAutomationInput) {
    return this.sdk.triggerAutomation(input);
  }

  getServerInfo(): Promise<GdcServerInfo> {
    return this.sdk.getServerInfo();
  }

  getCplList(options?: GdcCplListOptions): Promise<GdcCplSummary[]> {
    return this.sdk.getCplList(options);
  }

  getCpl(cplUuid: string): Promise<GdcCplDetail> {
    return this.sdk.getCpl(cplUuid);
  }

  getKdmList(): Promise<GdcKdmSummary[]> {
    return this.sdk.getKdmList();
  }

  getKdm(assetUuid: string): Promise<GdcKdmDetail> {
    return this.sdk.getKdm(assetUuid);
  }

  deleteFile(assetUuid: string) {
    return this.sdk.deleteFile(assetUuid);
  }

  deleteContent(assetUuid: string) {
    return this.sdk.deleteContent(assetUuid);
  }

  ingestFile(input: GdcIngestFileInput): Promise<GdcIngestFileResult> {
    return this.sdk.ingestFile(input);
  }

  ingestContent(input: GdcIngestContentInput): Promise<GdcIngestFileResult> {
    return this.sdk.ingestContent(input);
  }

  getIngestStatus(ingestUuid: string): Promise<GdcIngestStatus> {
    return this.sdk.getIngestStatus(ingestUuid);
  }

  getIngestList(): Promise<GdcIngestListItem[]> {
    return this.sdk.getIngestList();
  }

  cancelIngest(ingestUuid: string) {
    return this.sdk.cancelIngest(ingestUuid);
  }

  getPlaybackStatus(): Promise<GdcPlaybackStatus> {
    return this.sdk.getPlaybackStatus();
  }

  loadShow(showUuid: string) {
    return this.sdk.loadShow(showUuid);
  }

  clearShow() {
    return this.sdk.clearShow();
  }

  playShow() {
    return this.sdk.playShow();
  }

  pausePlayback() {
    return this.sdk.pausePlayback();
  }

  unpausePlayback() {
    return this.sdk.unpausePlayback();
  }

  stopPlayback() {
    return this.sdk.stopPlayback();
  }

  movePlayback(input: GdcMovePlaybackInput) {
    return this.sdk.movePlayback(input);
  }

  skipForward() {
    return this.sdk.skipForward();
  }

  skipBackward() {
    return this.sdk.skipBackward();
  }

  getSchedules(): Promise<GdcScheduleSummary[]> {
    return this.sdk.getSchedules();
  }

  getSchedule(scheduleUuid: string): Promise<GdcScheduleSummary | undefined> {
    return this.sdk.getSchedule(scheduleUuid);
  }

  getCurrentSchedule(): Promise<GdcScheduleSummary | undefined> {
    return this.sdk.getCurrentSchedule();
  }

  getNextSchedule(): Promise<GdcScheduleSummary | undefined> {
    return this.sdk.getNextSchedule();
  }

  putSchedule(input: GdcPutScheduleInput): Promise<GdcPutScheduleResult> {
    return this.sdk.putSchedule(input);
  }

  cancelSchedule(scheduleUuid: string) {
    return this.sdk.cancelSchedule(scheduleUuid);
  }

  enableScheduler() {
    return this.sdk.enableScheduler();
  }

  disableScheduler() {
    return this.sdk.disableScheduler();
  }

  validateCpl(cplUuid: string): Promise<GdcValidateCplResult> {
    return this.sdk.validateCpl(cplUuid);
  }

  getServerDateTime(): Promise<GdcServerDateTime> {
    return this.sdk.getServerDateTime();
  }

  getStorageInfo(): Promise<GdcStorageInfo> {
    return this.sdk.getStorageInfo();
  }

  getTimezoneInfo(): Promise<GdcTimezoneInfo> {
    return this.sdk.getTimezoneInfo();
  }

  getServerIpList(): Promise<GdcServerIpList> {
    return this.sdk.getServerIpList();
  }

  getSchedulerStatus(): Promise<GdcSchedulerStatus> {
    return this.sdk.getSchedulerStatus();
  }

  getProjectorStatus(): Promise<GdcProjectorStatus> {
    return this.sdk.getProjectorStatus();
  }

  getServerSnapshot(): Promise<GdcServerSnapshot> {
    return this.sdk.getServerSnapshot();
  }

  getShowList(): Promise<GdcShowSummary[]> {
    return this.sdk.getShowList();
  }

  getShow(showUuid: string): Promise<GdcShowDetail> {
    return this.sdk.getShow(showUuid);
  }

  putShow(input: GdcPutShowInput): Promise<GdcPutShowResult> {
    return this.sdk.putShow(input);
  }

  deleteShow(showUuid: string) {
    return this.sdk.deleteShow(showUuid);
  }

  validateShow(showUuid: string): Promise<GdcValidateShowResult> {
    return this.sdk.validateShow(showUuid);
  }
}
