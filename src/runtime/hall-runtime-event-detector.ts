import type {
  HallDeviceEvent,
  HallIngestRuntimeItem,
  HallRuntimeRegistration,
  HallRuntimeSnapshot,
} from "./types";

export class HallRuntimeEventDetector {
  detect(
    registration: HallRuntimeRegistration,
    previous: HallRuntimeSnapshot,
    current: HallRuntimeSnapshot,
  ): HallDeviceEvent[] {
    const events: HallDeviceEvent[] = [];

    this.pushConnectivityEvents(events, registration, previous, current);
    this.pushServerInfoEvents(events, registration, previous, current);
    this.pushPlaybackEvents(events, registration, previous, current);
    this.pushIngestEvents(events, registration, previous, current);

    return events;
  }

  private pushConnectivityEvents(
    events: HallDeviceEvent[],
    registration: HallRuntimeRegistration,
    previous: HallRuntimeSnapshot,
    current: HallRuntimeSnapshot,
  ): void {
    if (previous.connectivity.state === current.connectivity.state) {
      return;
    }

    const eventType =
      current.connectivity.state === "online"
        ? "DEVICE_ONLINE"
        : "DEVICE_OFFLINE";

    events.push(this.createEvent(registration, eventType, {
      previousState: previous.connectivity.state,
      currentState: current.connectivity.state,
      probePhase: current.connectivity.probePhase,
      consecutiveFailures: current.connectivity.consecutiveFailures,
    }));
  }

  private pushServerInfoEvents(
    events: HallDeviceEvent[],
    registration: HallRuntimeRegistration,
    previous: HallRuntimeSnapshot,
    current: HallRuntimeSnapshot,
  ): void {
    const previousInfo = previous.serverInfo.info;
    const currentInfo = current.serverInfo.info;

    if (!currentInfo) {
      return;
    }

    const changed =
      !previousInfo
      || previousInfo.serial !== currentInfo.serial
      || previousInfo.model !== currentInfo.model
      || previousInfo.version?.software !== currentInfo.version?.software
      || previousInfo.version?.firmware !== currentInfo.version?.firmware;

    if (changed) {
      events.push(this.createEvent(registration, "SERVER_INFO_REFRESHED", {
        model: currentInfo.model,
        serial: currentInfo.serial,
        previousSerial: previousInfo?.serial,
      }));
    }
  }

  private pushPlaybackEvents(
    events: HallDeviceEvent[],
    registration: HallRuntimeRegistration,
    previous: HallRuntimeSnapshot,
    current: HallRuntimeSnapshot,
  ): void {
    const previousState = (previous.playback.status?.state || "").toUpperCase();
    const currentState = (current.playback.status?.state || "").toUpperCase();

    if (previousState === currentState) {
      return;
    }

    if (currentState === "PLAYING") {
      events.push(this.createEvent(registration, "PLAYBACK_STARTED", {
        previousState,
        currentState,
        showUuid: current.playback.status?.showUuid,
        showName: current.playback.status?.showName,
      }));
      return;
    }

    if (previousState === "PLAYING" && (currentState === "STOPPED" || currentState === "IDLE")) {
      events.push(this.createEvent(registration, "PLAYBACK_FINISHED", {
        previousState,
        currentState,
        showUuid: previous.playback.status?.showUuid,
        showName: previous.playback.status?.showName,
      }));
      return;
    }

    if (previousState && previousState !== currentState) {
      events.push(this.createEvent(registration, "PLAYBACK_STOPPED", {
        previousState,
        currentState,
        showUuid: current.playback.status?.showUuid ?? previous.playback.status?.showUuid,
      }));
    }
  }

  private pushIngestEvents(
    events: HallDeviceEvent[],
    registration: HallRuntimeRegistration,
    previous: HallRuntimeSnapshot,
    current: HallRuntimeSnapshot,
  ): void {
    const previousMap = new Map(previous.ingest.activeIngests.map((item) => [item.ingestUuid, item]));

    for (const item of current.ingest.activeIngests) {
      const previousItem = previousMap.get(item.ingestUuid);
      if (!previousItem) {
        events.push(this.createIngestEvent(registration, "INGEST_STARTED", item, undefined));
        continue;
      }

      const previousStatus = (previousItem.status?.status || "").toUpperCase();
      const currentStatus = (item.status?.status || "").toUpperCase();

      if (previousStatus !== currentStatus) {
        if (currentStatus === "COMPLETED" || currentStatus === "DONE") {
          events.push(this.createIngestEvent(registration, "INGEST_COMPLETED", item, previousItem));
        } else if (currentStatus === "ERROR" || currentStatus === "FAILED") {
          events.push(this.createIngestEvent(registration, "INGEST_FAILED", item, previousItem));
        } else {
          events.push(this.createIngestEvent(registration, "INGEST_PROGRESS", item, previousItem));
        }
      }
    }

  }

  private createIngestEvent(
    registration: HallRuntimeRegistration,
    type: Extract<HallDeviceEvent["type"], "INGEST_STARTED" | "INGEST_PROGRESS" | "INGEST_COMPLETED" | "INGEST_FAILED">,
    current: HallIngestRuntimeItem,
    previous: HallIngestRuntimeItem | undefined,
  ): HallDeviceEvent {
    return this.createEvent(registration, type, {
      ingestUuid: current.ingestUuid,
      previousStatus: previous?.status?.status,
      currentStatus: current.status?.status,
      assetUri: current.status?.assetUri,
      transferredSize: current.status?.transferredSize,
      totalSize: current.status?.totalSize,
      description: current.status?.description,
    });
  }

  private createEvent(
    registration: HallRuntimeRegistration,
    type: HallDeviceEvent["type"],
    payload: Record<string, unknown>,
  ): HallDeviceEvent {
    return {
      eventId: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      hallId: registration.hallId,
      hallName: registration.hallName,
      deviceId: registration.deviceId,
      type,
      occurredAt: new Date().toISOString(),
      payload: {
        hallName: registration.hallName,
        ...payload,
      },
      source: "poller",
    };
  }
}
