import { setTimeout as delay } from "node:timers/promises";
import type { GdcPlaybackStatus } from "../modules/gdc";
import type { HallRuntimeRecord } from "../runtime";
import { ApiError } from "./http";
import { listFilmScheduleEntries, updateFilmScheduleEntry, type FilmScheduleEntry } from "./film-schedule-store";
import { getNotificationService } from "./notification-service";
import { getRuntimeService, type TmsRuntimeService } from "./runtime-service";
import { readFilmSchedulerRecoverySettings } from "./setup-store";
import {
  expireStaleRunningFilmScheduleActions,
  hasSuccessfulFilmScheduleAction,
  markFilmScheduleActionFailure,
  markFilmScheduleActionSuccess,
  abortFilmScheduleRuntimeMonitoring,
  readFilmScheduleRuntime,
  tryClaimFilmScheduleAction,
  upsertFilmScheduleRuntime,
  type FilmScheduleActionExecution,
  type FilmScheduleRuntimeRecord,
  type FilmScheduleRuntimeStatus,
} from "./film-scheduler-store";

const ENGINE_TICK_MS = 1_000;
const DEFAULT_PRELOAD_SECONDS = 15;
const ACTIVE_AFTER_END_SECONDS = 15 * 60;
const ACTION_RETRY_COUNT = 3;
const ACTION_RETRY_AFTER_MS = 5_000;
const ACTION_RUNNING_TIMEOUT_MS = 30_000;
const DEFAULT_FPS = 24;
const PLAYBACK_ACTION_FRESHNESS_WINDOW_SECONDS = 5;
const MONITOR_LOST_TIMEOUT_MS = 10 * 60_000;
const PLAYBACK_TRANSITION_GRACE_MS = 5_000;
const EXITABLE_RUNTIME_STATUSES = new Set<FilmScheduleRuntimeStatus>([
  "pending",
  "preparing",
  "ready",
  "playing",
  "manual_hold",
  "monitor_lost",
  "transitioning",
]);

type TimePointType = "head" | "tail" | "point" | "range";

interface PlaybackTimePoint {
  readonly id?: string;
  readonly type: TimePointType;
  readonly note?: string;
  readonly startSeconds: number;
  readonly endSeconds?: number;
  readonly action?: PlaybackTimePointAction;
}

interface PlaybackTimePointAction {
  readonly type?: string;
  readonly executeAt?: "start" | "end";
  readonly eventLabel?: string;
  readonly durationSeconds?: number;
  readonly direction?: "forward" | "backward";
  readonly cplIndex?: number;
  readonly method?: string;
  readonly url?: string;
  readonly timeoutSeconds?: number;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly body?: string;
}

interface SchedulerRuntimeContext {
  readonly now: Date;
  readonly entry: FilmScheduleEntry;
  readonly runtime: HallRuntimeRecord;
  readonly previousRuntime?: FilmScheduleRuntimeRecord;
  readonly playback?: GdcPlaybackStatus;
  readonly showUuid: string;
  readonly positionSeconds: number;
  readonly rule: Record<string, unknown>;
}

