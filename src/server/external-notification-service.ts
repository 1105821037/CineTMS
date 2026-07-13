import {
  readExternalNotificationSettings,
  saveExternalNotificationSettings,
} from "./external-notification-store";
import type {
  ExternalNotificationChannel,
  ExternalNotificationPolicy,
  ExternalNotificationSettings,
  SaveExternalNotificationSettingsInput,
} from "./external-notification-types";
import type { NotificationRecord, NotificationSeverity } from "./notification-types";

interface DeliveryTarget {
  readonly channel: ExternalNotificationChannel;
  readonly policy: ExternalNotificationPolicy;
}

export class ExternalNotificationService {
  readSettings(): Promise<ExternalNotificationSettings> {
    return readExternalNotificationSettings();
  }

  saveSettings(input: SaveExternalNotificationSettingsInput): Promise<ExternalNotificationSettings> {
    return saveExternalNotificationSettings(input);
  }

  async dispatch(notification: NotificationRecord): Promise<void> {
    const settings = await this.readSettings().catch((error) => {
      console.warn("Failed to read external notification settings:", error);
      return null;
    });
    if (!settings?.enabled) {
      return;
    }

    const targets = this.resolveTargets(settings, notification);
    await Promise.allSettled(targets.map((target) => this.send(target.channel, target.policy, notification)))
      .then((results) => {
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            const channel = targets[index]?.channel;
            console.warn(`External notification delivery failed (${channel?.name || "unknown"}):`, result.reason);
          }
        });
      });
  }

  async testChannel(channel: ExternalNotificationChannel): Promise<void> {
    await this.sendServerChan(channel, {
      title: "CineTMS 外部通知测试",
      markdown: [
        "这是一条来自 CineTMS 的测试通知。",
        "",
        `发送时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      ].join("\n"),
    });
  }

  private resolveTargets(
    settings: ExternalNotificationSettings,
    notification: NotificationRecord,
  ): DeliveryTarget[] {
    const enabledChannels = new Map(
      settings.channels
        .filter((channel) => channel.enabled)
        .map((channel) => [channel.id, channel]),
    );
    const seen = new Set<string>();
    const targets: DeliveryTarget[] = [];

    for (const policy of settings.policies) {
      if (!policy.enabled || !this.matchesPolicy(policy, notification)) {
        continue;
      }

      for (const channelId of policy.channelIds) {
        const channel = enabledChannels.get(channelId);
        if (!channel) {
          continue;
        }

        const key = `${policy.id}:${channel.id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        targets.push({ channel, policy });
      }
    }

    return targets;
  }

  private matchesPolicy(policy: ExternalNotificationPolicy, notification: NotificationRecord): boolean {
    return severityRank(notification.severity) >= severityRank(policy.minSeverity)
      && matchesPolicyEvent(policy.eventKeys, notification);
  }

  private async send(
    channel: ExternalNotificationChannel,
    policy: ExternalNotificationPolicy,
    notification: NotificationRecord,
  ): Promise<void> {
    if (channel.type !== "serverchan-v3" && channel.type !== "serverchan-turbo") {
      return;
    }

    await this.sendServerChan(channel, buildServerChanMessage(policy, notification));
  }

  private async sendServerChan(
    channel: ExternalNotificationChannel,
    message: { readonly title: string; readonly markdown: string },
  ): Promise<void> {
    const endpoint = resolveServerChanEndpoint(channel);
    const body = new URLSearchParams({
      title: message.title.slice(0, 100),
      desp: message.markdown,
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;

    if (!response.ok) {
      throw new Error(`ServerChan HTTP ${response.status}`);
    }

    const code = Number(payload?.code ?? 0);
    if (Number.isFinite(code) && code !== 0) {
      throw new Error(String(payload?.message || payload?.msg || "ServerChan 返回发送失败。"));
    }
  }
}

function resolveServerChanEndpoint(channel: ExternalNotificationChannel): string {
  const sendKey = channel.config.sendKey.trim();
  if (!sendKey) {
    throw new Error("ServerChan SendKey 不能为空。");
  }

  if (channel.type === "serverchan-v3") {
    const uid = extractServerChanUid(sendKey);
    if (!uid) {
      throw new Error("ServerChan v3 需要填写 sctp... 格式的 SendKey，以便从 key 中提取 uid。");
    }
    return `https://${encodeURIComponent(uid)}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send`;
  }

  return `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
}

function extractServerChanUid(sendKey: string): string {
  return /^sctp(\d+)t/.exec(sendKey)?.[1] || "";
}

function buildServerChanMessage(
  policy: ExternalNotificationPolicy,
  notification: NotificationRecord,
): { readonly title: string; readonly markdown: string } {
  const severityLabel = severityText(notification.severity);
  const title = `[${severityLabel}] ${notification.title}`;
  const lines = [
    `## ${notification.title}`,
    "",
    notification.message,
    "",
    `- 策略：${policy.name}`,
    `- 级别：${severityLabel}`,
    `- 来源：${sourceText(notification.source)}`,
    `- 类型：${notification.type}`,
    notification.hallId ? `- 影厅：${notification.hallId}` : "",
    `- 时间：${formatDateTime(notification.occurredAt)}`,
  ].filter(Boolean);

  return { title, markdown: lines.join("\n") };
}

function matchesPolicyEvent(eventKeys: ExternalNotificationPolicy["eventKeys"], notification: NotificationRecord): boolean {
  if (eventKeys.includes("all")) {
    return true;
  }

  const actualKeys = notificationEventKeys(notification);
  return eventKeys.some((eventKey) => actualKeys.includes(eventKey));
}

function notificationEventKeys(notification: NotificationRecord): string[] {
  const eventKeyByType: Record<string, readonly string[]> = {
    RUNTIME_DEVICE_ONLINE: ["runtime", "runtime.device", "runtime.device.online"],
    RUNTIME_DEVICE_OFFLINE: ["runtime", "runtime.device", "runtime.device.offline"],
    RUNTIME_INGEST_COMPLETED: ["runtime", "runtime.ingest", "runtime.ingest.completed"],
    RUNTIME_INGEST_FAILED: ["runtime", "runtime.ingest", "runtime.ingest.failed"],
    RUNTIME_PLAYBACK_FAILED: ["runtime", "runtime.playback", "runtime.playback.failed"],
    FILM_SCHEDULE_AUTO_ADDED: ["ticketing", "ticketing.schedule-auto", "ticketing.schedule-auto.added"],
    FILM_SCHEDULE_AUTO_CANCELLED: ["ticketing", "ticketing.schedule-auto", "ticketing.schedule-auto.cancelled"],
    FILM_SCHEDULE_AUTO_FAILED: ["ticketing", "ticketing.schedule-auto", "ticketing.schedule-auto.failed"],
    FILM_SCHEDULE_PLAY_STARTED: ["system", "system.film-schedule", "system.film-schedule.play-started"],
    FILM_SCHEDULE_SHOW_UUID_CORRECTED: ["system", "system.film-schedule", "system.film-schedule.show-corrected"],
    FILM_SCHEDULE_TEMPORARY_SHOW_CREATED: ["system", "system.film-schedule", "system.film-schedule.temporary-show"],
    FILM_SCHEDULE_ACTION_FAILED: ["system", "system.film-schedule", "system.film-schedule.action-failed"],
    FILM_SCHEDULE_FAILED: ["system", "system.film-schedule", "system.film-schedule.failed"],
    FILM_SCHEDULE_MONITOR_LOST: ["system", "system.film-schedule", "system.film-schedule.monitor-lost"],
    FILM_SCHEDULE_MONITOR_TIMEOUT: ["system", "system.film-schedule", "system.film-schedule.monitor-timeout"],
    FILM_SCHEDULE_ABORTED: ["system", "system.film-schedule", "system.film-schedule.aborted"],
  };

  return [...(eventKeyByType[notification.type] || [notification.source])];
}

function severityRank(severity: NotificationSeverity): number {
  const ranks: Record<NotificationSeverity, number> = {
    info: 0,
    warning: 1,
    error: 2,
    critical: 3,
  };
  return ranks[severity] ?? 0;
}

function severityText(severity: string): string {
  const map: Record<string, string> = {
    info: "提示",
    warning: "警告",
    error: "错误",
    critical: "严重",
  };
  return map[severity] || severity;
}

function sourceText(source: string): string {
  const map: Record<string, string> = {
    runtime: "放映运行",
    ticketing: "售票系统",
    kdm: "KDM",
    system: "系统",
  };
  return map[source] || source;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

let externalNotificationServiceSingleton: ExternalNotificationService | null = null;

export function getExternalNotificationService(): ExternalNotificationService {
  externalNotificationServiceSingleton ??= new ExternalNotificationService();
  return externalNotificationServiceSingleton;
}
