import type { GdcClient, GdcClientManager } from "../modules/gdc";
import type { HallRuntimeRegistry } from "./hall-runtime-registry";
import { HallRuntimeEventDetector } from "./hall-runtime-event-detector";
import type {
  HallIngestRuntimeItem,
  HallRuntimeRegistration,
  HallRuntimeSection,
  HallRuntimeSnapshot,
  RuntimeFreshness,
} from "./types";

export interface HallPollOptions {
  readonly sections?: readonly HallRuntimeSection[];
  readonly force?: boolean;
}

export class HallRuntimePoller {
  private static readonly FAST_RETRY_FAILURE_THRESHOLD = 6;
  private static readonly CONFIRMING_RETRY_MS = 5_000;
  private static readonly FAST_RETRY_MS = 10_000;
  private static readonly SLOW_RETRY_MS = 60_000;

  constructor(
    private readonly registry: HallRuntimeRegistry,
    private readonly clientManager: GdcClientManager,
    private readonly detector: HallRuntimeEventDetector = new HallRuntimeEventDetector(),
  ) {}

  async pollHall(hallId: string, options: HallPollOptions = {}): Promise<HallRuntimeSnapshot> {
    const runtime = this.registry.getRuntimeOrThrow(hallId);
    const previous = runtime.snapshot;
    const client = this.resolveClient(runtime.registration);
    const sections = new Set(options.sections ?? ["connectivity", "serverInfo", "automation", "playback", "ingest"]);
    const startedAt = Date.now();

    let snapshot = previous;

    try {
      if (sections.has("connectivity")) {
        const heartbeatAt = new Date().toISOString();
        await client.heartbeat();
        snapshot = {
          ...snapshot,
          updatedAt: new Date().toISOString(),
          connectivity: {
            ...this.createFreshness(startedAt, 10_000),
            state: "online",
            probePhase: "idle",
            consecutiveFailures: 0,
            lastHeartbeatAt: heartbeatAt,
            lastFailureAt: undefined,
            nextProbeAt: undefined,
            lastStateChangedAt:
              snapshot.connectivity.state === "online"
                ? snapshot.connectivity.lastStateChangedAt
                : heartbeatAt,
          },
        };
      }
    } catch (error) {
      const failedAt = new Date().toISOString();
      const nextConnectivity = this.createFailedConnectivitySnapshot(snapshot, startedAt, failedAt, error);
      snapshot = {
        ...this.applyDisconnectedSnapshot(snapshot, startedAt, error),
        updatedAt: new Date().toISOString(),
        connectivity: nextConnectivity,
      };
      this.registry.replaceSnapshot(hallId, snapshot, { emit: true });
      this.publishDetectedEvents(runtime.registration, previous, snapshot);
      throw error;
    }

    if (sections.has("serverInfo")) {
      snapshot = await this.refreshSectionSnapshot(snapshot, "serverInfo", async () => {
        const [info, ipList, storageInfo, projectorStatus] = await Promise.all([
          client.getServerInfo(),
          client.getServerIpList(),
          client.getStorageInfo(),
          client.getProjectorStatus().catch(() => undefined),
        ]);
        return {
          info,
          ipList,
          storageInfo,
          projectorStatus,
        };
      });
    }

    if (sections.has("automation")) {
      snapshot = await this.refreshSectionSnapshot(snapshot, "automation", async () => ({
        labels: await client.getAutomationLabels(),
      }));
    }

    if (sections.has("playback")) {
      snapshot = await this.refreshSectionSnapshot(snapshot, "playback", async () => ({
        status: await client.getPlaybackStatus(),
      }));
    }

    if (sections.has("ingest")) {
      snapshot = await this.refreshSectionSnapshot(snapshot, "ingest", async () => {
        const ingestList = await client.getIngestList();
        const activeIngests = await Promise.all(
          ingestList.map(async (item): Promise<HallIngestRuntimeItem> => ({
            ...this.createFreshness(Date.now(), 5_000),
            ingestUuid: item.ingestUuid,
            status: await client.getIngestStatus(item.ingestUuid),
          })),
        );

        return {
          activeIngests,
        };
      });
    }

    this.registry.replaceSnapshot(hallId, snapshot, { emit: true });
    this.publishDetectedEvents(runtime.registration, previous, snapshot);
    return snapshot;
  }

  async pollAll(options: HallPollOptions = {}): Promise<HallRuntimeSnapshot[]> {
    const results = await Promise.allSettled(
      this.registry.listRuntimes().map((runtime) => this.pollHall(runtime.registration.hallId, options)),
    );

    return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }

