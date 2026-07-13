import {
  type GdcIngestFileInput,
  type GdcIngestContentInput,
  type GdcEventLogResult,
  type GdcIngestFileResult,
  type GdcIngestStatus,
  type GdcKdmDetail,
  GdcClientManager,
  type GdcCplDetail,
  type GdcMovePlaybackInput,
  type GdcPutShowInput,
  type GdcPutShowResult,
  type GdcShowDetail,
  type GdcShowPlaylistCommand,
  type GdcShowPlaylistSegment,
  type GdcShowSummary,
  type GdcScheduleSummary,
  type GdcValidateCplResult,
  type GdcValidateShowResult,
} from "../modules/gdc";
import {
  GdcHallCommandGateway,
  HallCommandService,
  HallRuntimePoller,
  HallRuntimeRegistry,
  type HallDeviceEvent,
  type HallRuntimeRecord,
  type HallRuntimeSection,
  type HallRuntimeSnapshot,
} from "../runtime";
import {
  persistRuntimeEvent,
  persistRuntimeSnapshot,
  readPersistedRuntimeEvents,
  readPersistedRuntimeSnapshots,
} from "./runtime-store";
import { getNotificationService } from "./notification-service";
import { readConfiguredHalls } from "./setup-store";

const HOT_POLL_MS = 5_000;
const STATIC_POLL_MS = 30 * 60_000;
const OFFLINE_POLL_MS = 60_000;
const SHOW_INSPECTION_CACHE_TTL_MS = 30_000;

type HallSchedulerTask = {
  timer: NodeJS.Timeout | null;
  running: boolean;
};

export interface RuntimeShowSummary extends GdcShowSummary {
  readonly title?: string;
  readonly cplCount: number;
}

export interface RuntimeShowCplRecord {
  readonly index: number;
  readonly cplUuid: string;
  readonly annotationText?: string;
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
  readonly validation: GdcValidateCplResult;
}

export interface RuntimeShowInspection {
  readonly showUuid: string;
  readonly title?: string;
  readonly cpls: RuntimeShowCplRecord[];
  readonly allValid: boolean;
}

export interface RuntimeCplCatalogItem extends GdcCplDetail {
  readonly ingestDateTime?: string;
}

export interface RuntimeShowEditorDetail extends GdcShowDetail {
  readonly segmentDetails: RuntimeShowCplRecord[];
}

export interface RuntimeShowCopyCheck {
  readonly sourceHallId: string;
  readonly targetHallId: string;
  readonly showUuid: string;
  readonly title?: string;
  readonly nameConflict: boolean;
  readonly conflictingShows: RuntimeShowSummary[];
  readonly missingCpls: RuntimeShowCopyMissingCpl[];
  readonly missingCommands: string[];
  readonly canImport: boolean;
}

export interface RuntimeShowCopyMissingCpl {
  readonly cplUuid: string;
  readonly title?: string;
}

export interface RuntimeDcpImportProbe {
  readonly storageInfo?: import("../modules/gdc").GdcStorageInfo;
  readonly cplUuids: string[];
}

export interface RuntimeShowRecoverySnapshot {
  readonly title: string;
  readonly segments: readonly GdcShowPlaylistSegment[];
  readonly issuer?: string;
  readonly creator?: string;
  readonly playCount?: number;
}

export interface RuntimeKdmRecord extends GdcKdmDetail {
  readonly assetUuid: string;
  readonly error?: string;
}

export class TmsRuntimeService {
  readonly registry = new HallRuntimeRegistry();
  readonly clientManager = new GdcClientManager();
  readonly gateway = new GdcHallCommandGateway(this.registry, this.clientManager);
  readonly commandService = new HallCommandService(this.registry, this.gateway);

  private readonly poller = new HallRuntimePoller(this.registry, this.clientManager);
  private readonly showInspectionCache = new Map<string, { inspection: RuntimeShowInspection; expiresAt: number }>();
  private readonly hallSchedulers = new Map<string, HallSchedulerTask>();
  private started = false;
  private persistedStateHydrated = false;