export class FilmSchedulerEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;

  constructor(private readonly runtimeService: TmsRuntimeService = getRuntimeService()) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.scheduleNextTick(0);
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async exitScheduleMonitoring(
    scheduleId: string,
    options: { readonly hallId?: string; readonly reason?: string } = {},
  ): Promise<FilmScheduleRuntimeRecord> {
    const normalizedScheduleId = scheduleId.trim();
    if (!normalizedScheduleId) {
      throw new ApiError(400, "缺少排程 ID。");
    }

    const previousRuntime = await readFilmScheduleRuntime(normalizedScheduleId);
    if (!previousRuntime) {
      throw new ApiError(404, "未找到当前排程运行状态。");
    }

    if (options.hallId && previousRuntime.hallId !== options.hallId) {
      throw new ApiError(409, "当前排程不属于所选影厅。");
    }

    if (!EXITABLE_RUNTIME_STATUSES.has(previousRuntime.status)) {
      throw new ApiError(409, "当前排程已结束，无需退出监控。");
    }

    const runtime = this.runtimeService.getRuntimeRecord(previousRuntime.hallId);
    const playback = runtime?.snapshot.playback.status;
    const positionSeconds = playback
      ? normalizePlaybackPosition(playback)
      : previousRuntime.lastPositionSeconds;
    const message = options.reason?.trim() || "已人工退出排程监控，后续自动化动作将不会执行。";

    const now = new Date().toISOString();
    return abortFilmScheduleRuntimeMonitoring(normalizedScheduleId, {
      activeShowUuid: playback?.showUuid,
      lastPlaybackState: playback?.state,
      lastPositionSeconds: positionSeconds,
      interruptedAt: now,
      lastError: message,
    });
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.started) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runTick();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async runTick(): Promise<void> {
    if (this.running || !this.started) {
      this.scheduleNextTick(ENGINE_TICK_MS);
      return;
    }

    this.running = true;
    try {
      const now = new Date();
      await this.expireStaleRunningActions();
      const entries = await this.listCandidateEntries(now);
      const hallIds = [...new Set(entries.map((entry) => entry.hallId))];

      await Promise.allSettled(
        hallIds.map((hallId) => this.runtimeService.refreshHall(hallId, ["playback"])),
      );

      for (const entry of entries) {
        await this.processEntry(now, entry);
      }
    } catch (error) {
      console.error("Film scheduler engine tick failed:", error);
    } finally {
      this.running = false;
      this.scheduleNextTick(ENGINE_TICK_MS);
    }
  }

  private async expireStaleRunningActions(): Promise<void> {
    const count = await expireStaleRunningFilmScheduleActions(ACTION_RUNNING_TIMEOUT_MS);
    if (count > 0) {
      console.warn(`Released ${count} stale running film scheduler action(s).`);
    }
  }

  private async listCandidateEntries(now: Date): Promise<FilmScheduleEntry[]> {
    const dates = uniqueStrings([
      formatLocalDate(addDays(now, -1)),
      formatLocalDate(now),
      formatLocalDate(addDays(now, 1)),
    ]);

    const entries = (await Promise.all(
      dates.map((showDate) => listFilmScheduleEntries(showDate).catch(() => [])),
    )).flat();

    const activeEntries = await Promise.all(entries.map(async (entry) => {
      if (this.isEntryInActiveWindow(now, entry)) {
        return entry;
      }
      const runtime = await readFilmScheduleRuntime(entry.id).catch(() => null);
      return runtime && EXITABLE_RUNTIME_STATUSES.has(runtime.status) ? entry : null;
    }));

    return activeEntries
      .filter((entry): entry is FilmScheduleEntry => Boolean(entry))
      .sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime));
  }

  private isEntryInActiveWindow(now: Date, entry: FilmScheduleEntry): boolean {
    const startMs = Date.parse(entry.startTime);
    if (Number.isNaN(startMs)) {
      return false;
    }

    const endMs = entry.endTime ? Date.parse(entry.endTime) : startMs + 4 * 60 * 60_000;
    const preloadMs = this.resolvePreloadSeconds(entry) * 1_000;
    return now.getTime() >= startMs - preloadMs
      && now.getTime() <= endMs + ACTIVE_AFTER_END_SECONDS * 1_000;
  }

  private async processEntry(now: Date, entry: FilmScheduleEntry): Promise<void> {
    const previousRuntime = await readFilmScheduleRuntime(entry.id).catch(() => null);
    if (previousRuntime?.status === "failed" || previousRuntime?.status === "aborted" || previousRuntime?.status === "completed") {
      return;
    }

    if (previousRuntime?.status === "monitor_lost") {
      if (this.isMonitorLostTimedOut(previousRuntime, now)) {
        await this.abortMonitorLostTimeout(entry, previousRuntime);
        return;
      }
    }

    const runtime = this.runtimeService.getRuntimeRecord(entry.hallId);
    const rule = asRecord(entry.ruleSnapshot);
    const showUuid = this.resolveShowUuidForHall(rule, entry.hallId);
    if (!runtime || !showUuid) {
      if (previousRuntime?.status === "monitor_lost") {
        return;
      }
      await this.failBeforeStart(entry, "缺少影厅运行时或播放表引用。", { hasRuntime: Boolean(runtime), hasShowUuid: Boolean(showUuid) });
      return;
    }

    const playback = runtime.snapshot.playback.status;
    const positionSeconds = normalizePlaybackPosition(playback);
    const context: SchedulerRuntimeContext = {
      now,
      entry,
      runtime,
      previousRuntime: previousRuntime ?? undefined,
      playback,
      showUuid,
      positionSeconds,
      rule,
    };

    if (!await this.maybeLoadShow(context)) {
      return;
    }
    if (!await this.maybePlayShow(context)) {
      return;
    }
    await this.maybeRunPlaybackActions(context);
    await this.observeRuntime(context);
  }

  private async observeRuntime(context: SchedulerRuntimeContext): Promise<void> {
    const { now, entry, playback, showUuid, positionSeconds } = context;
    const state = normalizePlaybackState(playback?.state);
    const activeShowUuid = playback?.showUuid || undefined;
    const currentShowMatches = sameUuid(activeShowUuid, showUuid);
    const startMs = Date.parse(entry.startTime);
    const playActionSucceeded = await hasSuccessfulFilmScheduleAction(this.buildActionKey(entry.id, "play"));
    const hasStarted = playActionSucceeded;

    let status: FilmScheduleRuntimeStatus = context.previousRuntime?.status ?? "pending";
    let completedAt: string | undefined;
    let interruptedAt: string | undefined;

    if (hasStarted && this.isPlaybackMonitorLost(context)) {
      await this.markMonitorLost(entry, playback, positionSeconds);
      return;
    }

    if (hasStarted && (state === "STOPPED" || state === "IDLE") && this.isNormalPlaybackExit(context)) {
      await this.recordRuntime(entry, "completed", playback, this.resolvePlaybackPosition(context), undefined, {
        completedAt: now.toISOString(),
      });
      return;
    }

    if (hasStarted && this.isTransientPlaybackTransition(context, state, currentShowMatches, activeShowUuid)) {
      if (this.isTransitionTimedOut(context.previousRuntime, now)) {
        await this.abortRunningSchedule(
          entry,
          playback,
          positionSeconds,
          activeShowUuid && !currentShowMatches
            ? "播放表切换后未在过渡窗口内恢复，场次异常退出。"
            : "播放停止状态超过过渡窗口，场次异常退出。",
        );
      } else {
        await this.markPlaybackTransition(entry, playback, positionSeconds, context.previousRuntime);
      }
      return;
    }

    if (hasStarted && !currentShowMatches) {
      await this.abortRunningSchedule(
        entry,
        playback,
        this.resolvePlaybackPosition(context),
        activeShowUuid ? "播放表已被切换，场次异常退出。" : "目标播放表已不在当前播放状态中，场次异常退出。",
      );
      return;
    }

    if (hasStarted && currentShowMatches && state === "PLAYING") {
      status = "playing";
    } else if (hasStarted && currentShowMatches && state === "PAUSED") {
      status = "manual_hold";
      interruptedAt = now.toISOString();
    } else if (
      hasStarted
      && currentShowMatches
      && (state === "STOPPED" || state === "IDLE")
      && now.getTime() >= startMs
    ) {
      await this.markPlaybackTransition(entry, playback, positionSeconds, context.previousRuntime);
      return;
    } else if (currentShowMatches && now.getTime() < startMs) {
      status = "ready";
    } else if (now.getTime() < startMs) {
      status = "pending";
    }

    await this.recordRuntime(entry, status, playback, positionSeconds, undefined, {
      completedAt,
      interruptedAt,
    });
  }

  private async maybeLoadShow(context: SchedulerRuntimeContext): Promise<boolean> {
    const { now, entry, playback, showUuid } = context;
    const startMs = Date.parse(entry.startTime);
    const preloadMs = this.resolvePreloadSeconds(entry) * 1_000;
    if (Number.isNaN(startMs) || now.getTime() < startMs - preloadMs) {
      return true;
    }

    const playActionSucceeded = await hasSuccessfulFilmScheduleAction(this.buildActionKey(entry.id, "play"));
    if (playActionSucceeded) {
      return true;
    }

    if (sameUuid(playback?.showUuid, showUuid)) {
      if (now.getTime() < startMs && !playActionSucceeded) {
        await this.recordRuntime(entry, "ready", playback, normalizePlaybackPosition(playback));
      }
      return true;
    }

    const preflightPassed = await this.ensurePreflightPassed(context, startMs - preloadMs);
    if (!preflightPassed) {
      return false;
    }

    const loadActionKey = this.buildActionKey(entry.id, "load", showUuid);
    if (await hasSuccessfulFilmScheduleAction(loadActionKey)) {
      return true;
    }

    await this.executeClaimedAction({
      context,
      actionKey: loadActionKey,
      actionType: "loadShow",
      triggerKind: "absolute_time",
      plannedAt: new Date(startMs - preloadMs).toISOString(),
      payload: {
        scheduleId: entry.id,
        hallId: entry.hallId,
        showUuid,
        filmName: entry.filmName,
      },
      action: async () => {
        await this.recordRuntime(entry, "preparing", playback, normalizePlaybackPosition(playback));
        const loadedShowUuid = await this.loadShowWithRecovery(context, showUuid);
        await this.recordRuntime(entry, "ready", playback, normalizePlaybackPosition(playback), undefined, {
          loadedAt: new Date().toISOString(),
        });
        return { showUuid: loadedShowUuid };
      },
      failStatus: "failed",
    });
    return false;
  }

  private async loadShowWithRecovery(
    context: SchedulerRuntimeContext,
    showUuid: string,
  ): Promise<string> {
    const { entry, rule } = context;
    try {
      await this.runtimeService.loadShow(entry.hallId, showUuid);
      return showUuid;
    } catch (error) {
      if (!isUnableToLoadShowError(error)) {
        throw error;
      }

      const recoverySettings = await readFilmSchedulerRecoverySettings();
      const snapshot = asRecordOrNull(rule.playlistSnapshot);
      const recoveryErrors: string[] = [];

      if (recoverySettings.autoCorrectShowUuid) {
        try {
          const equivalentShow = await this.runtimeService.findEquivalentShowFromSnapshot(entry.hallId, snapshot);
          if (equivalentShow?.showUuid) {
            await this.runtimeService.loadShow(entry.hallId, equivalentShow.showUuid);
            await this.persistRecoveredShowUuid(entry, equivalentShow.showUuid);
            await this.createScheduleNotification(entry, {
              severity: "warning",
              type: "FILM_SCHEDULE_SHOW_UUID_CORRECTED",
              title: "播放表已自动修正",
              message: "原播放表无法载入，系统已在 GDC 内找到与快照完全一致的播放表并改用该播放表。",
              dedupeKey: `film-scheduler:${entry.id}:show-uuid-corrected:${normalizeUuid(equivalentShow.showUuid)}`,
              payload: {
                originalShowUuid: showUuid,
                recoveredShowUuid: equivalentShow.showUuid,
              },
            });
            return equivalentShow.showUuid;
          }
          recoveryErrors.push("未找到与快照完全一致的播放表。");
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
        }
      }

      if (recoverySettings.allowTemporaryShow) {
        try {
          const temporaryShow = await this.runtimeService.createTemporaryShowFromSnapshot(entry.hallId, snapshot);
          await this.runtimeService.loadShow(entry.hallId, temporaryShow.showUuid);
          await this.persistRecoveredShowUuid(entry, temporaryShow.showUuid);
          await this.createScheduleNotification(entry, {
            severity: "warning",
            type: "FILM_SCHEDULE_TEMPORARY_SHOW_CREATED",
            title: "已创建临时播放表",
            message: recoverySettings.autoCorrectShowUuid
              ? "原播放表无法载入，且未能自动修正；系统已根据排期快照创建临时播放表并载入。"
              : "原播放表无法载入；系统已根据排期快照创建临时播放表并载入。",
            dedupeKey: `film-scheduler:${entry.id}:temporary-show:${normalizeUuid(temporaryShow.showUuid)}`,
            payload: {
              originalShowUuid: showUuid,
              temporaryShowUuid: temporaryShow.showUuid,
            },
          });
          return temporaryShow.showUuid;
        } catch (temporaryError) {
          recoveryErrors.push(temporaryError instanceof Error ? temporaryError.message : String(temporaryError));
        }
      }

      if (recoveryErrors.length > 0) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}；恢复失败：${recoveryErrors.join("；")}`);
      }
      throw error;
    }
  }

  private async maybePlayShow(context: SchedulerRuntimeContext): Promise<boolean> {
    const { now, entry, playback, showUuid, previousRuntime } = context;
    const startMs = Date.parse(entry.startTime);
    if (Number.isNaN(startMs) || now.getTime() < startMs) {
      return true;
    }

    const state = normalizePlaybackState(playback?.state);
    const currentShowMatches = sameUuid(playback?.showUuid, showUuid);
    const playActionKey = this.buildActionKey(entry.id, "play");
    if (await hasSuccessfulFilmScheduleAction(playActionKey)) {
      return true;
    }

    if (!isIdlePlaybackState(state)) {
      await this.failBeforeStart(entry, "开场时影厅处于非空闲播放状态，排期未执行。", {
        playbackState: playback?.state,
        activeShowUuid: playback?.showUuid,
        expectedShowUuid: showUuid,
      });
      return false;
    }

    if (!currentShowMatches) {
      if (previousRuntime?.loadedAt || previousRuntime?.status === "ready") {
        await this.failBeforeStart(entry, "开场时目标播放表已不在当前载入状态中，排期未执行。", {
          playbackState: playback?.state,
          activeShowUuid: playback?.showUuid,
          expectedShowUuid: showUuid,
        });
      }
      return false;
    }

    await this.executeClaimedAction({
      context,
      actionKey: playActionKey,
      actionType: "playShow",
      triggerKind: "absolute_time",
      plannedAt: new Date(startMs).toISOString(),
      payload: {
        scheduleId: entry.id,
        hallId: entry.hallId,
        showUuid,
        filmName: entry.filmName,
      },
      action: async () => {
        await this.runtimeService.play(entry.hallId);
        await this.recordRuntime(entry, "playing", playback, normalizePlaybackPosition(playback), undefined, {
          playedAt: new Date().toISOString(),
        });
        await this.createScheduleNotification(entry, {
          severity: "info",
          type: "FILM_SCHEDULE_PLAY_STARTED",
          title: "开始播放",
          message: "排期已成功开始播放。",
          dedupeKey: `film-scheduler:${entry.id}:play:started`,
          payload: { showUuid },
        });
        return { showUuid };
      },
      failStatus: "failed",
    });
    return false;
  }

  private async maybeRunPlaybackActions(context: SchedulerRuntimeContext): Promise<void> {
    const { now, entry, playback, showUuid, positionSeconds, rule, previousRuntime } = context;
    if (!sameUuid(playback?.showUuid, showUuid) || normalizePlaybackState(playback?.state) !== "PLAYING") {
      return;
    }

    const previousPositionSeconds = previousRuntime?.lastPositionSeconds;
    const points = readTimePoints(rule);
    for (const [index, point] of points.entries()) {
      const triggers = this.resolveActionTriggers(point);
      for (const trigger of triggers) {
        if (!hasFreshPlaybackCrossing(previousPositionSeconds, positionSeconds, trigger.seconds)) {
          continue;
        }

        const action = trigger.action;
        if (!action?.type) {
          continue;
        }

        const actionKey = this.buildActionKey(
          entry.id,
          "timepoint",
          point.id || String(index),
          action.type,
          String(trigger.seconds),
          trigger.edge,
          String(now.getTime()),
        );
        await this.executeClaimedAction({
          context,
          actionKey,
          actionType: action.type,
          triggerKind: "playback_position",
          plannedAt: undefined,
          payload: {
            scheduleId: entry.id,
            hallId: entry.hallId,
            filmName: entry.filmName,
            point: {
              id: point.id,
              type: point.type,
              note: point.note,
              startSeconds: point.startSeconds,
              endSeconds: point.endSeconds,
            },
            trigger,
            action,
          },
          action: async () => this.runTimePointAction(context, point, action),
          notifyOnlyOnFailure: true,
        });
      }
    }
  }

  private async ensurePreflightPassed(context: SchedulerRuntimeContext, plannedAtMs: number): Promise<boolean> {
    const { entry, playback, showUuid, runtime } = context;
    const preflightKey = this.buildActionKey(entry.id, "preflight");
    if (await hasSuccessfulFilmScheduleAction(preflightKey)) {
      return true;
    }

    let preflightSucceeded = false;
    await this.executeClaimedAction({
      context,
      actionKey: preflightKey,
      actionType: "preflight",
      triggerKind: "absolute_time",
      plannedAt: new Date(plannedAtMs).toISOString(),
      payload: {
        scheduleId: entry.id,
        hallId: entry.hallId,
        showUuid,
        filmName: entry.filmName,
      },
      action: async () => {
        this.assertPreflightReady(runtime, playback, showUuid);
        const inspection = await this.runtimeService.inspectShow(entry.hallId, showUuid, { force: true });
        if (!inspection.allValid) {
          throw new Error("播放表校验未通过，排期未执行。");
        }
        preflightSucceeded = true;
        return { showUuid };
      },
      failStatus: "failed",
    });

    return preflightSucceeded;
  }

  private assertPreflightReady(
    runtime: HallRuntimeRecord,
    playback: GdcPlaybackStatus | undefined,
    showUuid: string,
  ): void {
    if (runtime.snapshot.connectivity.state !== "online") {
      throw new Error("影厅放映服务器不在线，排期未执行。");
    }

    if (runtime.snapshot.serverInfo.projectorStatus?.connectionState !== "Connected") {
      throw new Error("放映机未连接，排期未执行。");
    }

    const state = normalizePlaybackState(playback?.state);
    if (!isIdlePlaybackState(state)) {
      throw new Error("影厅处于非空闲播放状态，排期未执行。");
    }
  }

  private resolveActionTriggers(point: PlaybackTimePoint): Array<{
    readonly edge: "start" | "end";
    readonly seconds: number;
    readonly action?: PlaybackTimePointAction;
  }> {
    const action = point.action;
    if (!action?.type) {
      return [];
    }

    if (point.type !== "range") {
      return [{ edge: "start", seconds: point.startSeconds, action }];
    }

    if (action.type === "skipRange") {
      return [{ edge: "start", seconds: point.startSeconds, action }];
    }

    const edge = action.executeAt === "end" ? "end" : "start";
    const seconds = edge === "end" ? point.endSeconds : point.startSeconds;
    return Number.isFinite(seconds) ? [{ edge, seconds: Number(seconds), action }] : [];
  }

  private async runTimePointAction(
    context: SchedulerRuntimeContext,
    point: PlaybackTimePoint,
    action: PlaybackTimePointAction,
  ): Promise<Record<string, unknown>> {
    const type = action.type;
    if (type === "executeCommand") {
      const eventLabel = String(action.eventLabel || "").trim();
      if (!eventLabel) {
        throw new Error("时间点指令缺少 eventLabel。");
      }
      await this.runtimeService.triggerAutomation(context.entry.hallId, eventLabel);
      return { eventLabel };
    }

    if (type === "pausePlayback") {
      const durationSeconds = normalizePositiveInteger(action.durationSeconds, 0);
      await this.runtimeService.pause(context.entry.hallId);
      if (durationSeconds > 0) {
        void this.resumeAfterDelay(context.entry.hallId, context.showUuid, durationSeconds);
      }
      return { durationSeconds, resumeScheduled: durationSeconds > 0 };
    }

    if (type === "stopPlayback") {
      await this.runtimeService.stopPlayback(context.entry.hallId);
      return {};
    }

    if (type === "seek") {
      const rawSeconds = normalizePositiveInteger(action.durationSeconds, 0);
      if (rawSeconds <= 0) {
        throw new Error("跳转动作缺少有效秒数。");
      }
      const offset = action.direction === "backward" ? -rawSeconds : rawSeconds;
      await this.runtimeService.movePlayback(context.entry.hallId, { offset });
      return { offset };
    }

    if (type === "switchCpl") {
      const targetSeconds = this.resolveCplStartSeconds(context.rule, action.cplIndex);
      await this.runtimeService.movePlayback(context.entry.hallId, {
        absolute: formatFrameTimecode(targetSeconds),
      });
      return { cplIndex: action.cplIndex, targetSeconds };
    }

    if (type === "skipRange") {
      const rangeEnd = Number(point.endSeconds);
      if (!Number.isFinite(rangeEnd) || rangeEnd <= point.startSeconds) {
        throw new Error("跳过时间段缺少有效结束时间。");
      }
      const targetSeconds = Math.ceil(rangeEnd);
      await this.runtimeService.movePlayback(context.entry.hallId, {
        absolute: formatFrameTimecode(targetSeconds),
      });
      return { targetSeconds };
    }

    if (type === "httpRequest") {
      return this.runHttpRequest(action);
    }

    throw new Error(`未知时间点动作：${type || "空"}`);
  }

  private async runHttpRequest(action: PlaybackTimePointAction): Promise<Record<string, unknown>> {
    const url = buildHttpUrl(action);
    const method = String(action.method || "GET").trim().toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new Error(`不支持的 HTTP 方法：${method}`);
    }

    const timeoutSeconds = Math.min(Math.max(normalizePositiveInteger(action.timeoutSeconds, 10), 1), 30);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
    timeout.unref?.();

    try {
      const response = await fetch(url, {
        method,
        headers: normalizeHeaders(action.headers),
        body: method === "GET" || method === "DELETE" ? undefined : action.body || undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      return {
        url,
        method,
        status: response.status,
        bodyPreview: text.slice(0, 300),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resumeAfterDelay(hallId: string, expectedShowUuid: string, durationSeconds: number): Promise<void> {
    await delay(durationSeconds * 1_000).catch(() => undefined);
    const runtime = this.runtimeService.getRuntimeRecord(hallId);
    const playback = runtime?.snapshot.playback.status;
    if (sameUuid(playback?.showUuid, expectedShowUuid) && normalizePlaybackState(playback?.state) === "PAUSED") {
      await this.runtimeService.resume(hallId).catch((error) => {
        console.error(`Film scheduler failed to resume paused playback for ${hallId}:`, error);
      });
    }
  }

  private async executeClaimedAction(input: {
    readonly context: SchedulerRuntimeContext;
    readonly actionKey: string;
    readonly actionType: string;
    readonly triggerKind: string;
    readonly plannedAt?: string;
    readonly payload: Record<string, unknown>;
    readonly action: () => Promise<Record<string, unknown>>;
    readonly failStatus?: FilmScheduleRuntimeStatus;
    readonly notifyOnlyOnFailure?: boolean;
  }): Promise<void> {
    const execution = await tryClaimFilmScheduleAction({
      scheduleId: input.context.entry.id,
      hallId: input.context.entry.hallId,
      actionKey: input.actionKey,
      actionType: input.actionType,
      triggerKind: input.triggerKind,
      plannedAt: input.plannedAt,
      payload: input.payload,
      maxRetryCount: ACTION_RETRY_COUNT,
      retryAfterMs: ACTION_RETRY_AFTER_MS,
    });

    if (!execution) {
      return;
    }

    await this.runClaimedAction(
      execution,
      input.action,
      input.context.entry,
      input.failStatus,
      input.notifyOnlyOnFailure,
    );
  }

  private async runClaimedAction(
    execution: FilmScheduleActionExecution,
    action: () => Promise<Record<string, unknown>>,
    entry: FilmScheduleEntry,
    failStatus: FilmScheduleRuntimeStatus | undefined,
    notifyOnlyOnFailure = false,
  ): Promise<void> {
    try {
      const result = await action();
      await markFilmScheduleActionSuccess(execution.id, result);
    } catch (error) {
      await markFilmScheduleActionFailure(execution.id, error);
      const message = error instanceof Error ? error.message : String(error);
      if (failStatus) {
        await this.recordRuntime(entry, failStatus, undefined, undefined, message);
      }
      await this.createScheduleNotification(entry, {
        severity: failStatus === "failed" ? "error" : "warning",
        type: notifyOnlyOnFailure ? "FILM_SCHEDULE_ACTION_FAILED" : "FILM_SCHEDULE_FAILED",
        title: notifyOnlyOnFailure ? `${entry.hallName}排程动作失败` : `${entry.hallName}排期未执行`,
        message,
        dedupeKey: `film-scheduler:${entry.id}:${execution.actionKey}:failed`,
        payload: {
          actionKey: execution.actionKey,
          actionType: execution.actionType,
          triggerKind: execution.triggerKind,
        },
      });
    }
  }

  private isNormalPlaybackExit(context: SchedulerRuntimeContext): boolean {
    const position = this.resolvePlaybackPosition(context);
    const total = this.resolvePlaybackTotalSeconds(context);
    if (Number.isFinite(total) && total > 0 && position >= total - 3) {
      return true;
    }
    return false;
  }

  private resolvePlaybackPosition(context: SchedulerRuntimeContext): number {
    const position = normalizePlaybackPosition(context.playback);
    const state = normalizePlaybackState(context.playback?.state);
    if ((state === "STOPPED" || state === "IDLE") && position <= 0) {
      const previousPosition = context.previousRuntime?.lastPositionSeconds;
      return Number.isFinite(previousPosition) && previousPosition ? previousPosition : position;
    }
    return position;
  }

  private resolvePlaybackTotalSeconds(context: SchedulerRuntimeContext): number {
    const playbackTotal = Number(context.playback?.showPosition?.totalDuration);
    if (Number.isFinite(playbackTotal) && playbackTotal > 0) {
      return playbackTotal;
    }

    const snapshotTotal = readPlaylistSegmentDurations(context.rule).reduce((sum, seconds) => sum + seconds, 0);
    return Number.isFinite(snapshotTotal) && snapshotTotal > 0 ? snapshotTotal : Number.NaN;
  }

  private isPlaybackMonitorLost(context: SchedulerRuntimeContext): boolean {
    if (context.runtime.snapshot.connectivity.state !== "online") {
      return true;
    }

    return !context.playback?.state && !context.playback?.showUuid;
  }

  private isTransientPlaybackTransition(
    context: SchedulerRuntimeContext,
    state: string,
    currentShowMatches: boolean,
    activeShowUuid: string | undefined,
  ): boolean {
    if (state !== "STOPPED" && state !== "IDLE") {
      return false;
    }

    if (currentShowMatches) {
      return true;
    }

    const previousStatus = context.previousRuntime?.status;
    if (!activeShowUuid && (
      previousStatus === "playing"
      || previousStatus === "manual_hold"
      || previousStatus === "transitioning"
    )) {
      return true;
    }

    return previousStatus === "transitioning";
  }

  private isTransitionTimedOut(runtime: FilmScheduleRuntimeRecord | undefined, now: Date): boolean {
    if (runtime?.status !== "transitioning") {
      return false;
    }

    const startedAtMs = Date.parse(runtime.interruptedAt || runtime.updatedAt);
    return !Number.isNaN(startedAtMs) && now.getTime() - startedAtMs >= PLAYBACK_TRANSITION_GRACE_MS;
  }

  private async markPlaybackTransition(
    entry: FilmScheduleEntry,
    playback: GdcPlaybackStatus | undefined,
    positionSeconds: number,
    runtime: FilmScheduleRuntimeRecord | undefined,
  ): Promise<void> {
    const interruptedAt = runtime?.status === "transitioning"
      ? runtime.interruptedAt || runtime.updatedAt
      : new Date().toISOString();
    const state = normalizePlaybackState(playback?.state);
    const transitionPosition = (state === "STOPPED" || state === "IDLE") && positionSeconds <= 0
      ? runtime?.lastPositionSeconds ?? positionSeconds
      : positionSeconds;

    await this.recordRuntime(entry, "transitioning", playback, transitionPosition, undefined, {
      interruptedAt,
    });
  }

  private isMonitorLostTimedOut(runtime: FilmScheduleRuntimeRecord, now: Date): boolean {
    const startedAtMs = Date.parse(runtime.interruptedAt || runtime.updatedAt);
    return !Number.isNaN(startedAtMs) && now.getTime() - startedAtMs >= MONITOR_LOST_TIMEOUT_MS;
  }

  private async abortMonitorLostTimeout(
    entry: FilmScheduleEntry,
    runtime: FilmScheduleRuntimeRecord,
  ): Promise<void> {
    const timeoutLabel = formatDurationLabel(MONITOR_LOST_TIMEOUT_MS);
    const message = `场次监控中断超过 ${timeoutLabel}，播放状态已失真，系统停止恢复该场次。`;
    await this.recordRuntime(entry, "aborted", undefined, runtime.lastPositionSeconds, message, {
      interruptedAt: new Date().toISOString(),
    });
    await this.createScheduleNotification(entry, {
      severity: "critical",
      type: "FILM_SCHEDULE_MONITOR_TIMEOUT",
      title: `${entry.hallName}场次监控超时`,
      message,
      dedupeKey: `film-scheduler:${entry.id}:monitor-timeout`,
      payload: {
        lastPlaybackState: runtime.lastPlaybackState,
        lastShowUuid: runtime.activeShowUuid,
        lastPositionSeconds: runtime.lastPositionSeconds,
        monitorLostAt: runtime.interruptedAt,
      },
    });
  }

  private async markMonitorLost(
    entry: FilmScheduleEntry,
    playback: GdcPlaybackStatus | undefined,
    positionSeconds: number,
  ): Promise<void> {
    const message = "放映服务器状态不可用，场次监控中断；恢复连接后将重新判定场次状态。";
    await this.recordRuntime(entry, "monitor_lost", playback, positionSeconds, message, {
      interruptedAt: new Date().toISOString(),
    });
    await this.createScheduleNotification(entry, {
      severity: "warning",
      type: "FILM_SCHEDULE_MONITOR_LOST",
      title: `${entry.hallName}场次监控中断`,
      message,
      dedupeKey: `film-scheduler:${entry.id}:monitor-lost`,
      payload: {
        playbackState: playback?.state,
        activeShowUuid: playback?.showUuid,
        positionSeconds,
      },
    });
  }

  private async abortRunningSchedule(
    entry: FilmScheduleEntry,
    playback: GdcPlaybackStatus | undefined,
    positionSeconds: number,
    message: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.recordRuntime(entry, "aborted", playback, positionSeconds, message, {
      interruptedAt: now,
    });
    await this.createScheduleNotification(entry, {
      severity: "critical",
      type: "FILM_SCHEDULE_ABORTED",
      title: `${entry.hallName}场次异常退出`,
      message,
      dedupeKey: `film-scheduler:${entry.id}:aborted`,
      payload: {
        playbackState: playback?.state,
        activeShowUuid: playback?.showUuid,
        positionSeconds,
      },
    });
  }

  private async failBeforeStart(
    entry: FilmScheduleEntry,
    message: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.recordRuntime(entry, "failed", undefined, undefined, message);
    await this.createScheduleNotification(entry, {
      severity: "error",
      type: "FILM_SCHEDULE_FAILED",
      title: `${entry.hallName}排期未执行`,
      message,
      dedupeKey: `film-scheduler:${entry.id}:failed`,
      payload,
    });
  }

  private async createScheduleNotification(
    entry: FilmScheduleEntry,
    input: {
      readonly severity: "info" | "warning" | "error" | "critical";
      readonly type: string;
      readonly title: string;
      readonly message: string;
      readonly dedupeKey: string;
      readonly payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await getNotificationService().create({
      type: input.type,
      severity: input.severity,
      title: buildScheduleNotificationTitle(entry, input.title),
      message: input.message,
      source: "system",
      objectType: "film-schedule-entry",
      objectId: entry.id,
      hallId: entry.hallId,
      dedupeKey: input.dedupeKey,
      payload: {
        scheduleId: entry.id,
        hallId: entry.hallId,
        hallName: entry.hallName,
        filmName: entry.filmName,
        startTime: entry.startTime,
        scheduleLabel: buildScheduleNotificationLabel(entry),
        ...input.payload,
      },
    }).catch((error) => {
      console.error("Failed to create film scheduler notification:", error);
    });
  }

  private async recordRuntime(
    entry: FilmScheduleEntry,
    status: FilmScheduleRuntimeStatus,
    playback?: GdcPlaybackStatus,
    positionSeconds?: number,
    lastError?: string,
    timestamps: {
      readonly loadedAt?: string;
      readonly playedAt?: string;
      readonly completedAt?: string;
      readonly interruptedAt?: string;
    } = {},
  ): Promise<void> {
    await upsertFilmScheduleRuntime({
      scheduleId: entry.id,
      hallId: entry.hallId,
      showDate: entry.showDate,
      status,
      activeShowUuid: playback?.showUuid,
      lastPlaybackState: playback?.state,
      lastPositionSeconds: positionSeconds,
      lastPositionAt: new Date().toISOString(),
      loadedAt: timestamps.loadedAt,
      playedAt: timestamps.playedAt,
      completedAt: timestamps.completedAt,
      interruptedAt: timestamps.interruptedAt,
      lastError,
    }).catch((error) => {
      console.error("Failed to persist film schedule runtime:", error);
    });
  }

  private resolveShowUuidForHall(rule: Record<string, unknown>, hallId: string): string | undefined {
    const refs = Array.isArray(rule.playlistRefs) ? rule.playlistRefs : [];
    const ref = refs
      .map((item) => asRecordOrNull(item))
      .find((item): item is Record<string, unknown> => item?.hallId === hallId);
    return typeof ref?.playlistId === "string" && ref.playlistId.trim() ? ref.playlistId.trim() : undefined;
  }

  private async persistRecoveredShowUuid(entry: FilmScheduleEntry, showUuid: string): Promise<void> {
    const rule = asRecord(entry.ruleSnapshot);
    const nextRule: Record<string, unknown> = { ...rule };
    const playlistRefs = Array.isArray(rule.playlistRefs) ? rule.playlistRefs : [];
    nextRule.playlistRefs = playlistRefs.map((item) => {
      const ref = asRecordOrNull(item);
      if (!ref || ref.hallId !== entry.hallId) {
        return item;
      }
      return {
        ...ref,
        playlistId: showUuid,
      };
    });

    const snapshot = asRecordOrNull(rule.playlistSnapshot);
    if (snapshot) {
      nextRule.playlistSnapshot = {
        ...snapshot,
        refs: Array.isArray(snapshot.refs)
          ? snapshot.refs.map((item) => {
            const ref = asRecordOrNull(item);
            if (!ref || ref.hallId !== entry.hallId) {
              return item;
            }
            return {
              ...ref,
              playlistId: showUuid,
            };
          })
          : snapshot.refs,
        details: Array.isArray(snapshot.details)
          ? snapshot.details.map((item) => {
            const detail = asRecordOrNull(item);
            if (!detail || detail.hallId !== entry.hallId) {
              return item;
            }
            return {
              ...detail,
              showUuid,
            };
          })
          : snapshot.details,
      };
    }

    await updateFilmScheduleEntry(entry.id, {
      ruleSnapshot: nextRule,
    }).catch((error) => {
      console.error("Failed to persist recovered film schedule show UUID:", error);
    });
  }

  private resolvePreloadSeconds(entry: FilmScheduleEntry): number {
    const rule = asRecord(entry.ruleSnapshot);
    const raw = Number(rule.preloadSeconds);
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : DEFAULT_PRELOAD_SECONDS;
  }

  private resolveCplStartSeconds(rule: Record<string, unknown>, cplIndex: unknown): number {
    const targetIndex = normalizePositiveInteger(cplIndex, 1) - 1;
    if (targetIndex <= 0) {
      return 0;
    }

    const durations = readPlaylistSegmentDurations(rule);
    if (durations.length === 0 || targetIndex >= durations.length) {
      throw new Error("无法根据播放表快照定位指定 CPL。");
    }

    return durations.slice(0, targetIndex).reduce((sum, seconds) => sum + seconds, 0);
  }

  private buildActionKey(...parts: readonly string[]): string {
    return parts
      .map((part) => String(part).trim().replace(/\s+/g, "_"))
      .filter(Boolean)
      .join(":")
      .slice(0, 255);
  }
}

let filmSchedulerEngineSingleton: FilmSchedulerEngine | null = null;

export function getFilmSchedulerEngine(): FilmSchedulerEngine {
  filmSchedulerEngineSingleton ??= new FilmSchedulerEngine();
  return filmSchedulerEngineSingleton;
}

function readTimePoints(rule: Record<string, unknown>): PlaybackTimePoint[] {
  const raw = Array.isArray(rule.timePoints) ? rule.timePoints : [];
  return raw.flatMap((item): PlaybackTimePoint[] => {
    const point = asRecordOrNull(item);
    if (!point) {
      return [];
    }
    const type = point.type === "head" || point.type === "tail" || point.type === "range" ? point.type : "point";
    const startSeconds = Number(point.startSeconds);
    if (!Number.isFinite(startSeconds) || startSeconds < 0) {
      return [];
    }
    const action = asAction(point.action);
    return [{
      id: typeof point.id === "string" && point.id.trim() ? point.id.trim() : undefined,
      type,
      note: typeof point.note === "string" ? point.note : undefined,
      startSeconds: Math.round(startSeconds),
      endSeconds: type === "range" && Number.isFinite(Number(point.endSeconds))
        ? Math.round(Number(point.endSeconds))
        : undefined,
      action,
    }];
  });
}

function asAction(value: unknown): PlaybackTimePointAction | undefined {
  const record = asRecordOrNull(value);
  if (!record || typeof record.type !== "string") {
    return undefined;
  }
  return {
    type: record.type,
    executeAt: record.executeAt === "end" ? "end" : "start",
    eventLabel: optionalString(record.eventLabel),
    durationSeconds: optionalNumber(record.durationSeconds),
    direction: record.direction === "backward" ? "backward" : "forward",
    cplIndex: optionalNumber(record.cplIndex),
    method: optionalString(record.method),
    url: optionalString(record.url),
    timeoutSeconds: optionalNumber(record.timeoutSeconds),
    headers: normalizeStringRecord(record.headers),
    query: normalizeStringRecord(record.query),
    body: optionalString(record.body),
  };
}

function readPlaylistSegmentDurations(rule: Record<string, unknown>): number[] {
  const snapshot = asRecordOrNull(rule.playlistSnapshot);
  const details = Array.isArray(snapshot?.details) ? snapshot.details : [];
  const detail = asRecordOrNull(details[0]);
  const segmentDetails = Array.isArray(detail?.segmentDetails) ? detail.segmentDetails : [];
  const detailDurations = segmentDetails
    .map((item) => Number(asRecordOrNull(item)?.durationSeconds))
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
  if (detailDurations.length > 0) {
    return detailDurations;
  }

  const segments = Array.isArray(detail?.segments) ? detail.segments : [];
  return segments
    .map((item) => Number(asRecordOrNull(item)?.durationSeconds))
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
}

function buildHttpUrl(action: PlaybackTimePointAction): string {
  const rawUrl = String(action.url || "").trim();
  if (!rawUrl) {
    throw new Error("HTTP 请求缺少 URL。");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("HTTP 请求 URL 只支持 http/https。");
  }
  for (const [key, value] of Object.entries(action.query || {})) {
    if (key) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function normalizeHeaders(value: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value || {})) {
    const normalizedKey = key.trim();
    if (!normalizedKey || /^(host|content-length)$/i.test(normalizedKey)) {
      continue;
    }
    headers[normalizedKey] = String(raw);
  }
  return headers;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecordOrNull(value);
  if (!record) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (key.trim() && raw !== undefined && raw !== null) {
      result[key.trim()] = String(raw);
    }
  }
  return result;
}

function normalizePlaybackPosition(playback: GdcPlaybackStatus | undefined): number {
  const position = Number(playback?.showPosition?.playedDuration);
  return Number.isFinite(position) && position >= 0 ? position : 0;
}

function buildScheduleNotificationTitle(entry: FilmScheduleEntry, title: string): string {
  const label = buildScheduleNotificationLabel(entry);
  const hallName = entry.hallName.trim();
  let normalizedTitle = title.trim();
  if (hallName && normalizedTitle.startsWith(hallName)) {
    normalizedTitle = normalizedTitle.slice(hallName.length).trim();
  }
  return normalizedTitle ? `${label} ${normalizedTitle}` : label;
}

function buildScheduleNotificationLabel(entry: FilmScheduleEntry): string {
  const hallName = entry.hallName.trim() || `影厅 ${entry.hallId}`;
  return `${formatClockTime(entry.startTime)} ${hallName}`;
}

function formatClockTime(value: string): string {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0"),
    ].join(":");
  }

  const match = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  return match ? `${match[1]}:${match[2]}:${match[3] || "00"}` : "--:--:--";
}

function hasFreshPlaybackCrossing(
  previousPosition: number | undefined,
  currentPosition: number,
  triggerSeconds: number,
): boolean {
  if (!Number.isFinite(currentPosition) || currentPosition < 0 || !Number.isFinite(triggerSeconds)) {
    return false;
  }

  if (currentPosition > triggerSeconds + PLAYBACK_ACTION_FRESHNESS_WINDOW_SECONDS) {
    return false;
  }

  if (previousPosition === undefined || !Number.isFinite(previousPosition)) {
    return currentPosition >= triggerSeconds;
  }

  if (currentPosition < previousPosition) {
    return false;
  }

  return previousPosition < triggerSeconds && currentPosition >= triggerSeconds;
}

function normalizePlaybackState(value: unknown): string {
  return String(value || "UNKNOWN").trim().toUpperCase();
}

function formatDurationLabel(milliseconds: number): string {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1_000));
  if (totalSeconds % 3_600 === 0) {
    return `${totalSeconds / 3_600} 小时`;
  }
  if (totalSeconds % 60 === 0) {
    return `${totalSeconds / 60} 分钟`;
  }
  return `${totalSeconds} 秒`;
}

function isIdlePlaybackState(state: string): boolean {
  return state === "STOPPED" || state === "IDLE";
}

function sameUuid(left: string | undefined, right: string | undefined): boolean {
  return normalizeUuid(left) === normalizeUuid(right);
}

function isUnableToLoadShowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable\s+to\s+load\s+show/i.test(message);
}

function normalizeUuid(value: string | undefined): string {
  return String(value || "").trim().replace(/^urn:uuid:/i, "").toLowerCase();
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function formatFrameTimecode(value: number, fps = DEFAULT_FPS): string {
  if (!Number.isFinite(value) || value < 0) {
    return "00:00:00:00";
  }
  const totalFrames = Math.round(value * fps);
  const framesPerHour = fps * 60 * 60;
  const framesPerMinute = fps * 60;
  const hours = Math.floor(totalFrames / framesPerHour);
  const minutes = Math.floor((totalFrames % framesPerHour) / framesPerMinute);
  const seconds = Math.floor((totalFrames % framesPerMinute) / fps);
  const frames = totalFrames % fps;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
    String(frames).padStart(2, "0"),
  ].join(":");
}

function asRecord(value: unknown): Record<string, unknown> {
  return asRecordOrNull(value) ?? {};
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

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatLocalDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
