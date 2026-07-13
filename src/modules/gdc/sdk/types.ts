export interface GdcServerInfo {
  readonly model?: string;
  readonly serial?: string;
  readonly serverTime?: string;
  readonly version?: {
    readonly os?: string;
    readonly software?: string;
    readonly firmware?: string;
  };
}

export interface GdcServerDateTime {
  readonly isoDateTime?: string;
}

export interface GdcStorageInfo {
  readonly totalSpace?: number;
  readonly freeSpace?: number;
  readonly usedSpace?: number;
}

export interface GdcTimezoneInfo {
  readonly timezone?: string;
}

export interface GdcServerIpList {
  readonly ipAddresses: string[];
}

export interface GdcSchedulerStatus {
  readonly enabled: boolean;
}

export interface GdcProjectorStatusEntry {
  readonly raw: string;
}

export interface GdcProjectorStatus {
  readonly connectionState: "Connected" | "Disconnected" | "Unknown";
  readonly rawConnectionState?: string;
  readonly entries: GdcProjectorStatusEntry[];
}

export interface GdcIngestListItem {
  readonly ingestUuid: string;
}

export interface GdcIngestErrorItem {
  readonly assetUri?: string;
  readonly code?: string;
  readonly assetUuid?: string;
  readonly description?: string;
}

export interface GdcIngestStatus {
  readonly ingestUuid?: string;
  readonly assetUuid?: string;
  readonly assetType?: string;
  readonly assetUri?: string;
  readonly status?: string;
  readonly scheduleDateTime?: string;
  readonly transferredSize?: number;
  readonly totalSize?: number;
  readonly description?: string;
  readonly errorList: GdcIngestErrorItem[];
  readonly warningList: GdcIngestErrorItem[];
  readonly rawXml: string;
}

export interface GdcIngestFileInput {
  readonly source: string;
  readonly path?: string;
  readonly assetType?: string;
  readonly fileType?: string;
  readonly username?: string;
  readonly password?: string;
}

export interface GdcIngestContentInput {
  readonly source: string;
  readonly path: string;
  readonly assetUuid: string;
  readonly assetType: string;
  readonly username?: string;
  readonly password?: string;
}

export interface GdcIngestFileResult {
  readonly ingestUuid: string;
  readonly rawXml: string;
}

export interface GdcEventLogInput {
  readonly date: string;
}

export interface GdcEventLogEntry {
  readonly date: string;
  readonly time?: string;
  readonly type?: string;
  readonly status?: string;
  readonly annotation?: string;
  readonly contentName?: string;
  readonly contentUuid?: string;
  readonly contentVersionId?: string;
  readonly cplIndex?: number;
  readonly cplDuration?: number;
  readonly reelIndex?: number;
  readonly splUuid?: string;
  readonly kdmUuid?: string;
  readonly performanceUuid?: string;
  readonly attributes: Record<string, string>;
  readonly detailsXml?: string;
  readonly rawXml: string;
}

export interface GdcEventLogResult {
  readonly date: string;
  readonly entries: GdcEventLogEntry[];
  readonly rawXml: string;
}

export interface GdcTriggerAutomationInput {
  readonly eventLabel: string;
}

export interface GdcScheduleSummary {
  readonly scheduleUuid: string;
  readonly showContentVersionId?: string;
  readonly showContentVerId?: string;
  readonly playlistDuration?: number;
  readonly isoDateTime?: string;
}

export interface GdcPutScheduleInput {
  readonly showUuid: string;
  readonly showContentVersionId: string;
  readonly isoDateTime: string;
}

export interface GdcPutScheduleResult {
  readonly scheduleUuid: string;
  readonly showContentVersionId: string;
  readonly isoDateTime: string;
}

export interface GdcPlaybackPosition {
  readonly totalDuration?: number;
  readonly playedDuration?: number;
  readonly cplIndex?: number;
  readonly storage?: string;
}

