import { hostname } from "node:os";
import {
  createFilmScheduleEntry,
  deleteFilmScheduleEntry,
  listFilmScheduleEntries,
  type FilmScheduleEntry,
} from "./film-schedule-store";
import { estimateScheduleEndTime, listTicketingSchedule, type TicketingScheduleSession } from "./film-schedule-api";
import { listFilmPlaybackRules, type FilmPlaybackRule } from "./film-playback-store";
import { listEnabledFilmSchedulerManagedHalls, type FilmSchedulerManagedHall } from "./film-scheduler-store";
import { getNotificationService } from "./notification-service";
import { getRealtimeHub } from "./realtime-hub";

const AUTO_SCHEDULER_INTERVAL_MS = 60_000;

export class FilmScheduleAutoScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.scheduleNextRun(5_000);
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  runSoon(): void {
    if (!this.started) {
      return;
    }
    this.scheduleNextRun(500);
  }

  private scheduleNextRun(delayMs: number): void {
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
      this.scheduleNextRun(AUTO_SCHEDULER_INTERVAL_MS);
      return;
    }

    this.running = true;
    try {
      await this.syncToday();
    } catch (error) {
      console.error("Film schedule auto scheduler tick failed:", error);
    } finally {
      this.running = false;
      this.scheduleNextRun(AUTO_SCHEDULER_INTERVAL_MS);
    }
  }

  private async syncToday(now = new Date()): Promise<void> {
    const managedHalls = await listEnabledFilmSchedulerManagedHalls().catch(() => []);
    const managedHallMap = new Map(managedHalls.map((hall) => [hall.hallId, hall]));
    if (managedHallMap.size === 0) {
      return;
    }

    const showDate = formatLocalDate(now);
    const [ticketing, entries, rules] = await Promise.all([
      listTicketingSchedule(showDate),
      listFilmScheduleEntries(showDate),
      listFilmPlaybackRules(),
    ]);

    const sessions = ticketing.sessions.filter((session) => managedHallMap.has(session.hallId));
    for (const session of sessions) {
      const managedHall = managedHallMap.get(session.hallId);
      try {
        await this.syncSession(now, session, managedHall, entries, rules);
      } catch (error) {
        console.error("Failed to sync ticketing session for auto scheduler:", error);
        await this.notifyUnexpectedFailure(session, managedHall, error).catch((notifyError) => {
          console.error("Failed to notify auto scheduler failure:", notifyError);
        });
      }
    }
  }

  private async syncSession(
    now: Date,
    session: TicketingScheduleSession,
    managedHall: FilmSchedulerManagedHall | undefined,
    entries: readonly FilmScheduleEntry[],
    rules: readonly FilmPlaybackRule[],
  ): Promise<void> {
    const existing = findEntryForTicketingSession(entries, session);
    const autoEntry = existing?.autoManaged ? existing : undefined;
    const hasAudience = hasTicketingAudience(session);

    if (!hasAudience) {
      if (autoEntry && Date.parse(autoEntry.startTime) > now.getTime()) {
        const deleted = await deleteFilmScheduleEntry(autoEntry.id);
        this.broadcastEntryChange("deleted", deleted);
        await this.notifyCancelled(deleted, session);
      }
      return;
    }

    if (existing) {
      return;
    }

    const rule = findRuleForSession(rules, session);
    if (!rule) {
      if (isFutureScheduleStart(now, session.startTime)) {
        await this.notifyMissingRule(session, managedHall);
      }
      return;
    }
    const alignFeatureStart = managedHall?.alignFeatureStart !== false;
    const startTime = alignFeatureStart
      ? getAlignedScheduleStartTime(session.startTime, rule)
      : session.startTime;
    if (!isFutureScheduleStart(now, startTime)) {
      return;
    }

    const entryInput = {
      showDate: session.showDate,
      startTime,
      endTime: estimateScheduleEndTime(startTime, rule),
      hallId: session.hallId,
      hallName: session.hallName,
      finixxHallId: session.finixxHallId,
      filmCd: rule.filmCd,
      filmName: rule.filmName,
      filmVisual: rule.filmVisual,
      filmLanguage: rule.filmLanguage,
      ruleId: rule.id,
      ruleSnapshot: rule,
      source: "ticketing" as const,
      ticketingSessionId: getTicketingSessionKey(session),
      ticketingRaw: session.raw,
      notes: alignFeatureStart ? `自动排程器 ${hostname()} · 对齐正片时间` : `自动排程器 ${hostname()}`,
      autoManaged: true,
    };
    let entry: FilmScheduleEntry;
    try {
      entry = await createFilmScheduleEntry(entryInput);
    } catch (error) {
      await this.notifyCreateFailed(session, managedHall, error, {
        ruleId: rule.id,
        playlistName: rule.playlistName,
        startTime,
        endTime: entryInput.endTime,
        alignFeatureStart,
      });
      return;
    }
    this.broadcastEntryChange("created", entry);
    await this.notifyAdded(entry, session);
  }

  private broadcastEntryChange(action: "created" | "deleted", entry: FilmScheduleEntry): void {
    getRealtimeHub().broadcast("film-schedule-entry", {
      action,
      showDate: entry.showDate,
      entry,
    });
  }

  private async notifyAdded(entry: FilmScheduleEntry, session: TicketingScheduleSession): Promise<void> {
    await getNotificationService().create({
      type: "FILM_SCHEDULE_AUTO_ADDED",
      severity: "info",
      title: `${entry.hallName}已自动添加排期`,
      message: `${formatClock(entry.startTime)} ${entry.filmName} 已根据售票人数自动添加。`,
      source: "ticketing",
      objectType: "film-schedule-entry",
      objectId: entry.id,
      hallId: entry.hallId,
      dedupeKey: `film-schedule:auto:${entry.hallId}:${getTicketingSessionKey(session)}:added`,
      payload: {
        scheduleId: entry.id,
        hallId: entry.hallId,
        ticketingSessionId: getTicketingSessionKey(session),
        soldSeatsCount: session.soldSeatsCount,
        ticketingStartTime: session.startTime,
        alignFeatureStart: entry.startTime !== session.startTime,
        startTime: entry.startTime,
        filmName: entry.filmName,
      },
    });
  }

  private async notifyCancelled(entry: FilmScheduleEntry, session: TicketingScheduleSession): Promise<void> {
    await getNotificationService().create({
      type: "FILM_SCHEDULE_AUTO_CANCELLED",
      severity: "info",
      title: `${entry.hallName}已自动取消排期`,
      message: `${formatClock(entry.startTime)} ${entry.filmName} 因售票人数变为 0 已自动取消。`,
      source: "ticketing",
      objectType: "film-schedule-entry",
      objectId: entry.id,
      hallId: entry.hallId,
      dedupeKey: `film-schedule:auto:${entry.hallId}:${getTicketingSessionKey(session)}:cancelled`,
      payload: {
        scheduleId: entry.id,
        hallId: entry.hallId,
        ticketingSessionId: getTicketingSessionKey(session),
        soldSeatsCount: session.soldSeatsCount,
        startTime: entry.startTime,
        filmName: entry.filmName,
      },
    });
  }

  private async notifyMissingRule(
    session: TicketingScheduleSession,
    managedHall: FilmSchedulerManagedHall | undefined,
  ): Promise<void> {
    await this.notifyAutoFailed(session, {
      managedHall,
      reason: "missing-rule",
      message: `${formatClock(session.startTime)} ${session.filmName} 未找到对应影片放映模板，请先配置后再托管。`,
      payload: {},
    });
  }

  private async notifyCreateFailed(
    session: TicketingScheduleSession,
    managedHall: FilmSchedulerManagedHall | undefined,
    error: unknown,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.notifyAutoFailed(session, {
      managedHall,
      reason: "create-failed",
      severity: "error",
      message: `${formatClock(String(payload.startTime || session.startTime))} ${session.filmName} 自动添加排期失败：${formatErrorMessage(error)}`,
      payload,
    });
  }

  private async notifyUnexpectedFailure(
    session: TicketingScheduleSession,
    managedHall: FilmSchedulerManagedHall | undefined,
    error: unknown,
  ): Promise<void> {
    await this.notifyAutoFailed(session, {
      managedHall,
      reason: "unexpected",
      severity: "error",
      message: `${formatClock(session.startTime)} ${session.filmName} 自动排程处理失败：${formatErrorMessage(error)}`,
      payload: {},
    });
  }

  private async notifyAutoFailed(
    session: TicketingScheduleSession,
    options: {
      readonly managedHall?: FilmSchedulerManagedHall;
      readonly reason: string;
      readonly severity?: "warning" | "error";
      readonly message: string;
      readonly payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const ticketingSessionId = getTicketingSessionKey(session);
    const managedCycleKey = getManagedCycleKey(options.managedHall);
    await getNotificationService().create({
      type: "FILM_SCHEDULE_AUTO_FAILED",
      severity: options.severity ?? "warning",
      title: `${session.hallName}自动添加排期失败`,
      message: options.message,
      source: "ticketing",
      objectType: "ticketing-session",
      objectId: ticketingSessionId,
      hallId: session.hallId,
      dedupeKey: `film-schedule:auto:${session.hallId}:${ticketingSessionId}:${options.reason}:${managedCycleKey}`,
      payload: {
        hallId: session.hallId,
        hallName: session.hallName,
        ticketingSessionId,
        reason: options.reason,
        managedCycleKey,
        managedHallUpdatedAt: options.managedHall?.updatedAt,
        soldSeatsCount: session.soldSeatsCount,
        startTime: session.startTime,
        endTime: session.endTime,
        filmCd: session.filmCd,
        filmName: session.filmName,
        filmVisual: session.filmVisual,
        filmLanguage: session.filmLanguage,
        ...options.payload,
      },
    });
  }
}

