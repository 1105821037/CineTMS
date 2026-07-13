import type {
  GdcIngestStatus,
  GdcProjectorStatus,
  GdcPlaybackStatus,
  GdcScheduleSummary,
  GdcSchedulerStatus,
  GdcServerIpList,
  GdcServerInfo,
  GdcStorageInfo,
} from "../modules/gdc";

export type HallRuntimeSection =
  | "connectivity"
  | "serverInfo"
  | "automation"
  | "scheduler"
  | "playback"
  | "ingest";

export type HallConnectivityState =
  | "unknown"
  | "online"
  | "offline";

export type HallConnectivityProbePhase =
  | "idle"
  | "confirming"
  | "fastRetry"
  | "slowRetry";

export interface RuntimeFreshness {
  readonly collectedAt?: string;
  readonly staleAt?: string;
  readonly sourceLatencyMs?: number;
  readonly isStale?: boolean;
  readonly error?: string;
}

export interface HallConnectivitySnapshot extends RuntimeFreshness {
  readonly state: HallConnectivityState;
  readonly probePhase?: HallConnectivityProbePhase;
  readonly consecutiveFailures: number;
  readonly lastHeartbeatAt?: string;
  readonly lastFailureAt?: string;
  readonly nextProbeAt?: string;
  readonly lastStateChangedAt?: string;
}

export interface HallServerInfoSnapshot extends RuntimeFreshness {
  readonly info?: GdcServerInfo;
  readonly ipList?: GdcServerIpList;
  readonly storageInfo?: GdcStorageInfo;
  readonly projectorStatus?: GdcProjectorStatus;
}

export interface HallSchedulerSnapshot extends RuntimeFreshness {
  readonly status?: GdcSchedulerStatus;
  readonly currentSchedule?: GdcScheduleSummary;
  readonly nextSchedule?: GdcScheduleSummary;
}

export interface HallAutomationSnapshot extends RuntimeFreshness {
  readonly labels: readonly string[];
}

export interface HallPlaybackSnapshot extends RuntimeFreshness {
  readonly status?: GdcPlaybackStatus;
}

export interface HallIngestRuntimeItem extends RuntimeFreshness {
  readonly ingestUuid: string;
  readonly status?: GdcIngestStatus;
}

export interface HallIngestSnapshot extends RuntimeFreshness {
  readonly activeIngests: readonly HallIngestRuntimeItem[];
}

export interface HallRuntimeSnapshot {
  readonly hallId: string;
  readonly deviceId?: string;
  readonly updatedAt: string;
  readonly connectivity: HallConnectivitySnapshot;
  readonly serverInfo: HallServerInfoSnapshot;
  readonly automation: HallAutomationSnapshot;
  readonly scheduler: HallSchedulerSnapshot;
  readonly playback: HallPlaybackSnapshot;
  readonly ingest: HallIngestSnapshot;
}

export interface HallRuntimeRegistration {
  readonly hallId: string;
  readonly hallName?: string;
  readonly deviceId: string;
  readonly auditoriumId?: string;
  readonly host: string;
  readonly port: number;
  readonly profile?: "gdc";
}

export type HallDeviceEventType =
  | "DEVICE_ONLINE"
  | "DEVICE_OFFLINE"
  | "SERVER_INFO_REFRESHED"
  | "SCHEDULER_STATE_CHANGED"
  | "PLAYBACK_STARTED"
  | "PLAYBACK_STOPPED"
  | "PLAYBACK_FINISHED"
  | "PLAYBACK_FAILED"
  | "INGEST_STARTED"
  | "INGEST_PROGRESS"
  | "INGEST_COMPLETED"
  | "INGEST_FAILED"
  | "COMMAND_ACCEPTED"
  | "COMMAND_REJECTED";

export interface HallDeviceEvent<TPayload = Record<string, unknown>> {
  readonly eventId: string;
  readonly hallId: string;
  readonly hallName?: string;
  readonly deviceId?: string;
  readonly type: HallDeviceEventType;
  readonly occurredAt: string;
  readonly payload: TPayload;
  readonly source: "poller" | "command" | "system";
}

export interface RuntimeSubscriptionFilter {
  readonly hallIds?: readonly string[];
  readonly eventTypes?: readonly HallDeviceEventType[];
}

export interface HallRuntimeRecord {
  readonly registration: HallRuntimeRegistration;
  readonly snapshot: HallRuntimeSnapshot;
}

export function createEmptyHallRuntimeSnapshot(
  hallId: string,
  deviceId?: string,
): HallRuntimeSnapshot {
  const now = new Date().toISOString();
  return {
    hallId,
    deviceId,
    updatedAt: now,
    connectivity: {
      state: "unknown",
      probePhase: "idle",
      consecutiveFailures: 0,
    },
    serverInfo: {},
    automation: {
      labels: [],
    },
    scheduler: {},
    playback: {},
    ingest: {
      activeIngests: [],
    },
  };
}