export interface GdcPlaybackStatus {
  readonly state?: string;
  readonly seqStateForSyncMode?: string;
  readonly showUuid?: string;
  readonly showName?: string;
  readonly showPosition?: GdcPlaybackPosition;
  readonly cplUuid?: string;
  readonly cplName?: string;
  readonly cplPosition?: GdcPlaybackPosition;
}

export interface GdcMovePlaybackInput {
  readonly absolute?: string;
  readonly offset?: number;
}

export interface GdcServerSnapshot {
  readonly serverInfo: GdcServerInfo;
  readonly dateTime: GdcServerDateTime;
  readonly storageInfo: GdcStorageInfo;
  readonly timezoneInfo: GdcTimezoneInfo;
  readonly ipList: GdcServerIpList;
  readonly projectorStatus: GdcProjectorStatus;
  readonly schedulerStatus: GdcSchedulerStatus;
}

export interface GdcXmlCommandOptions {
  readonly commandName: string;
  readonly innerXml?: string;
  readonly version?: string;
}

export interface GdcShowSummary {
  readonly showUuid: string;
}

export interface GdcCplListOptions {
  readonly listAll?: boolean;
  readonly storage?: "all" | "primary";
}

export interface GdcCplSummary {
  readonly cplUuid: string;
  readonly ingestDateTime?: string;
}

export interface GdcCplDetail {
  readonly cplUuid?: string;
  readonly annotationText?: string;
  readonly issueDate?: string;
  readonly issuer?: string;
  readonly creator?: string;
  readonly contentTitleText?: string;
  readonly contentKind?: string;
  readonly durationSeconds?: number;
  readonly durationFrames?: number;
  readonly editRate?: string;
  readonly isStereoscopic?: boolean;
  readonly resolutionLabel?: "2K" | "4K";
  readonly pictureWidth?: number;
  readonly pictureHeight?: number;
  readonly screenAspectRatio?: string;
  readonly aspectRatioLabel?: string;
  readonly formatTags?: readonly string[];
  readonly rawCplXml: string;
}

export interface GdcValidateCplResult {
  readonly ok: boolean;
  readonly rawXml: string;
}

export interface GdcKdmSummary {
  readonly assetUuid: string;
}

export interface GdcKdmDetail {
  readonly assetUuid?: string;
  readonly messageType?: string;
  readonly annotationText?: string;
  readonly issueDate?: string;
  readonly compositionPlaylistId?: string;
  readonly contentTitleText?: string;
  readonly validBefore?: string;
  readonly validAfter?: string;
  readonly rawKdmXml: string;
}

export interface GdcShowDetail {
  readonly showUuid?: string;
  readonly title?: string;
  readonly issueDate?: string;
  readonly issuer?: string;
  readonly creator?: string;
  readonly contentVersionId?: string;
  readonly playlistPackId?: string;
  readonly playCount?: number;
  readonly cplUuids: string[];
  readonly preShowCommands?: readonly GdcShowPlaylistCommand[];
  readonly segments?: readonly GdcShowPlaylistSegment[];
  readonly rawShowXml: string;
}

export interface GdcShowPlaylistCommand {
  readonly markerUuid?: string;
  readonly label: string;
  readonly annotationText?: string;
  readonly offsetFrames?: number;
  readonly editRate?: string;
}

export interface GdcShowPlaylistSegment {
  readonly cplUuid: string;
  readonly commands?: readonly GdcShowPlaylistCommand[];
}

export interface GdcPutShowInput {
  readonly title: string;
  readonly cplUuids?: readonly string[];
  readonly showUuid?: string;
  readonly contentVersionId?: string;
  readonly playlistPackId?: string;
  readonly preShowCommands?: readonly GdcShowPlaylistCommand[];
  readonly segments?: readonly GdcShowPlaylistSegment[];
  readonly issuer?: string;
  readonly creator?: string;
  readonly playCount?: number;
}

export interface GdcPutShowResult {
  readonly showUuid: string;
  readonly contentVersionId: string;
  readonly showXml: string;
}

export interface GdcValidateShowResult {
  readonly ok: boolean;
  readonly rawXml: string;
}
