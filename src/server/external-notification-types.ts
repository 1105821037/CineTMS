import type { NotificationSeverity } from "./notification-types";

export type ExternalNotificationChannelType = "serverchan-v3" | "serverchan-turbo";
export type ExternalNotificationEventKey =
  | "all"
  | "runtime"
  | "runtime.device"
  | "runtime.device.online"
  | "runtime.device.offline"
  | "runtime.ingest"
  | "runtime.ingest.completed"
  | "runtime.ingest.failed"
  | "kdm"
  | "ticketing"
  | "ticketing.schedule-auto"
  | "ticketing.schedule-auto.added"
  | "ticketing.schedule-auto.cancelled"
  | "ticketing.schedule-auto.failed"
  | "system"
  | "system.film-schedule"
  | "system.film-schedule.play-started"
  | "system.film-schedule.show-corrected"
  | "system.film-schedule.temporary-show"
  | "system.film-schedule.action-failed"
  | "system.film-schedule.failed"
  | "system.film-schedule.monitor-lost"
  | "system.film-schedule.monitor-timeout"
  | "system.film-schedule.aborted";

export interface ServerChanChannelConfig {
  readonly sendKey: string;
}

export interface ExternalNotificationChannel {
  readonly id: string;
  readonly name: string;
  readonly type: ExternalNotificationChannelType;
  readonly enabled: boolean;
  readonly config: ServerChanChannelConfig;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ExternalNotificationPolicy {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly channelIds: readonly string[];
  readonly eventKeys: readonly ExternalNotificationEventKey[];
  readonly minSeverity: NotificationSeverity;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ExternalNotificationSettings {
  readonly enabled: boolean;
  readonly channels: readonly ExternalNotificationChannel[];
  readonly policies: readonly ExternalNotificationPolicy[];
  readonly updatedAt?: string;
}

export type SaveExternalNotificationSettingsInput = Omit<ExternalNotificationSettings, "updatedAt">;
