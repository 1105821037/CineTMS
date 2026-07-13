import { randomUUID } from "node:crypto";
import {
  createActivity,
  listActivities,
  readActivityById,
} from "./activity-store";
import type {
  ActivityListFilter,
  ActivityRecord,
  CreateActivityInput,
} from "./notification-types";
import { getRealtimeHub } from "./realtime-hub";

export class ActivityService {
  async create(input: CreateActivityInput): Promise<ActivityRecord | null> {
    const activity = await createActivity({
      ...input,
      id: input.id ?? `activity-${randomUUID()}`,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      payload: input.payload ?? {},
    });
    if (activity) {
      getRealtimeHub().broadcast("activity", activity);
    }
    return activity;
  }

  read(id: string): Promise<ActivityRecord | null> {
    return readActivityById(id);
  }

  list(filter: ActivityListFilter = {}): Promise<ActivityRecord[]> {
    return listActivities(filter);
  }

  async capture<T>(
    input: Omit<CreateActivityInput, "status" | "resultMessage" | "durationMs" | "occurredAt">,
    action: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await action();
      await this.create({
        ...input,
        status: "success",
        occurredAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
      }).catch(() => undefined);
      return result;
    } catch (error) {
      await this.create({
        ...input,
        status: "error",
        resultMessage: error instanceof Error ? error.message : "操作失败。",
        occurredAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
      }).catch(() => undefined);
      throw error;
    }
  }
}

let activityServiceSingleton: ActivityService | null = null;

export function getActivityService(): ActivityService {
  activityServiceSingleton ??= new ActivityService();
  return activityServiceSingleton;
}
