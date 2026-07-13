import { randomUUID } from "node:crypto";
import type { HallDeviceEvent } from "../runtime";
import {
  createNotification,
  findActiveNotificationByDedupeKey,
  listNotifications,
  markAllNotificationsRead,
  readNotificationSummary,
  resolveNotificationsByDedupeKey,
  updateNotificationStatus,
} from "./notification-store";
import type {
  CreateNotificationInput,
  NotificationListFilter,
  NotificationRecord,
  NotificationSummary,
} from "./notification-types";
import { getExternalNotificationService } from "./external-notification-service";
import { readIngestTaskByIngestUuid } from "./ingest-task-store";
import { getRealtimeHub } from "./realtime-hub";

export class NotificationService {
  async create(input: CreateNotificationInput): Promise<NotificationRecord | null> {
    const normalized = {
      ...input,
      id: input.id ?? `notification-${randomUUID()}`,
      status: input.status ?? "unread",
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      payload: input.payload ?? {},
    };

    if (normalized.dedupeKey && (normalized.status === "unread" || normalized.status === "read")) {
      const existing = await findActiveNotificationByDedupeKey(normalized.dedupeKey);
      if (existing) {
        const updated = await createNotification({
          ...normalized,
          id: existing.id,
          status: existing.status,
        });
        await this.broadcastNotificationChange(updated);
        return updated;
      }
    }

    const created = await createNotification(normalized);
    await this.broadcastNotificationChange(created);
    this.dispatchExternalNotification(created);
    return created;
  }

  list(filter: NotificationListFilter = {}): Promise<NotificationRecord[]> {
    return listNotifications(filter);
  }

  summary(): Promise<NotificationSummary> {
    return readNotificationSummary();
  }

  async markRead(id: string): Promise<NotificationRecord | null> {
    const notification = await updateNotificationStatus(id, "read");
    await this.broadcastNotificationChange(notification);
    return notification;
  }

  markAllRead(): Promise<number> {
    return markAllNotificationsRead().then(async (count) => {
      getRealtimeHub().broadcast("notification-summary", await this.summary());
      return count;
    });
  }

  async dismiss(id: string): Promise<NotificationRecord | null> {
    const notification = await updateNotificationStatus(id, "dismissed");
    await this.broadcastNotificationChange(notification);
    return notification;
  }

  async resolve(id: string): Promise<NotificationRecord | null> {
    const notification = await updateNotificationStatus(id, "resolved");
    await this.broadcastNotificationChange(notification);
    return notification;
  }

  async ingestRuntimeEvent(event: HallDeviceEvent): Promise<NotificationRecord | null> {
    const recoveryKeys = this.resolveRecoveryDedupeKeys(event);
    for (const recovery of recoveryKeys) {
      const resolvedCount = await resolveNotificationsByDedupeKey(recovery);
      if (resolvedCount > 0) {
        getRealtimeHub().broadcast("notification-summary", await this.summary());
      }
    }

    const input = await this.createRuntimeNotificationInput(event);
    return input ? this.create(input) : null;
  }

  private async createRuntimeNotificationInput(event: HallDeviceEvent): Promise<CreateNotificationInput | null> {
    const hallId = event.hallId;
    const hallName = typeof event.payload.hallName === "string" ? event.payload.hallName : event.hallName;
    const hallLabel = hallName?.trim() || `影厅 ${hallId}`;
    const base = {
      source: "runtime" as const,
      hallId,
      objectType: "hall",
      objectId: hallId,
      occurredAt: event.occurredAt,
      payload: {
        eventId: event.eventId,
        eventType: event.type,
        deviceId: event.deviceId,
        ...event.payload,
      },
    };

    switch (event.type) {
      case "DEVICE_ONLINE":
        if (event.payload.previousState !== "offline") {
          return null;
        }

        return {
          ...base,
          type: "RUNTIME_DEVICE_ONLINE",
          severity: "info",
          title: `${hallLabel}上线`,
          message: "放映服务器心跳恢复，设备已重新在线。",
        };
      case "DEVICE_OFFLINE":
        return {
          ...base,
          type: "RUNTIME_DEVICE_OFFLINE",
          severity: "error",
          title: `${hallLabel}离线`,
          message: "放映服务器连接中断，请检查网络、设备电源或 GDC 服务状态。",
          dedupeKey: `runtime:${hallId}:device-offline`,
        };
      case "INGEST_FAILED":
        if (!await this.hasLocalIngestTask(event)) {
          return null;
        }

        return {
          ...base,
          type: "RUNTIME_INGEST_FAILED",
          severity: "error",
          title: `${hallLabel}导入失败`,
          message: String(event.payload.description || "内容导入任务失败，请查看导入状态。"),
          objectType: "ingest",
          objectId: typeof event.payload.ingestUuid === "string" ? event.payload.ingestUuid : undefined,
          dedupeKey: `runtime:${hallId}:ingest:${String(event.payload.ingestUuid || event.eventId)}`,
        };
      case "INGEST_COMPLETED":
        if (!await this.hasLocalIngestTask(event)) {
          return null;
        }

        return {
          ...base,
          type: "RUNTIME_INGEST_COMPLETED",
          severity: "info",
          title: `${hallLabel}导入完成`,
          message: String(event.payload.description || "内容导入任务已完成。"),
          objectType: "ingest",
          objectId: typeof event.payload.ingestUuid === "string" ? event.payload.ingestUuid : undefined,
          dedupeKey: `runtime:${hallId}:ingest:${String(event.payload.ingestUuid || event.eventId)}:completed`,
        };
      case "PLAYBACK_FAILED":
        return {
          ...base,
          type: "RUNTIME_PLAYBACK_FAILED",
          severity: "critical",
          title: `${hallLabel}播放失败`,
          message: "当前播放任务发生错误，请立即检查放映状态。",
          objectType: "playback",
          objectId: typeof event.payload.showUuid === "string" ? event.payload.showUuid : undefined,
          dedupeKey: `runtime:${hallId}:playback-failed`,
        };
      default:
        return null;
    }
  }

  private async hasLocalIngestTask(event: HallDeviceEvent): Promise<boolean> {
    const ingestUuid = typeof event.payload.ingestUuid === "string" ? event.payload.ingestUuid.trim() : "";
    if (!ingestUuid) {
      return false;
    }
    return Boolean(await readIngestTaskByIngestUuid(ingestUuid));
  }

  private resolveRecoveryDedupeKeys(event: HallDeviceEvent): string[] {
    if (event.type === "DEVICE_ONLINE") {
      return [
        `runtime:${event.hallId}:device-offline`,
        `runtime:${event.hallId}:device-backoff`,
        `runtime:${event.hallId}:device-degraded`,
      ];
    }

    if (event.type === "INGEST_COMPLETED" && typeof event.payload.ingestUuid === "string") {
      return [`runtime:${event.hallId}:ingest:${event.payload.ingestUuid}`];
    }

    return [];
  }

  private async broadcastNotificationChange(notification: NotificationRecord | null): Promise<void> {
    if (!notification) {
      return;
    }

    const hub = getRealtimeHub();
    hub.broadcast("notification", notification);
    hub.broadcast("notification-summary", await this.summary());
  }

  private dispatchExternalNotification(notification: NotificationRecord | null): void {
    if (!notification || notification.status !== "unread") {
      return;
    }

    void getExternalNotificationService().dispatch(notification).catch((error) => {
      console.warn("External notification dispatch failed:", error);
    });
  }
}

let notificationServiceSingleton: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  notificationServiceSingleton ??= new NotificationService();
  return notificationServiceSingleton;
}