  constructor() {
    this.registry.on("snapshot", (record) => {
      void persistRuntimeSnapshot(record).catch((error) => {
        console.error("Failed to persist runtime snapshot:", error);
      });
    });

    this.registry.on("event", (event) => {
      void persistRuntimeEvent(event).catch((error) => {
        console.error("Failed to persist runtime event:", error);
      });
      void getNotificationService().ingestRuntimeEvent(event).catch((error) => {
        console.error("Failed to create notification from runtime event:", error);
      });
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    await this.reloadConfiguredHalls().catch((error) => {
      console.error("Failed to load configured hall runtimes:", error);
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.clearAllHallSchedulers();

    await this.clientManager.disconnectAll();
  }

  async reloadConfiguredHalls(): Promise<HallRuntimeRecord[]> {
    const halls = await readConfiguredHalls().catch(() => []);
    const persistedSnapshots = await readPersistedRuntimeSnapshots().catch(() => []);
    const persistedEvents = this.persistedStateHydrated ? [] : await readPersistedRuntimeEvents().catch(() => []);
    const persistedSnapshotByHallId = new Map(
      persistedSnapshots.map((snapshot) => [snapshot.hallId, snapshot]),
    );
    const activeHallIds = new Set<string>();

    for (const hall of halls) {
      if (!hall.host || !hall.port) {
        continue;
      }

      activeHallIds.add(hall.id);
      this.registry.upsertRuntime({
        hallId: hall.id,
        hallName: hall.name,
        deviceId: `${hall.id}-gdc`,
        auditoriumId: hall.id,
        host: hall.host,
        port: Number(hall.port),
        profile: "gdc",
      });

      const persistedSnapshot = persistedSnapshotByHallId.get(hall.id);
      if (persistedSnapshot) {
        this.registry.replaceSnapshot(
          hall.id,
          this.normalizePersistedSnapshot(persistedSnapshot, hall.id, `${hall.id}-gdc`),
        );
      }
    }

    for (const runtime of this.registry.listRuntimes()) {
      if (!activeHallIds.has(runtime.registration.hallId)) {
        this.clearHallScheduler(runtime.registration.hallId);
        this.registry.removeRuntime(runtime.registration.hallId);
      }
    }

    if (!this.persistedStateHydrated) {
      for (const event of persistedEvents) {
        if (activeHallIds.has(event.hallId)) {
          this.registry.seedEvent(event);
        }
      }

      this.persistedStateHydrated = true;
    }

    if (activeHallIds.size > 0) {
      await this.poller
        .pollAll({
          sections: ["connectivity", "serverInfo", "automation", "playback", "ingest"],
        })
        .catch((error) => {
          console.error("Initial runtime poll failed:", error);
        });
    }

    if (this.started) {
      for (const hallId of activeHallIds) {
        this.ensureHallScheduler(hallId);
      }
    }

    return this.registry.listRuntimes();
  }

  listRuntimeRecords(): HallRuntimeRecord[] {
    return this.registry.listRuntimes();
  }

  getRuntimeRecord(hallId: string): HallRuntimeRecord | undefined {
    return this.registry.getRuntime(hallId);
  }

  listEvents(hallId?: string): HallDeviceEvent[] {
    return this.registry.listEvents(hallId ? { hallIds: [hallId] } : undefined);
  }

  async refreshHall(
    hallId: string,
    sections: readonly HallRuntimeSection[] = ["connectivity", "serverInfo", "automation", "playback", "ingest"],
  ): Promise<HallRuntimeRecord> {
    await this.poller.pollHall(hallId, { sections, force: true });
    this.scheduleNextHallPoll(hallId, this.computeNextPollDelay(this.registry.getRuntimeOrThrow(hallId).snapshot));
    return this.registry.getRuntimeOrThrow(hallId);
  }

  async listShows(hallId: string): Promise<RuntimeShowSummary[]> {
    this.assertHallDeviceReachable(hallId, "无法读取放映表");
    const client = this.resolveClient(hallId);
    const shows = await client.getShowList();
    const detailedShows = await Promise.all(
      shows.map(async (show) => {
        const detail = await this.getShowDetail(client, show.showUuid);
        return {
          ...show,
          title: detail.title,
          cplCount: detail.cplUuids.length,
        };
      }),
    );

    return detailedShows;
  }

  async listCpls(hallId: string): Promise<RuntimeCplCatalogItem[]> {
    this.assertHallDeviceReachable(hallId, "无法读取 CPL 列表");
    const client = this.resolveClient(hallId);
    const cpls = await client.getCplList({ listAll: false, storage: "all" });

    return Promise.all(
      cpls.map(async (cpl) => {
        const detail = await client.getCpl(cpl.cplUuid).catch(() => ({
          cplUuid: cpl.cplUuid,
          rawCplXml: "",
        } as GdcCplDetail));
        return {
          ...detail,
          cplUuid: detail.cplUuid ?? cpl.cplUuid,
          ingestDateTime: cpl.ingestDateTime,
        };
      }),
    );
  }

  async listCplUuids(hallId: string): Promise<string[]> {
    this.assertHallDeviceReachable(hallId, "无法读取 CPL 列表");
    const client = this.resolveClient(hallId);
    const cpls = await client.getCplList({ listAll: false, storage: "all" });
    return cpls.map((cpl) => cpl.cplUuid).filter(Boolean);
  }

  async listDeviceSchedules(hallId: string): Promise<GdcScheduleSummary[]> {
    this.assertHallDeviceReachable(hallId, "无法读取 GDC 排期");
    const client = this.resolveClient(hallId);
    return client.getSchedules();
  }

  async probeDcpImportReadiness(hallId: string): Promise<RuntimeDcpImportProbe> {
    const client = this.resolveClient(hallId);
    const [storageInfo, cpls] = await Promise.all([
      client.getStorageInfo(),
      client.getCplList({ listAll: false, storage: "all" }),
    ]);
    return {
      storageInfo,
      cplUuids: cpls.map((cpl) => cpl.cplUuid).filter(Boolean),
    };
  }

  async getShowForEditor(hallId: string, showUuid: string): Promise<RuntimeShowEditorDetail> {
    this.assertHallDeviceReachable(hallId, "无法读取播放表");
    const client = this.resolveClient(hallId);
    const detail = await client.getShow(showUuid);
    const segmentDetails = await Promise.all(
      this.normalizeShowSegments(detail).map(async (segment, index) => {
        const [cplDetail, validation] = await Promise.all([
          client.getCpl(segment.cplUuid).catch(() => ({ cplUuid: segment.cplUuid, rawCplXml: "" } as GdcCplDetail)),
          client.validateCpl(segment.cplUuid),
        ]);

        return {
          index,
          cplUuid: segment.cplUuid,
          annotationText: cplDetail.annotationText,
          contentTitleText: cplDetail.contentTitleText,
          contentKind: cplDetail.contentKind,
          durationSeconds: cplDetail.durationSeconds,
          durationFrames: cplDetail.durationFrames,
          editRate: cplDetail.editRate,
          isStereoscopic: cplDetail.isStereoscopic,
          resolutionLabel: cplDetail.resolutionLabel,
          pictureWidth: cplDetail.pictureWidth,
          pictureHeight: cplDetail.pictureHeight,
          screenAspectRatio: cplDetail.screenAspectRatio,
          aspectRatioLabel: cplDetail.aspectRatioLabel,
          formatTags: cplDetail.formatTags,
          validation,
        };
      }),
    );

    return {
      ...detail,
      segmentDetails,
    };
  }

  async saveShow(hallId: string, input: GdcPutShowInput): Promise<GdcPutShowResult> {
    this.assertHallDeviceReachable(hallId, "无法保存播放表");
    const client = this.resolveClient(hallId);
    const normalizedInput = await this.normalizeShowCommandOffsets(client, input);
    const result = await client.putShow(normalizedInput);
    this.showInspectionCache.clear();
    return result;
  }

  async checkShowCopy(
    sourceHallId: string,
    showUuid: string,
    targetHallId: string,
  ): Promise<RuntimeShowCopyCheck> {
    if (sourceHallId === targetHallId) {
      throw new Error("请选择其它影厅作为目标影厅。");
    }

    const sourceShow = await this.getShowForEditor(sourceHallId, showUuid);
    const targetShows = await this.listShows(targetHallId);
    const title = sourceShow.title || "";
    const conflictingShows = title
      ? targetShows.filter((show) => (show.title || "").trim() === title.trim())
      : [];

    this.assertHallDeviceReachable(targetHallId, "无法读取目标影厅 CPL 列表");
    const targetClient = this.resolveClient(targetHallId);
    const targetCplUuids = new Set(
      (await targetClient.getCplList({ listAll: false, storage: "all" })).map((cpl) => cpl.cplUuid),
    );
    const sourceSegments = this.normalizeShowSegments(sourceShow);
    const missingCpls = uniqueBy(
      sourceSegments
        .filter((segment) => !targetCplUuids.has(segment.cplUuid))
        .map((segment) => ({
          cplUuid: segment.cplUuid,
          title: sourceShow.segmentDetails.find((detail) => detail.cplUuid === segment.cplUuid)?.contentTitleText
            || sourceShow.segmentDetails.find((detail) => detail.cplUuid === segment.cplUuid)?.annotationText,
        })),
      (item) => item.cplUuid,
    );

    const targetCommands = new Set(await this.listAutomationLabels(targetHallId, { force: true }));
    const sourceCommands = uniqueStrings(
      sourceSegments.flatMap((segment) => (segment.commands || []).map((command) => command.label)),
    );
    const missingCommands = sourceCommands.filter((label) => !targetCommands.has(label));

    return {
      sourceHallId,
      targetHallId,
      showUuid,
      title,
      nameConflict: conflictingShows.length > 0,
      conflictingShows,
      missingCpls,
      missingCommands,
      canImport: conflictingShows.length === 0 && missingCpls.length === 0 && missingCommands.length === 0,
    };
  }

  async copyShowToHall(
    sourceHallId: string,
    showUuid: string,
    targetHallId: string,
  ): Promise<GdcPutShowResult> {
    const check = await this.checkShowCopy(sourceHallId, showUuid, targetHallId);
    if (!check.canImport) {
      throw new Error("目标影厅缺少必要内容或存在同名放映表，无法导入。");
    }

    const sourceShow = await this.getShowForEditor(sourceHallId, showUuid);
    return this.saveShow(targetHallId, {
      title: sourceShow.title || "UNTITLED",
      issuer: sourceShow.issuer || "GDC",
      creator: sourceShow.creator || "SMS",
      playCount: sourceShow.playCount || 1,
      preShowCommands: sourceShow.preShowCommands || [],
      segments: this.normalizeShowSegments(sourceShow),
    });
  }

  async deleteShow(hallId: string, showUuid: string): Promise<void> {
    this.assertHallDeviceReachable(hallId, "无法删除播放表");
    const client = this.resolveClient(hallId);
    await client.deleteShow(showUuid);
    this.showInspectionCache.delete(this.buildShowInspectionCacheKey(hallId, showUuid));
  }

  async validateShow(hallId: string, showUuid: string): Promise<GdcValidateShowResult> {
    this.assertHallDeviceReachable(hallId, "无法校验播放表");
    const client = this.resolveClient(hallId);
    return client.validateShow(showUuid);
  }

  async findEquivalentShowFromSnapshot(
    hallId: string,
    snapshot: unknown,
  ): Promise<GdcShowDetail | undefined> {
    const expected = this.readShowRecoverySnapshot(snapshot, hallId);
    if (!expected) {
      return undefined;
    }

    this.assertHallDeviceReachable(hallId, "无法自动修正播放表");
    const client = this.resolveClient(hallId);
    const normalizedExpected = await this.normalizeRecoverySnapshotCommandOffsets(client, expected);
    const shows = await client.getShowList();
    const matches: GdcShowDetail[] = [];

    for (const show of shows) {
      const detail = await client.getShow(show.showUuid).catch(() => undefined);
      if (!detail) {
        continue;
      }

      if (this.isShowEquivalentToSnapshot(detail, normalizedExpected)) {
        matches.push(detail);
      }
    }

    return matches.length === 1 ? matches[0] : undefined;
  }

  async createTemporaryShowFromSnapshot(
    hallId: string,
    snapshot: unknown,
  ): Promise<GdcPutShowResult> {
    const expected = this.readShowRecoverySnapshot(snapshot, hallId);
    if (!expected) {
      throw new Error("播放表快照不完整，无法创建临时播放表。");
    }

    this.assertHallDeviceReachable(hallId, "无法创建临时播放表");
    const client = this.resolveClient(hallId);
    const [validations, automationLabels] = await Promise.all([
      Promise.all(expected.segments.map((segment) => client.validateCpl(segment.cplUuid))),
      this.listAutomationLabels(hallId, { force: true }),
    ]);

    if (validations.some((validation) => !validation.ok)) {
      throw new Error("播放表快照中的 CPL 未通过校验，无法创建临时播放表。");
    }

    const availableLabels = new Set(automationLabels);
    const missingCommands = uniqueStrings(
      expected.segments
        .flatMap((segment) => segment.commands || [])
        .map((command) => command.label)
        .filter((label) => label && !availableLabels.has(label)),
    );
    if (missingCommands.length > 0) {
      throw new Error(`播放表快照中的自动化命令不可用：${missingCommands.join("、")}`);
    }

    const titleSuffix = formatTemporaryShowTimestamp(new Date());
    const result = await client.putShow(await this.normalizeShowCommandOffsets(client, {
      title: `${expected.title || "TEMP_SHOW"} TEMP ${titleSuffix}`,
      issuer: expected.issuer || "GDC",
      creator: expected.creator || "SMS",
      playCount: expected.playCount || 1,
      segments: expected.segments,
    }));
    this.showInspectionCache.clear();
    return result;
  }

  async ingestFile(hallId: string, input: GdcIngestFileInput): Promise<GdcIngestFileResult> {
    const client = this.resolveClient(hallId);
    const result = await client.ingestFile(input);
    await this.poller.pollHall(hallId, { sections: ["ingest"], force: true }).catch(() => undefined);
    return result;
  }

  async ingestContent(hallId: string, input: GdcIngestContentInput): Promise<GdcIngestFileResult> {
    this.assertHallDeviceReachable(hallId, "无法导入 DCP 内容");
    const client = this.resolveClient(hallId);
    const result = await client.ingestContent(input);
    await this.poller.pollHall(hallId, { sections: ["ingest"], force: true }).catch(() => undefined);
    return result;
  }

  async listKdmAssetUuids(hallId: string): Promise<string[]> {
    this.assertHallDeviceReachable(hallId, "无法读取 KDM 列表");
    const client = this.resolveClient(hallId);
    const kdms = await client.getKdmList();
    return kdms.map((kdm) => kdm.assetUuid).filter(Boolean);
  }

  async listKdmDetails(hallId: string): Promise<RuntimeKdmRecord[]> {
    this.assertHallDeviceReachable(hallId, "无法读取 KDM 列表");
    const client = this.resolveClient(hallId);
    const kdms = await client.getKdmList();

    return Promise.all(
      kdms
        .map((kdm) => kdm.assetUuid)
        .filter(Boolean)
        .map(async (assetUuid) => {
          try {
            const detail = await client.getKdm(assetUuid);
            return {
              ...detail,
              assetUuid: detail.assetUuid || assetUuid,
            };
          } catch (error) {
            return {
              assetUuid,
              rawKdmXml: "",
              error: error instanceof Error ? error.message : "读取 KDM 明细失败。",
            };
          }
        }),
    );
  }

  async deleteKdmFromDevice(hallId: string, assetUuid: string): Promise<void> {
    this.assertHallDeviceReachable(hallId, "无法删除设备内 KDM");
    const client = this.resolveClient(hallId);
    const normalizedUuid = assetUuid.startsWith("urn:uuid:") ? assetUuid : `urn:uuid:${assetUuid}`;
    await client.deleteFile(normalizedUuid);
  }

  async deleteCplContentFromDevice(hallId: string, cplUuid: string): Promise<void> {
    this.assertHallDeviceReachable(hallId, "无法删除设备内 CPL");
    const client = this.resolveClient(hallId);
    const normalizedUuid = cplUuid.startsWith("urn:uuid:") ? cplUuid : `urn:uuid:${cplUuid}`;
    await client.deleteContent(normalizedUuid);
    await this.poller.pollHall(hallId, { sections: ["serverInfo", "ingest"], force: true }).catch(() => undefined);
  }

  async getIngestStatus(hallId: string, ingestUuid: string): Promise<GdcIngestStatus> {
    this.assertHallDeviceReachable(hallId, "无法读取摄取任务状态");
    const client = this.resolveClient(hallId);
    return client.getIngestStatus(ingestUuid);
  }

  async listIngestUuids(hallId: string): Promise<string[]> {
    this.assertHallDeviceReachable(hallId, "无法读取摄取任务列表");
    const client = this.resolveClient(hallId);
    const ingests = await client.getIngestList();
    return ingests.map((item) => item.ingestUuid).filter(Boolean);
  }

  async cancelIngest(hallId: string, ingestUuid: string): Promise<void> {
    this.assertHallDeviceReachable(hallId, "无法取消摄取任务");
    const client = this.resolveClient(hallId);
    await client.cancelIngest(ingestUuid);
    await this.poller.pollHall(hallId, { sections: ["ingest"], force: true }).catch(() => undefined);
  }

  async inspectShow(
    hallId: string,
    showUuid: string,
    options: { force?: boolean } = {},
  ): Promise<RuntimeShowInspection> {
    const cacheKey = this.buildShowInspectionCacheKey(hallId, showUuid);
    const cached = this.showInspectionCache.get(cacheKey);
    if (!options.force && cached && cached.expiresAt > Date.now()) {
      return cached.inspection;
    }

    this.assertHallDeviceReachable(hallId, "无法读取 CPL 列表");
    const client = this.resolveClient(hallId);
    const detail = await this.getShowDetail(client, showUuid);
    const cpls = await Promise.all(
      detail.cplUuids.map(async (cplUuid, index) => {
        const [cplDetail, validation] = await Promise.all([
          client.getCpl(cplUuid).catch(() => ({ cplUuid, rawCplXml: "" } as GdcCplDetail)),
          client.validateCpl(cplUuid),
        ]);

        return {
          index,
          cplUuid,
          annotationText: cplDetail.annotationText,
          contentTitleText: cplDetail.contentTitleText,
          contentKind: cplDetail.contentKind,
          durationSeconds: cplDetail.durationSeconds,
          durationFrames: cplDetail.durationFrames,
          editRate: cplDetail.editRate,
          isStereoscopic: cplDetail.isStereoscopic,
          resolutionLabel: cplDetail.resolutionLabel,
          pictureWidth: cplDetail.pictureWidth,
          pictureHeight: cplDetail.pictureHeight,
          screenAspectRatio: cplDetail.screenAspectRatio,
          aspectRatioLabel: cplDetail.aspectRatioLabel,
          formatTags: cplDetail.formatTags,
          validation,
        };
      }),
    );

    const inspection = {
      showUuid,
      title: detail.title,
      cpls,
      allValid: cpls.every((item) => item.validation.ok),
    };
    this.showInspectionCache.set(cacheKey, {
      inspection,
      expiresAt: Date.now() + SHOW_INSPECTION_CACHE_TTL_MS,
    });
    return inspection;
  }

  async loadShow(hallId: string, showUuid: string): Promise<void> {
    const inspection = await this.inspectShow(hallId, showUuid, { force: true });
    if (!inspection.allValid) {
      throw new Error("所选放映表存在未通过校验的 CPL，无法载入。");
    }

    const client = this.resolveClient(hallId);
    const playback = await client.getPlaybackStatus().catch(() => undefined);
    if (playback?.state === "PLAYING" || playback?.state === "PAUSED") {
      await this.commandService.stopPlayback(hallId).catch(() => undefined);
      await this.waitForPlaybackState(client, "STOPPED");
    }
    await client.clearShow().catch(() => undefined);
    await this.waitForShowCleared(client);
    await this.commandService.loadShow(hallId, showUuid);
    await this.refreshPlayback(hallId);
  }

  async play(hallId: string): Promise<void> {
    const runtime = this.registry.getRuntimeOrThrow(hallId);
    const currentShowUuid = runtime.snapshot.playback.status?.showUuid;
    if (!currentShowUuid) {
      throw new Error("当前没有已加载的放映表，无法直接播放。");
    }

    await this.commandService.playShow(hallId);
    await this.refreshPlayback(hallId);
  }

  async pause(hallId: string): Promise<void> {
    await this.commandService.pausePlayback(hallId);
    await this.refreshPlayback(hallId);
  }

  async resume(hallId: string): Promise<void> {
    await this.commandService.unpausePlayback(hallId);
    await this.refreshPlayback(hallId);
  }

  async stopPlayback(hallId: string): Promise<void> {
    await this.commandService.stopPlayback(hallId);
    await this.refreshPlayback(hallId);
  }

  async switchCpl(hallId: string, direction: "previous" | "next"): Promise<void> {
    await this.performPausedPlaybackTransition(hallId, async () => {
      if (direction === "previous") {
        await this.commandService.skipBackward(hallId);
      } else {
        await this.commandService.skipForward(hallId);
      }
    });
  }

  async movePlayback(hallId: string, input: GdcMovePlaybackInput): Promise<void> {
    await this.performPausedPlaybackTransition(hallId, async () => {
      await this.commandService.movePlayback(hallId, input);
    });
  }

  async listAutomationLabels(
    hallId: string,
    options: { force?: boolean } = {},
  ): Promise<string[]> {
    this.assertHallDeviceReachable(hallId, "无法读取自动化指令");
    const runtime = this.registry.getRuntimeOrThrow(hallId);
    const shouldRefresh =
      options.force
      || (!runtime.snapshot.automation.collectedAt && runtime.snapshot.automation.labels.length === 0);

    if (shouldRefresh) {
      await this.poller.pollHall(hallId, { sections: ["automation"], force: options.force });
    }

    return [...this.registry.getRuntimeOrThrow(hallId).snapshot.automation.labels];
  }

  async getEventLogs(hallId: string, date: string): Promise<GdcEventLogResult> {
    this.assertHallDeviceReachable(hallId, "无法读取 GDC 日志");
    const client = this.resolveClient(hallId);
    return client.getEventLogs({ date });
  }

  async triggerAutomation(hallId: string, eventLabel: string): Promise<void> {
    const normalizedEventLabel = eventLabel.trim();
    if (!normalizedEventLabel) {
      throw new Error("自动化指令不能为空。");
    }

    await this.commandService.triggerAutomation(hallId, normalizedEventLabel);
    await this.refreshPlayback(hallId);
  }

  private async performPausedPlaybackTransition(
    hallId: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const client = this.resolveClient(hallId);
    const playback = await client.getPlaybackStatus();
    const state = playback.state || "UNKNOWN";
    const shouldResume = state === "PLAYING";

    if (state === "PLAYING") {
      await this.commandService.pausePlayback(hallId);
      await this.waitForPlaybackState(client, "PAUSED");
    }

    await action();

    if (shouldResume) {
      const playbackAfterAction = await client.getPlaybackStatus().catch(() => undefined);
      if (playbackAfterAction?.state === "STOPPED") {
        await client.playShow().catch(() => undefined);
      } else {
        await this.commandService.unpausePlayback(hallId);
      }
      await this.waitForPlaybackState(client, "PLAYING");
    }

    await this.refreshPlayback(hallId);
  }

  private async waitForPlaybackState(
    client: ReturnType<TmsRuntimeService["resolveClient"]>,
    expectedState: string,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const playback = await client.getPlaybackStatus().catch(() => undefined);
      if (playback?.state === expectedState) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private async waitForShowCleared(
    client: ReturnType<TmsRuntimeService["resolveClient"]>,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const playback = await client.getPlaybackStatus().catch(() => undefined);
      if (
        !playback?.showUuid ||
        playback.showUuid === "urn:uuid:00000000-0000-0000-0000-000000000000"
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private async refreshPlayback(hallId: string): Promise<void> {
    await this.poller.pollHall(hallId, { sections: ["playback"] }).catch(() => undefined);
  }

  private resolveClient(hallId: string) {
    const runtime = this.registry.getRuntimeOrThrow(hallId);
    return this.clientManager.upsertClient({
      deviceId: runtime.registration.deviceId,
      auditoriumId: runtime.registration.auditoriumId,
      host: runtime.registration.host,
      port: runtime.registration.port,
    });
  }

  private async getShowDetail(client: ReturnType<TmsRuntimeService["resolveClient"]>, showUuid: string): Promise<GdcShowDetail> {
    return client
      .getShow(showUuid)
      .catch(() => ({ showUuid, cplUuids: [], rawShowXml: "" }));
  }

  private normalizeShowSegments(detail: GdcShowDetail): readonly GdcShowPlaylistSegment[] {
    if (detail.segments && detail.segments.length > 0) {
      return detail.segments;
    }

    return detail.cplUuids.map((cplUuid) => ({ cplUuid }));
  }

  private async normalizeShowCommandOffsets(
    client: ReturnType<TmsRuntimeService["resolveClient"]>,
    input: GdcPutShowInput,
  ): Promise<GdcPutShowInput> {
    if (!input.segments?.length) {
      return input;
    }

    const segments = await Promise.all(input.segments.map(async (segment) => {
      const cplDetail = await client.getCpl(segment.cplUuid).catch(() => undefined);
      const durationFrames = Number(cplDetail?.durationFrames);
      const maxOffsetFrames = Number.isFinite(durationFrames) && durationFrames > 0
        ? Math.max(0, Math.round(durationFrames) - 1)
        : undefined;

      return {
        ...segment,
        commands: segment.commands?.map((command) => {
          if (!Number.isFinite(command.offsetFrames)) {
            return command;
          }

          const roundedOffset = Math.max(0, Math.round(command.offsetFrames ?? 0));
          const offsetFrames = maxOffsetFrames === undefined
            ? roundedOffset
            : Math.min(roundedOffset, maxOffsetFrames);

          return {
            ...command,
            offsetFrames: offsetFrames > 0 ? offsetFrames : undefined,
          };
        }),
      };
    }));

    return {
      ...input,
      segments,
    };
  }

  private readShowRecoverySnapshot(snapshot: unknown, hallId: string): RuntimeShowRecoverySnapshot | undefined {
    const snapshotRecord = asRecordOrNull(snapshot);
    const details = Array.isArray(snapshotRecord?.details) ? snapshotRecord.details : [];
    const detail = details
      .map((item) => asRecordOrNull(item))
      .find((item): item is Record<string, unknown> => item?.hallId === hallId);
    if (!detail) {
      return undefined;
    }

    const title = typeof detail.title === "string" && detail.title.trim()
      ? detail.title.trim()
      : "TEMP_SHOW";
    const segments = Array.isArray(detail.segments)
      ? detail.segments.flatMap((item): GdcShowPlaylistSegment[] => {
        const segment = asRecordOrNull(item);
        const cplUuid = typeof segment?.cplUuid === "string" ? segment.cplUuid.trim() : "";
        if (!segment || !cplUuid) {
          return [];
        }

        const commands = Array.isArray(segment.commands)
          ? segment.commands.flatMap((command): GdcShowPlaylistCommand[] => {
            const record = asRecordOrNull(command);
            const label = typeof record?.label === "string" ? record.label.trim() : "";
            if (!record || !label) {
              return [];
            }
            return [{
              markerUuid: optionalString(record.markerUuid),
              label,
              annotationText: optionalString(record.annotationText),
              offsetFrames: optionalNumber(record.offsetFrames),
              editRate: optionalString(record.editRate),
            }];
          })
          : undefined;

        return [{
          cplUuid,
          commands,
        }];
      })
      : [];

    if (segments.length === 0) {
      return undefined;
    }

    return {
      title,
      segments,
      issuer: optionalString(detail.issuer),
      creator: optionalString(detail.creator),
      playCount: optionalNumber(detail.playCount),
    };
  }

  private isShowEquivalentToSnapshot(
    detail: GdcShowDetail,
    expected: RuntimeShowRecoverySnapshot,
  ): boolean {
    const actualSegments = this.normalizeShowSegments(detail);
    if (actualSegments.length !== expected.segments.length) {
      return false;
    }

    return actualSegments.every((segment, index) => (
      normalizeUrnUuidForCompare(segment.cplUuid) === normalizeUrnUuidForCompare(expected.segments[index].cplUuid)
      && areShowCommandsEquivalent(segment.commands || [], expected.segments[index].commands || [])
    ));
  }

  private async normalizeRecoverySnapshotCommandOffsets(
    client: ReturnType<TmsRuntimeService["resolveClient"]>,
    snapshot: RuntimeShowRecoverySnapshot,
  ): Promise<RuntimeShowRecoverySnapshot> {
    const normalized = await this.normalizeShowCommandOffsets(client, {
      title: snapshot.title,
      issuer: snapshot.issuer,
      creator: snapshot.creator,
      playCount: snapshot.playCount,
      segments: snapshot.segments,
    });

    return {
      ...snapshot,
      segments: normalized.segments || snapshot.segments,
    };
  }

  private buildShowInspectionCacheKey(hallId: string, showUuid: string): string {
    return `${hallId}::${showUuid}`;
  }

  private assertHallDeviceReachable(hallId: string, action: string): void {
    const runtime = this.registry.getRuntimeOrThrow(hallId);
    if (runtime.snapshot.connectivity.state !== "online") {
      throw new Error(`${action}：放映服务器当前不在线。`);
    }
  }

  private normalizePersistedSnapshot(
    snapshot: HallRuntimeSnapshot,
    hallId: string,
    deviceId: string,
  ): HallRuntimeSnapshot {
    const connectivity = normalizeConnectivitySnapshot(snapshot.connectivity);
    return {
      ...snapshot,
      hallId,
      deviceId,
      connectivity,
    };
  }

  private ensureHallScheduler(hallId: string): void {
    if (this.hallSchedulers.has(hallId)) {
      this.scheduleNextHallPoll(hallId, 0);
      return;
    }

    this.hallSchedulers.set(hallId, {
      timer: null,
      running: false,
    });
    this.scheduleNextHallPoll(hallId, 0);
  }

  private clearAllHallSchedulers(): void {
    for (const hallId of this.hallSchedulers.keys()) {
      this.clearHallScheduler(hallId);
    }
  }

  private clearHallScheduler(hallId: string): void {
    const task = this.hallSchedulers.get(hallId);
    if (!task) {
      return;
    }

    if (task.timer) {
      clearTimeout(task.timer);
    }

    this.hallSchedulers.delete(hallId);
  }

  private scheduleNextHallPoll(hallId: string, delayMs: number): void {
    const task = this.hallSchedulers.get(hallId);
    if (!task) {
      return;
    }

    if (task.timer) {
      clearTimeout(task.timer);
    }

    task.timer = setTimeout(() => {
      task.timer = null;
      void this.runHallPollCycle(hallId);
    }, Math.max(delayMs, 0));
    task.timer.unref?.();
  }

  private async runHallPollCycle(hallId: string): Promise<void> {
    const task = this.hallSchedulers.get(hallId);
    if (!task || task.running || !this.started) {
      return;
    }

    const runtime = this.registry.getRuntime(hallId);
    if (!runtime) {
      this.clearHallScheduler(hallId);
      return;
    }

    task.running = true;
    try {
      const sections = this.resolveScheduledSections(runtime.snapshot);
      await this.poller.pollHall(hallId, { sections });
    } catch (error) {
      console.error(`Runtime hall poll failed for ${hallId}:`, error);
    } finally {
      task.running = false;
      const nextRuntime = this.registry.getRuntime(hallId);
      if (!nextRuntime || !this.started) {
        return;
      }
      this.scheduleNextHallPoll(hallId, this.computeNextPollDelay(nextRuntime.snapshot));
    }
  }

  private resolveScheduledSections(snapshot: HallRuntimeSnapshot): readonly HallRuntimeSection[] {
    const sections = new Set<HallRuntimeSection>(["connectivity", "playback", "ingest"]);
    const shouldRefreshStatic =
      snapshot.connectivity.state !== "online"
      || this.isStaticSectionDue(snapshot.serverInfo?.collectedAt)
      || this.isStaticSectionDue(snapshot.automation?.collectedAt);

    if (shouldRefreshStatic) {
      sections.add("serverInfo");
      sections.add("automation");
    }

    return [...sections];
  }

  private isStaticSectionDue(collectedAt?: string): boolean {
    if (!collectedAt) {
      return true;
    }

    const collectedAtMs = Date.parse(collectedAt);
    if (Number.isNaN(collectedAtMs)) {
      return true;
    }

    return (Date.now() - collectedAtMs) >= STATIC_POLL_MS;
  }

  private computeNextPollDelay(snapshot: HallRuntimeSnapshot): number {
    const nextProbeAt = snapshot.connectivity.nextProbeAt ? Date.parse(snapshot.connectivity.nextProbeAt) : Number.NaN;
    switch (snapshot.connectivity.state) {
      case "online":
        return HOT_POLL_MS;
      case "offline":
        return Number.isNaN(nextProbeAt) ? OFFLINE_POLL_MS : Math.max(nextProbeAt - Date.now(), 0);
      default:
        return HOT_POLL_MS;
    }
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeUrnUuidForCompare(value: string | undefined): string {
  return String(value || "").trim().replace(/^urn:uuid:/i, "").toLowerCase();
}

function areShowCommandsEquivalent(
  actual: readonly GdcShowPlaylistCommand[],
  expected: readonly GdcShowPlaylistCommand[],
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }

  return actual.every((command, index) => {
    const target = expected[index];
    return command.label === target.label
      && (command.annotationText || "") === (target.annotationText || "")
      && normalizeOptionalNumber(command.offsetFrames) === normalizeOptionalNumber(target.offsetFrames)
      && (command.editRate || "") === (target.editRate || "");
  });
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(value ?? 0);
}

function formatTemporaryShowTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

function uniqueBy<T>(values: readonly T[], keyFor: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeConnectivitySnapshot(
  connectivity: HallRuntimeSnapshot["connectivity"],
): HallRuntimeSnapshot["connectivity"] {
  const rawState = String(connectivity?.state || "unknown");
  const state = rawState === "online"
    ? "online"
    : rawState === "unknown"
      ? "unknown"
      : "offline";

  const probePhase = state === "online"
    ? "idle"
    : connectivity?.probePhase
      ?? (rawState === "probing" ? "confirming" : rawState === "backoff" ? "fastRetry" : "slowRetry");

  return {
    ...connectivity,
    state,
    probePhase,
  };
}

let runtimeServiceSingleton: TmsRuntimeService | null = null;

export function getRuntimeService(): TmsRuntimeService {
  runtimeServiceSingleton ??= new TmsRuntimeService();
  return runtimeServiceSingleton;
}
