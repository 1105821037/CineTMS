export type JobKind =
  | "ingest"
  | "schedule-playback"
  | "playback-control"
  | "automation"
  | "recovery";

export type JobStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type JobStepStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type JobTriggerType = "manual" | "schedule" | "event";

export interface JobTriggerDefinition {
  readonly type: JobTriggerType;
  readonly scheduleAt?: string;
  readonly eventType?: string;
  readonly hallId?: string;
  readonly matchers?: Readonly<Record<string, string>>;
}

export interface JobDefinition<TPayload = Record<string, unknown>> {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly hallId: string;
  readonly name: string;
  readonly dedupeKey?: string;
  readonly payload: TPayload;
  readonly trigger: JobTriggerDefinition;
  readonly createdAt: string;
  readonly createdBy?: string;
}

export interface JobExecutionContext {
  readonly jobId: string;
  readonly runId: string;
  readonly hallId: string;
  readonly startedAt: string;
  readonly correlationId: string;
}

export interface JobStepDefinition<TPayload = Record<string, unknown>> {
  readonly stepId: string;
  readonly title: string;
  readonly action:
    | "command.ingest"
    | "command.schedule"
    | "command.play"
    | "command.stop"
    | "wait.event"
    | "wait.state"
    | "emit.event";
  readonly payload?: TPayload;
  readonly timeoutMs?: number;
  readonly retryLimit?: number;
}

export interface JobRunStep {
  readonly stepId: string;
  readonly status: JobStepStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly output?: Record<string, unknown>;
}

export interface JobRun {
  readonly runId: string;
  readonly jobId: string;
  readonly hallId: string;
  readonly status: JobStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly triggerReason?: string;
  readonly currentStepId?: string;
  readonly steps: readonly JobRunStep[];
  readonly error?: string;
}
