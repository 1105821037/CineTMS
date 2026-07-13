export type NotificationSeverity = "info" | "warning" | "error" | "critical";
export type NotificationSource = "runtime" | "ticketing" | "kdm" | "system";
export type NotificationStatus = "unread" | "read" | "resolved" | "dismissed";

export interface NotificationRecord {
  readonly id: string;
  readonly type: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly message: string;
  readonly source: NotificationSource;
  readonly objectType?: string;
  readonly objectId?: string;
  readonly hallId?: string;
  readonly status: NotificationStatus;
  readonly dedupeKey?: string;
  readonly occurredAt: string;
  readonly createdAt?: string;
  readonly readAt?: string;
  readonly resolvedAt?: string;
  readonly payload: Record<string, unknown>;
}

export interface CreateNotificationInput {
  readonly id?: string;
  readonly type: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly message: string;
  readonly source: NotificationSource;
  readonly objectType?: string;
  readonly objectId?: string;
  readonly hallId?: string;
  readonly status?: NotificationStatus;
  readonly dedupeKey?: string;
  readonly occurredAt?: string;
  readonly payload?: Record<string, unknown>;
}

export interface NotificationListFilter {
  readonly statuses?: readonly NotificationStatus[];
  readonly severities?: readonly NotificationSeverity[];
  readonly sources?: readonly NotificationSource[];
  readonly hallId?: string;
  readonly unreadOnly?: boolean;
  readonly activeOnly?: boolean;
  readonly limit?: number;
}

export interface NotificationSummary {
  readonly total: number;
  readonly unread: number;
  readonly active: number;
  readonly warning: number;
  readonly error: number;
  readonly critical: number;
}

export type ActivityActorType = "user" | "system";
export type ActivityStatus = "success" | "error";

export interface ActivityRecord {
  readonly id: string;
  readonly actorType: ActivityActorType;
  readonly actorId?: string;
  readonly actorName?: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId?: string;
  readonly objectName?: string;
  readonly hallId?: string;
  readonly status: ActivityStatus;
  readonly resultMessage?: string;
  readonly occurredAt: string;
  readonly durationMs?: number;
  readonly requestId?: string;
  readonly payload: Record<string, unknown>;
}

export interface CreateActivityInput {
  readonly id?: string;
  readonly actorType: ActivityActorType;
  readonly actorId?: string;
  readonly actorName?: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId?: string;
  readonly objectName?: string;
  readonly hallId?: string;
  readonly status: ActivityStatus;
  readonly resultMessage?: string;
  readonly occurredAt?: string;
  readonly durationMs?: number;
  readonly requestId?: string;
  readonly payload?: Record<string, unknown>;
}

export interface ActivityListFilter {
  readonly actorId?: string;
  readonly actorType?: ActivityActorType;
  readonly action?: string;
  readonly objectType?: string;
  readonly hallId?: string;
  readonly status?: ActivityStatus;
  readonly limit?: number;
}
