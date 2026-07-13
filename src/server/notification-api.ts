import type { IncomingMessage, ServerResponse } from "node:http";
import { getActivityService } from "./activity-service";
import { readJsonBody, sendJson } from "./http";
import { getNotificationService } from "./notification-service";
import type {
  ActivityListFilter,
  ActivityStatus,
  NotificationListFilter,
  NotificationSeverity,
  NotificationSource,
  NotificationStatus,
} from "./notification-types";
import { requireSession } from "./session";

export async function handleNotificationApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith("/api/notifications") && !pathname.startsWith("/api/activities")) {
    return false;
  }

  const session = await requireSession(request);
  const notificationService = getNotificationService();
  const activityService = getActivityService();

  if (request.method === "GET" && pathname === "/api/notifications") {
    const notifications = await notificationService.list(parseNotificationFilter(searchParams));
    sendJson(response, 200, { ok: true, notifications });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/notifications/summary") {
    sendJson(response, 200, { ok: true, summary: await notificationService.summary() });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/notifications/read-all") {
    const count = await notificationService.markAllRead();
    await activityService.create({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "notification.read-all",
      objectType: "notification",
      status: "success",
      payload: { count },
    }).catch(() => undefined);
    sendJson(response, 200, { ok: true, count, summary: await notificationService.summary() });
    return true;
  }

  const notificationActionMatch = /^\/api\/notifications\/([^/]+)\/(read|dismiss|resolve)$/.exec(pathname);
  if (request.method === "POST" && notificationActionMatch) {
    const id = decodeURIComponent(notificationActionMatch[1]);
    const action = notificationActionMatch[2];
    const body = await readJsonBody(request).catch(() => ({}));
    const notification =
      action === "read"
        ? await notificationService.markRead(id)
        : action === "dismiss"
          ? await notificationService.dismiss(id)
          : await notificationService.resolve(id);

    if (!notification) {
      sendJson(response, 404, { ok: false, error: "Notification not found" });
      return true;
    }

    await activityService.create({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: `notification.${action}`,
      objectType: "notification",
      objectId: id,
      status: "success",
      payload: body,
    }).catch(() => undefined);

    sendJson(response, 200, {
      ok: true,
      notification,
      summary: await notificationService.summary(),
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/activities") {
    const activities = await activityService.list(parseActivityFilter(searchParams));
    sendJson(response, 200, { ok: true, activities });
    return true;
  }

  return false;
}

function parseNotificationFilter(searchParams: URLSearchParams): NotificationListFilter {
  const status = readCsv(searchParams.get("status")) as NotificationStatus[];
  const severity = readCsv(searchParams.get("severity")) as NotificationSeverity[];
  const source = readCsv(searchParams.get("source")) as NotificationSource[];
  return {
    statuses: status.length ? status : undefined,
    severities: severity.length ? severity : undefined,
    sources: source.length ? source : undefined,
    hallId: readNonEmpty(searchParams.get("hallId")),
    unreadOnly: searchParams.get("unreadOnly") === "true",
    activeOnly: searchParams.get("activeOnly") === "true",
    limit: readLimit(searchParams.get("limit")),
  };
}

function parseActivityFilter(searchParams: URLSearchParams): ActivityListFilter {
  const status = readNonEmpty(searchParams.get("status")) as ActivityStatus | undefined;
  return {
    actorId: readNonEmpty(searchParams.get("actorId")),
    actorType: readNonEmpty(searchParams.get("actorType")) as ActivityListFilter["actorType"],
    action: readNonEmpty(searchParams.get("action")),
    objectType: readNonEmpty(searchParams.get("objectType")),
    hallId: readNonEmpty(searchParams.get("hallId")),
    status,
    limit: readLimit(searchParams.get("limit")),
  };
}

function readCsv(value: string | null): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readNonEmpty(value: string | null): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLimit(value: string | null): number | undefined {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}
