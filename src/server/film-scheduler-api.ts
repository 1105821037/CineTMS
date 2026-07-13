import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, readJsonBody, sendJson } from "./http";
import { requireSession } from "./session";
import {
  listFilmScheduleActionExecutions,
  listFilmScheduleRuntimeRecords,
  listFilmSchedulerManagedHalls,
  setFilmSchedulerManagedHall,
} from "./film-scheduler-store";
import { getFilmScheduleAutoScheduler } from "./film-schedule-auto-scheduler";
import { getFilmSchedulerEngine } from "./film-scheduler-engine";

export async function handleFilmSchedulerApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith("/api/film-scheduler")) {
    return false;
  }

  await requireSession(request);

  if (request.method === "GET" && pathname === "/api/film-scheduler/status") {
    const showDate = readDateParam(searchParams.get("date"));
    const [runtimes, actions] = await Promise.all([
      listFilmScheduleRuntimeRecords(showDate),
      listFilmScheduleActionExecutions({ showDate, limit: 500 }),
    ]);
    sendJson(response, 200, {
      ok: true,
      showDate,
      runtimes,
      actions,
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/film-scheduler/managed-halls") {
    const managedHalls = await listFilmSchedulerManagedHalls();
    sendJson(response, 200, { ok: true, managedHalls });
    return true;
  }

  const managedHallMatch = /^\/api\/film-scheduler\/managed-halls\/([^/]+)$/.exec(pathname);
  if (request.method === "POST" && managedHallMatch) {
    const hallId = decodeURIComponent(managedHallMatch[1]);
    const body = await readJsonBody(request);
    const autoDisableAt = body.enabled === true
      ? resolveManagedAutoDisableAt(body.autoDisableAt)
      : undefined;
    const managedHall = await setFilmSchedulerManagedHall(hallId, body.enabled === true, {
      alignFeatureStart: body.alignFeatureStart !== false,
      autoDisableAt,
    });
    if (managedHall.enabled) {
      getFilmScheduleAutoScheduler().runSoon();
    }
    sendJson(response, 200, { ok: true, managedHall });
    return true;
  }

  const exitMonitoringMatch = /^\/api\/film-scheduler\/schedules\/([^/]+)\/exit-monitoring$/.exec(pathname);
  if (request.method === "POST" && exitMonitoringMatch) {
    const scheduleId = decodeURIComponent(exitMonitoringMatch[1]);
    const body = await readJsonBody(request);
    const runtime = await getFilmSchedulerEngine().exitScheduleMonitoring(scheduleId, {
      hallId: typeof body.hallId === "string" ? body.hallId.trim() : undefined,
      reason: typeof body.reason === "string" ? body.reason.trim() : undefined,
    });
    sendJson(response, 200, { ok: true, runtime });
    return true;
  }

  const scheduleActionsMatch = /^\/api\/film-scheduler\/schedules\/([^/]+)\/actions$/.exec(pathname);
  if (request.method === "GET" && scheduleActionsMatch) {
    const scheduleId = decodeURIComponent(scheduleActionsMatch[1]);
    const actions = await listFilmScheduleActionExecutions({ scheduleId, limit: 500 });
    sendJson(response, 200, { ok: true, scheduleId, actions });
    return true;
  }

  return false;
}

function readDateParam(value: string | null | undefined): string {
  const raw = value || formatLocalDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("日期格式不正确。");
  }
  return raw;
}

function resolveManagedAutoDisableAt(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "自动关闭时间格式不正确。");
  }
  if (date.getTime() <= Date.now()) {
    throw new ApiError(400, "自动关闭时间必须晚于当前时间。");
  }
  return raw;
}

function formatLocalDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
