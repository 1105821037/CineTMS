# TMS Job / Runtime Architecture Draft

## Goals

- Decouple device polling from user traffic.
- Give future job execution a stable command/state/event foundation.
- Support high-frequency playback and ingest state updates without multiplying GDC calls under concurrent users.

## Runtime Model

Each hall should have a single runtime owner in process:

- `HallRuntimeRegistry`
  - hall registration
  - latest runtime snapshot
  - recent device events
- `HallCommandService`
  - single command entry for ingest / schedule / playback control
  - emits command accepted/rejected events

Runtime data is split into layers:

1. Static layer
   - server info
   - serial / model / version
   - low-frequency refresh

2. Warm layer
   - scheduler status
   - current / next schedule

3. Hot layer
   - playback status
   - active ingest status
   - heartbeat / connectivity

## Job Model

Jobs should be built around:

- `JobDefinition`
- `JobRun`
- `JobStepDefinition`
- `JobRunStep`
- `JobTriggerDefinition`

Suggested flow:

1. A trigger creates a `JobRun`.
2. The runner executes command steps through `HallCommandService`.
3. The runner waits on runtime events or state transitions.
4. State transitions produce `HallDeviceEvent` records.
5. The run is advanced or failed based on those events.

## Recommended Tables

1. `hall_runtime_snapshot`
   - hall_id
   - snapshot_json
   - updated_at

2. `hall_runtime_event`
   - event_id
   - hall_id
   - device_id
   - event_type
   - payload_json
   - occurred_at

3. `job_definition`
   - job_id
   - hall_id
   - job_kind
   - name
   - trigger_json
   - payload_json
   - dedupe_key
   - created_by
   - created_at

4. `job_run`
   - run_id
   - job_id
   - hall_id
   - status
   - current_step_id
   - trigger_reason
   - error
   - started_at
   - finished_at

5. `job_run_step`
   - run_id
   - step_id
   - status
   - output_json
   - error
   - started_at
   - finished_at

## Near-Term Build Order

1. Runtime registry and snapshot model
2. Command service boundary
3. Pollers for playback / ingest / connectivity
4. Event detector
5. SSE push from runtime snapshot/event stream
6. Job runner on top of command + event foundation