  private async refreshSectionSnapshot<K extends Exclude<HallRuntimeSection, "connectivity">>(
    snapshot: HallRuntimeSnapshot,
    section: K,
    loader: () => Promise<HallRuntimeSnapshot[K] extends RuntimeFreshness ? Partial<HallRuntimeSnapshot[K]> : never>,
  ): Promise<HallRuntimeSnapshot> {
    const startedAt = Date.now();

    try {
      const partial = await loader();
      return {
        ...snapshot,
        updatedAt: new Date().toISOString(),
        [section]: {
          ...snapshot[section],
          ...partial,
          ...this.createFreshness(startedAt, isStaticSection(section) ? 30 * 60_000 : 5_000),
        },
      } as HallRuntimeSnapshot;
    } catch (error) {
      if (this.isConnectivityFailure(error)) {
        const failedAt = new Date().toISOString();
        return {
          ...this.applyDisconnectedSnapshot(snapshot, startedAt, error),
          updatedAt: new Date().toISOString(),
          connectivity: this.createFailedConnectivitySnapshot(snapshot, startedAt, failedAt, error),
        };
      }

      return {
        ...snapshot,
        updatedAt: new Date().toISOString(),
        [section]: {
          ...snapshot[section],
          ...this.createFreshness(startedAt, isStaticSection(section) ? 30 * 60_000 : 5_000, error),
        },
      } as HallRuntimeSnapshot;
    }
  }

  private isConnectivityFailure(error: unknown): boolean {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
    if (code === "GDC_TIMEOUT" || code === "GDC_CONNECTION_ERROR") {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error || "");
    return /(?:timed out|connection (?:closed|timed out)|ECONN|ETIMEDOUT|Socket unavailable)/i.test(message);
  }

  private publishDetectedEvents(
    registration: HallRuntimeRegistration,
    previous: HallRuntimeSnapshot,
    current: HallRuntimeSnapshot,
  ): void {
    const events = this.detector.detect(registration, previous, current);
    for (const event of events) {
      this.registry.publishEvent(event);
    }
  }

  private resolveClient(registration: HallRuntimeRegistration): GdcClient {
    return this.clientManager.upsertClient({
      deviceId: registration.deviceId,
      auditoriumId: registration.auditoriumId,
      host: registration.host,
      port: registration.port,
    });
  }

  private createFreshness(startedAtMs: number, ttlMs: number, error?: unknown): RuntimeFreshness {
    const collectedAt = new Date().toISOString();
    return {
      collectedAt,
      staleAt: new Date(startedAtMs + ttlMs).toISOString(),
      sourceLatencyMs: Date.now() - startedAtMs,
      isStale: false,
      error: error instanceof Error ? error.message : error ? String(error) : undefined,
    };
  }

  private applyDisconnectedSnapshot(
    snapshot: HallRuntimeSnapshot,
    startedAtMs: number,
    error: unknown,
  ): HallRuntimeSnapshot {
    const staleFreshness = this.createFreshness(startedAtMs, 5_000, error);
    return {
      ...snapshot,
      serverInfo: {
        ...snapshot.serverInfo,
        ...staleFreshness,
        projectorStatus: {
          connectionState: "Unknown",
          rawConnectionState: "Unknown",
          entries: [],
        },
      },
      automation: {
        ...snapshot.automation,
        ...staleFreshness,
        labels: [],
      },
      playback: {
        ...snapshot.playback,
        ...staleFreshness,
        status: undefined,
      },
      ingest: {
        ...snapshot.ingest,
        ...staleFreshness,
        activeIngests: [],
      },
    };
  }

  private createFailedConnectivitySnapshot(
    current: HallRuntimeSnapshot,
    startedAtMs: number,
    failedAt: string,
    error: unknown,
  ) {
    const consecutiveFailures = current.connectivity.consecutiveFailures + 1;
    const probePhase = this.resolveFailureProbePhase(consecutiveFailures);
    const nextProbeAt = new Date(
      Date.parse(failedAt) + this.getRetryDelayMs(probePhase),
    ).toISOString();

    return {
      ...this.createFreshness(startedAtMs, 10_000, error),
      state: "offline" as const,
      probePhase,
      consecutiveFailures,
      lastHeartbeatAt: current.connectivity.lastHeartbeatAt,
      lastFailureAt: failedAt,
      nextProbeAt,
      lastStateChangedAt:
        current.connectivity.state === "offline"
          ? current.connectivity.lastStateChangedAt
          : failedAt,
    };
  }

  private resolveFailureProbePhase(consecutiveFailures: number) {
    if (consecutiveFailures <= 1) {
      return "confirming" as const;
    }

    if (consecutiveFailures <= HallRuntimePoller.FAST_RETRY_FAILURE_THRESHOLD) {
      return "fastRetry" as const;
    }

    return "slowRetry" as const;
  }

  private getRetryDelayMs(
    probePhase: "confirming" | "fastRetry" | "slowRetry",
  ): number {
    if (probePhase === "confirming") {
      return HallRuntimePoller.CONFIRMING_RETRY_MS;
    }

    if (probePhase === "fastRetry") {
      return HallRuntimePoller.FAST_RETRY_MS;
    }

    return HallRuntimePoller.SLOW_RETRY_MS;
  }
}

function isStaticSection(section: Exclude<HallRuntimeSection, "connectivity">): boolean {
  return section === "serverInfo" || section === "automation";
}
