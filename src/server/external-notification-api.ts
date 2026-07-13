import type { IncomingMessage, ServerResponse } from "node:http";
import { getActivityService } from "./activity-service";
import type { ExternalNotificationChannel } from "./external-notification-types";
import { getExternalNotificationService } from "./external-notification-service";
import { readJsonBody, sendJson } from "./http";
import { requireSession } from "./session";

export async function handleExternalNotificationApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/external-notifications")) {
    return false;
  }

  const session = await requireSession(request);
  const service = getExternalNotificationService();
  const activityService = getActivityService();

  if (request.method === "GET" && pathname === "/api/external-notifications/settings") {
    sendJson(response, 200, { ok: true, settings: await service.readSettings() });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/external-notifications/settings") {
    const body = await readJsonBody(request);
    const settings = await activityService.capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "external-notification.settings.update",
      objectType: "external-notification-settings",
      payload: sanitizeSettingsActivityPayload(body),
    }, async () => service.saveSettings({
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
      channels: Array.isArray(body.channels) ? body.channels as ExternalNotificationChannel[] : [],
      policies: Array.isArray(body.policies) ? body.policies as never[] : [],
    }));

    sendJson(response, 200, { ok: true, settings });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/external-notifications/test") {
    const body = await readJsonBody(request);
    const channel = readChannelFromBody(body);
    await activityService.capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "external-notification.channel.test",
      objectType: "external-notification-channel",
      objectId: channel.id,
      objectName: channel.name,
      payload: {
        channelId: channel.id,
        name: channel.name,
        type: channel.type,
      },
    }, async () => {
      await service.testChannel(channel);
    });

    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

function readChannelFromBody(body: Record<string, unknown>): ExternalNotificationChannel {
  const raw = body.channel;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("缺少测试渠道配置。");
  }

  const channel = raw as ExternalNotificationChannel;
  if (!isSupportedChannelType(channel.type) || !channel.config?.sendKey) {
    throw new Error("请先填写 ServerChan SendKey。");
  }
  return {
    id: typeof channel.id === "string" && channel.id.trim() ? channel.id.trim() : "test-channel",
    name: typeof channel.name === "string" && channel.name.trim() ? channel.name.trim() : describeChannelType(channel.type),
    type: channel.type,
    enabled: true,
    config: {
      sendKey: String(channel.config.sendKey || "").trim(),
    },
  };
}

function isSupportedChannelType(type: unknown): type is ExternalNotificationChannel["type"] {
  return type === "serverchan-v3" || type === "serverchan-turbo";
}

function describeChannelType(type: ExternalNotificationChannel["type"]): string {
  return type === "serverchan-v3" ? "ServerChan v3" : "ServerChan Turbo";
}

function sanitizeSettingsActivityPayload(value: Record<string, unknown>): Record<string, unknown> {
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    channels: Array.isArray(value.channels)
      ? value.channels.map((item) => sanitizeChannel(item))
      : [],
    policies: Array.isArray(value.policies) ? value.policies : [],
  };
}

function sanitizeChannel(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...record,
    config: {
      ...(record.config && typeof record.config === "object" && !Array.isArray(record.config)
        ? record.config as Record<string, unknown>
        : {}),
      sendKey: "[redacted]",
    },
  };
}
