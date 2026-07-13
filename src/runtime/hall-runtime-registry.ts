import { EventEmitter } from "node:events";
import {
  createEmptyHallRuntimeSnapshot,
  type HallDeviceEvent,
  type HallRuntimeRecord,
  type HallRuntimeRegistration,
  type HallRuntimeSnapshot,
  type RuntimeSubscriptionFilter,
} from "./types";

export interface HallRuntimeRegistryEvents {
  snapshot: (record: HallRuntimeRecord) => void;
  event: (event: HallDeviceEvent) => void;
}

export class HallRuntimeRegistry extends EventEmitter {
  private readonly runtimes = new Map<string, HallRuntimeRecord>();
  private readonly events: HallDeviceEvent[] = [];

  upsertRuntime(registration: HallRuntimeRegistration): HallRuntimeRecord {
    const existing = this.runtimes.get(registration.hallId);
    const record: HallRuntimeRecord = existing
      ? {
        registration,
        snapshot: {
          ...existing.snapshot,
          hallId: registration.hallId,
          deviceId: registration.deviceId,
        },
      }
      : {
        registration,
        snapshot: createEmptyHallRuntimeSnapshot(registration.hallId, registration.deviceId),
      };

    this.runtimes.set(registration.hallId, record);
    return record;
  }

  getRuntime(hallId: string): HallRuntimeRecord | undefined {
    return this.runtimes.get(hallId);
  }

  getRuntimeOrThrow(hallId: string): HallRuntimeRecord {
    const record = this.runtimes.get(hallId);
    if (!record) {
      throw new Error(`Unknown hall runtime: ${hallId}`);
    }
    return record;
  }

  listRuntimes(): HallRuntimeRecord[] {
    return [...this.runtimes.values()];
  }

  removeRuntime(hallId: string): void {
    this.runtimes.delete(hallId);
  }

  replaceSnapshot(
    hallId: string,
    snapshot: HallRuntimeSnapshot,
    options: { emit?: boolean } = {},
  ): HallRuntimeRecord {
    const current = this.getRuntimeOrThrow(hallId);
    const next: HallRuntimeRecord = {
      ...current,
      snapshot,
    };
    this.runtimes.set(hallId, next);
    if (options.emit) {
      this.emit("snapshot", next);
    }
    return next;
  }

  updateSnapshot(
    hallId: string,
    updater: (current: HallRuntimeSnapshot) => HallRuntimeSnapshot,
  ): HallRuntimeRecord {
    const current = this.getRuntimeOrThrow(hallId);
    const next: HallRuntimeRecord = {
      ...current,
      snapshot: updater(current.snapshot),
    };
    this.runtimes.set(hallId, next);
    this.emit("snapshot", next);
    return next;
  }

  publishEvent(event: HallDeviceEvent): void {
    this.events.push(event);
    this.emit("event", event);
  }

  seedEvent(event: HallDeviceEvent): void {
    this.events.push(event);
  }

  listEvents(filter: RuntimeSubscriptionFilter = {}): HallDeviceEvent[] {
    return this.events.filter((event) => {
      if (filter.hallIds && !filter.hallIds.includes(event.hallId)) {
        return false;
      }
      if (filter.eventTypes && !filter.eventTypes.includes(event.type)) {
        return false;
      }
      return true;
    });
  }
}