let autoSchedulerSingleton: FilmScheduleAutoScheduler | null = null;

export function getFilmScheduleAutoScheduler(): FilmScheduleAutoScheduler {
  autoSchedulerSingleton ??= new FilmScheduleAutoScheduler();
  return autoSchedulerSingleton;
}

function findRuleForSession(
  rules: readonly FilmPlaybackRule[],
  session: TicketingScheduleSession,
): FilmPlaybackRule | undefined {
  return rules.find((rule) => (
    rule.filmCd === session.filmCd
    && Array.isArray(rule.hallIds)
    && rule.hallIds.includes(session.hallId)
  ));
}

function findEntryForTicketingSession(
  entries: readonly FilmScheduleEntry[],
  session: TicketingScheduleSession,
): FilmScheduleEntry | undefined {
  const ticketingSessionId = getTicketingSessionKey(session);
  return entries.find((entry) => (
    entry.ticketingSessionId === ticketingSessionId
    || (
      entry.hallId === session.hallId
      && entry.startTime === session.startTime
      && entry.source === "ticketing"
    )
  ));
}

function hasTicketingAudience(session: TicketingScheduleSession): boolean {
  const soldSeats = Number(session.soldSeatsCount);
  return Number.isFinite(soldSeats) && soldSeats > 0;
}

