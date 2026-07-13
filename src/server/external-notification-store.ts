import mysql from "mysql2/promise";
import {
  createDatabaseConnection,
  ensureSetupSchema,
} from "./setup-store";
import type {
  ExternalNotificationChannel,
  ExternalNotificationPolicy,
  ExternalNotificationSettings,
  SaveExternalNotificationSettingsInput,
} from "./external-notification-types";
import type { NotificationSeverity } from "./notification-types";

const configKey = "notification.external";
const channelTypes = new Set(["serverchan-v3", "serverchan-turbo"]);
const severities = new Set(["info", "warning", "error", "critical"]);
const eventKeys = new Set([
  "all",
  "runtime",
  "runtime.device",
  "runtime.device.online",
  "runtime.device.offline",
  "runtime.ingest",
  "runtime.ingest.completed",
  "runtime.ingest.failed",
  "kdm",
  "ticketing",
  "ticketing.schedule-auto",
  "ticketing.schedule-auto.added",
  "ticketing.schedule-auto.cancelled",
  "ticketing.schedule-auto.failed",
  "system",
  "system.film-schedule",
  "system.film-schedule.play-started",
  "system.film-schedule.show-corrected",
  "system.film-schedule.temporary-show",
  "system.film-schedule.action-failed",
  "system.film-schedule.failed",
  "system.film-schedule.monitor-lost",
  "system.film-schedule.monitor-timeout",
  "system.film-schedule.aborted",
]);

export async function readExternalNotificationSettings(): Promise<ExternalNotificationSettings> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT config_value FROM tms_config WHERE config_key = ?",
      [configKey],
    );
    const value = rows[0]?.config_value;
    return normalizeSettings(typeof value === "string" ? JSON.parse(value) : value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return defaultSettings();
    }
    throw error;
  } finally {
    await connection.end();
  }
}

export async function saveExternalNotificationSettings(
  input: SaveExternalNotificationSettingsInput,
): Promise<ExternalNotificationSettings> {
  const connection = await createDatabaseConnection();
  const normalized = normalizeSettings({
    ...input,
    updatedAt: new Date().toISOString(),
  });

  try {
    await ensureSetupSchema(connection);
    await connection.execute(
      `
        INSERT INTO tms_config (config_key, config_value)
        VALUES (?, CAST(? AS JSON))
        ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)
      `,
      [configKey, JSON.stringify(normalized)],
    );
    return normalized;
  } finally {
    await connection.end();
  }
}

function defaultSettings(): ExternalNotificationSettings {
  return {
    enabled: true,
    channels: [],
    policies: [],
  };
}

function normalizeSettings(value: unknown): ExternalNotificationSettings {
  const record = isRecord(value) ? value : {};
  const now = new Date().toISOString();
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    channels: readArray(record.channels).map((item) => normalizeChannel(item, now)),
    policies: readArray(record.policies).map((item) => normalizePolicy(item, now)),
    updatedAt: readOptionalString(record.updatedAt),
  };
}

function normalizeChannel(value: unknown, fallbackTime: string): ExternalNotificationChannel {
  const record = requireRecord(value, "通知渠道配置无效。");
  const id = readCleanString(record.id) || `channel-${Date.now()}`;
  const config = requireRecord(record.config, "通知渠道参数无效。");
  const type = readCleanString(record.type) as ExternalNotificationChannel["type"];
  if (!channelTypes.has(type)) {
    throw new Error("暂不支持该外部通知渠道类型。");
  }

  const sendKey = readCleanString(config.sendKey);
  if (!sendKey) {
    throw new Error("ServerChan SendKey 不能为空。");
  }

  return {
    id,
    name: readCleanString(record.name) || describeChannelType(type),
    type,
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    config: { sendKey },
    createdAt: readOptionalString(record.createdAt) || fallbackTime,
    updatedAt: fallbackTime,
  };
}

function normalizePolicy(value: unknown, fallbackTime: string): ExternalNotificationPolicy {
  const record = requireRecord(value, "通知策略配置无效。");
  const id = readCleanString(record.id) || `policy-${Date.now()}`;
  const channelIds = readStringList(record.channelIds);
  if (channelIds.length === 0) {
    throw new Error("通知策略至少需要选择一个通知渠道。");
  }
  const minSeverity = readCleanString(record.minSeverity);
  const selectedEventKeys = readStringList(record.eventKeys).filter((item) => eventKeys.has(item));
  if (selectedEventKeys.length === 0) {
    throw new Error("通知策略至少需要选择一个事件。");
  }

  return {
    id,
    name: readCleanString(record.name) || "未命名策略",
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    channelIds,
    eventKeys: selectedEventKeys as ExternalNotificationPolicy["eventKeys"],
    minSeverity: severities.has(minSeverity) ? minSeverity as NotificationSeverity : "warning",
    createdAt: readOptionalString(record.createdAt) || fallbackTime,
    updatedAt: fallbackTime,
  };
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => readCleanString(item))
    .filter((item, index, array) => item && array.indexOf(item) === index);
}

function readCleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: unknown): string | undefined {
  const text = readCleanString(value);
  return text || undefined;
}

function describeChannelType(type: string): string {
  if (type === "serverchan-v3") {
    return "ServerChan v3";
  }
  if (type === "serverchan-turbo") {
    return "ServerChan Turbo";
  }
  return "通知渠道";
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