function isFutureScheduleStart(now: Date, startTime: string): boolean {
  const startMs = Date.parse(startTime);
  if (Number.isNaN(startMs)) {
    return false;
  }
  return startMs > now.getTime();
}

function getAlignedScheduleStartTime(startTime: string, rule: FilmPlaybackRule): string {
  const offsetSeconds = getFeatureStartOffsetSeconds(rule);
  return offsetSeconds > 0 ? addSeconds(startTime, -offsetSeconds) : startTime;
}

function getFeatureStartOffsetSeconds(rule: FilmPlaybackRule): number {
  const point = Array.isArray(rule.timePoints)
    ? rule.timePoints.find((item) => item?.type === "head")
    : null;
  const seconds = Number(point?.startSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
}

function addSeconds(value: string, seconds: number): string {
  const date = new Date(value);
  date.setSeconds(date.getSeconds() + seconds);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-") + "T" + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
}

function getTicketingSessionKey(session: TicketingScheduleSession): string {
  return session.ticketingSessionId || session.id;
}

function formatLocalDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatClock(value: string): string {
  const match = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  return match ? `${match[1]}:${match[2]}` : "--:--";
}

function getManagedCycleKey(managedHall: FilmSchedulerManagedHall | undefined): string {
  return (managedHall?.updatedAt || "unknown").replace(/[^0-9A-Za-z_-]/g, "");
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error || "未知错误");
}
