import type { IncomingMessage, ServerResponse } from "node:http";
import type { HallDeviceEvent, HallRuntimeRecord } from "../runtime";
import { readJsonBody, sendJson } from "./http";
import { getActivityService } from "./activity-service";
import { getRuntimeService } from "./runtime-service";
import { readAutomationDangerousCommandFilterEnabled } from "./setup-store";
import { requireSession } from "./session";

let dangerousAutomationFilterCache:
  | { value: boolean; expiresAt: number }
  | null = null;

export async function handleRuntimeApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/runtime")) {
    return false;
  }

  const session = await requireSession(request);
  const runtimeService = getRuntimeService();
  const activityService = getActivityService();
  const hideDangerousAutomationCommands = await getDangerousAutomationFilterEnabled();

  if (request.method === "POST") {
    const automationListMatch = /^\/api\/runtime\/halls\/([^/]+)\/automations$/.exec(pathname);
    if (automationListMatch) {
      const hallId = decodeURIComponent(automationListMatch[1]);
      const runtime = runtimeService.getRuntimeRecord(hallId);
      if (!runtime) {
        sendJson(response, 404, { ok: false, error: "Runtime hall not found" });
        return true;
      }

      const body = await readJsonBody(request);
      const force = body.force === true;
      if (force) {
        const automationUnavailableReason = getHallAutomationUnavailableReason(runtime);
        if (automationUnavailableReason) {
          sendJson(response, 409, { ok: false, error: automationUnavailableReason });
          return true;
        }
      }

      const automationLabels = await runtimeService.listAutomationLabels(hallId, { force });
      sendJson(response, 200, {
        ok: true,
        automationLabels: filterAutomationLabels(automationLabels, hideDangerousAutomationCommands),
        automation: sanitizeRuntimeRecord(
          runtimeService.getRuntimeRecord(hallId),
          hideDangerousAutomationCommands,
        )?.snapshot.automation,
      });
      return true;
    }

    const showListMatch = /^\/api\/runtime\/halls\/([^/]+)\/shows$/.exec(pathname);
    if (showListMatch) {
      const hallId = decodeURIComponent(showListMatch[1]);
      const shows = await runtimeService.listShows(hallId);
      sendJson(response, 200, { ok: true, shows });
      return true;
    }

    const cplListMatch = /^\/api\/runtime\/halls\/([^/]+)\/cpls$/.exec(pathname);
    if (cplListMatch) {
      const hallId = decodeURIComponent(cplListMatch[1]);
      const cpls = await runtimeService.listCpls(hallId);
      sendJson(response, 200, { ok: true, cpls });
      return true;
    }

    const cplDeleteMatch = /^\/api\/runtime\/halls\/([^/]+)\/cpls\/([^/]+)\/delete$/.exec(pathname);
    if (cplDeleteMatch) {
      const hallId = decodeURIComponent(cplDeleteMatch[1]);
      const cplUuid = decodeURIComponent(cplDeleteMatch[2]);
      const body = await readJsonBody(request);
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : cplUuid;

      await activityService.capture({
        actorType: "user",
        actorId: String(session.userId),
        actorName: session.username,
        action: "runtime.cpl.delete-content",
        objectType: "cpl",
        objectId: cplUuid,
        objectName: title,
        hallId,
        payload: sanitizeActivityPayload({ hallId, cplUuid, title }),
      }, async () => runtimeService.deleteCplContentFromDevice(hallId, cplUuid));

      sendJson(response, 200, { ok: true, hallId, cplUuid });
      return true;
    }

    const showCopyCheckMatch = /^\/api\/runtime\/halls\/([^/]+)\/shows\/([^/]+)\/copy\/check$/.exec(pathname);
    if (showCopyCheckMatch) {
      const sourceHallId = decodeURIComponent(showCopyCheckMatch[1]);
      const showUuid = decodeURIComponent(showCopyCheckMatch[2]);
      const body = await readJsonBody(request);
      const targetHallId = readRequiredString(body.targetHallId, "目标影厅");
      const check = await runtimeService.checkShowCopy(sourceHallId, showUuid, targetHallId);
      sendJson(response, 200, { ok: true, check });
      return true;
    }

    const showCopyImportMatch = /^\/api\/runtime\/halls\/([^/]+)\/shows\/([^/]+)\/copy\/import$/.exec(pathname);
    if (showCopyImportMatch) {
      const sourceHallId = decodeURIComponent(showCopyImportMatch[1]);
      const showUuid = decodeURIComponent(showCopyImportMatch[2]);
      const body = await readJsonBody(request);
      const targetHallId = readRequiredString(body.targetHallId, "目标影厅");
      const result = await activityService.capture({
        actorType: "user",
        actorId: String(session.userId),
        actorName: session.username,
        action: "runtime.show.copy-to-hall",
        objectType: "show",
        objectId: showUuid,
        hallId: sourceHallId,
        payload: sanitizeActivityPayload({ sourceHallId, targetHallId, showUuid }),
      }, async () => runtimeService.copyShowToHall(sourceHallId, showUuid, targetHallId));
      sendJson(response, 200, { ok: true, result });
      return true;
    }

    const showEditorMatch = /^\/api\/runtime\/halls\/([^/]+)\/shows\/(?!save$)([^/]+)$/.exec(pathname);
    if (showEditorMatch) {
      const hallId = decodeURIComponent(showEditorMatch[1]);
      const showUuid = decodeURIComponent(showEditorMatch[2]);
      const show = await runtimeService.getShowForEditor(hallId, showUuid);
      sendJson(response, 200, { ok: true, show });
      return true;
    }

    const showSaveMatch = /^\/api\/runtime\/halls\/([^/]+)\/shows\/save$/.exec(pathname);
    if (showSaveMatch) {
      const hallId = decodeURIComponent(showSaveMatch[1]);
      const body = await readJsonBody(request);
      const runtime = runtimeService.getRuntimeRecord(hallId);
      const result = await activityService.capture({
        actorType: "user",
        actorId: String(session.userId),
        actorName: session.username,
        action: body.showUuid ? "runtime.show.update" : "runtime.show.create",
        objectType: "show",
        objectId: typeof body.showUuid === "string" ? body.showUuid : undefined,
        objectName: typeof body.title === "string" ? body.title : undefined,
        hallId,
        payload: sanitizeActivityPayload(body),
      }, async () => runtimeService.saveShow(hallId, normalizeShowSavePayload(body)));

      sendJson(response, 200, {
        ok: true,
        result,
        hall: sanitizeRuntimeRecord(runtime, hideDangerousAutomationCommands),
      });
      return true;
    }

    const showDeleteMatch = /^\/api\/runtime\/halls\/([^/]+)\/shows\/([^/]+)\/delete$/.exec(pathname);
    if (showDeleteMatch) {
      const hallId = decodeURIComponent(showDeleteMatch[1]);
      const showUuid = decodeURIComponent(showDeleteMatch[2]);
      const runtime = runtimeService.getRuntimeRecord(hallId);

      await activityService.capture({
        actorType: "user",
        actorId: String(session.userId),
        actorName: session.username,
        action: "runtime.show.delete",
        objectType: "show",
        objectId: showUuid,
        hallId,
      }, async () => runtimeService.deleteShow(hallId, showUuid));

      sendJson(response, 200, {
        ok: true,
        hall: sanitizeRuntimeRecord(runtime, hideDangerousAutomationCommands),
      });
      return true;
    }

    const showValidateMatch = /^\/api\/runtime\/halls\/([^/]+)\/shows\/([^/]+)\/validate$/.exec(pathname);
    if (showValidateMatch) {
      const hallId = decodeURIComponent(showValidateMatch[1]);
      const showUuid = decodeURIComponent(showValidateMatch[2]);
      const validation = await runtimeService.validateShow(hallId, showUuid);
      sendJson(response, 200, { ok: true, validation });
      return true;
    }

    const showInspectionMatch = /^\/api\/runtime\/halls\/([^/]+)\/shows\/([^/]+)\/cpls$/.exec(pathname);
    if (showInspectionMatch) {
      const hallId = decodeURIComponent(showInspectionMatch[1]);
      const showUuid = decodeURIComponent(showInspectionMatch[2]);
      const inspection = await runtimeService.inspectShow(hallId, showUuid);
      sendJson(response, 200, { ok: true, inspection });
      return true;
    }

    const eventLogsMatch = /^\/api\/runtime\/halls\/([^/]+)\/logs$/.exec(pathname);
    if (eventLogsMatch) {
      const hallId = decodeURIComponent(eventLogsMatch[1]);
      const runtime = runtimeService.getRuntimeRecord(hallId);
      if (!runtime) {
        sendJson(response, 404, { ok: false, error: "Runtime hall not found" });
        return true;
      }

      const body = await readJsonBody(request);
      const date = readLogDate(body.date);
      const logs = await runtimeService.getEventLogs(hallId, date);
      sendJson(response, 200, { ok: true, logs });
      return true;
    }

    const controlMatch = /^\/api\/runtime\/halls\/([^/]+)\/control\/([^/]+)$/.exec(pathname);
    if (controlMatch) {
      const hallId = decodeURIComponent(controlMatch[1]);
      const action = decodeURIComponent(controlMatch[2]);
      const runtime = runtimeService.getRuntimeRecord(hallId);
      if (!runtime) {
        sendJson(response, 404, { ok: false, error: "Runtime hall not found" });
        return true;
      }

      const unavailableReason =
        action === "trigger-automation"
          ? getHallAutomationUnavailableReason(runtime)
          : getHallControlUnavailableReason(runtime);
      if (unavailableReason) {
        await activityService.create({
          actorType: "user",
          actorId: String(session.userId),
          actorName: session.username,
          action: `runtime.control.${action}`,
          objectType: "hall",
          objectId: hallId,
          objectName: runtime.registration.hallName,
          hallId,
          status: "error",
          resultMessage: unavailableReason,
        }).catch(() => undefined);
        sendJson(response, 409, { ok: false, error: unavailableReason });
        return true;
      }

      const body = await readJsonBody(request);

      await activityService.capture({
        actorType: "user",
        actorId: String(session.userId),
        actorName: session.username,
        action: `runtime.control.${action}`,
        objectType: "hall",
        objectId: hallId,
        objectName: runtime.registration.hallName,
        hallId,
        payload: sanitizeActivityPayload(body),
      }, async () => {
        if (action === "load-show") {
          const showUuid = typeof body.showUuid === "string" ? body.showUuid.trim() : "";
          if (!showUuid) {
            throw new Error("Missing showUuid");
          }
          await runtimeService.loadShow(hallId, showUuid);
        } else if (action === "play") {
          await runtimeService.play(hallId);
        } else if (action === "pause") {
          await runtimeService.pause(hallId);
        } else if (action === "resume") {
          await runtimeService.resume(hallId);
        } else if (action === "stop") {
          await runtimeService.stopPlayback(hallId);
        } else if (action === "next-cpl") {
          await runtimeService.switchCpl(hallId, "next");
        } else if (action === "previous-cpl") {
          await runtimeService.switchCpl(hallId, "previous");
        } else if (action === "move-playback") {
          const absolute = typeof body.absolute === "string" ? body.absolute.trim() : "";
          const offset = typeof body.offset === "number" ? body.offset : Number(body.offset);
          if (!absolute && !Number.isFinite(offset)) {
            throw new Error("Missing absolute or offset");
          }
          await runtimeService.movePlayback(
            hallId,
            absolute ? { absolute } : { offset },
          );
        } else if (action === "trigger-automation") {
          const eventLabel = typeof body.eventLabel === "string" ? body.eventLabel.trim() : "";
          if (!eventLabel) {
            throw new Error("Missing eventLabel");
          }
          await runtimeService.triggerAutomation(hallId, eventLabel);
        } else {
          throw new Error("Unknown control action");
        }
      });

      sendJson(response, 200, {
        ok: true,
        hall: sanitizeRuntimeRecord(
          runtimeService.getRuntimeRecord(hallId),
          hideDangerousAutomationCommands,
        ),
      });
      return true;
    }

    const refreshMatch = /^\/api\/runtime\/halls\/([^/]+)\/refresh$/.exec(pathname);
    if (refreshMatch) {
      const hallId = decodeURIComponent(refreshMatch[1]);
      const hall = await runtimeService.refreshHall(hallId);
      sendJson(response, 200, {
        ok: true,
        hall: sanitizeRuntimeRecord(hall, hideDangerousAutomationCommands),
      });
      return true;
    }

    return false;
  }

  if (request.method !== "GET") {
    return false;
  }

  if (pathname === "/api/runtime/stream") {
    streamRuntime(
      response,
      sanitizeRuntimeRecords(runtimeService.listRuntimeRecords(), hideDangerousAutomationCommands),
      runtimeService.listEvents(),
      undefined,
      undefined,
      hideDangerousAutomationCommands,
    );
    return true;
  }

  const hallStreamMatch = /^\/api\/runtime\/halls\/([^/]+)\/stream$/.exec(pathname);
  if (hallStreamMatch) {
    const hallId = decodeURIComponent(hallStreamMatch[1]);
    const hall = runtimeService.getRuntimeRecord(hallId);
    if (!hall) {
      sendJson(response, 404, { ok: false, error: "Runtime hall not found" });
      return true;
    }

    streamRuntime(
      response,
      sanitizeRuntimeRecords([hall], hideDangerousAutomationCommands),
      runtimeService.listEvents(hallId),
      (event) => event.hallId === hallId,
      (record) => record.registration.hallId === hallId,
      hideDangerousAutomationCommands,
    );
    return true;
  }

  if (pathname === "/api/runtime/halls") {
    sendJson(response, 200, {
      ok: true,
      halls: sanitizeRuntimeRecords(runtimeService.listRuntimeRecords(), hideDangerousAutomationCommands),
    });
    return true;
  }

  if (pathname === "/api/runtime/events") {
    sendJson(response, 200, {
      ok: true,
      events: runtimeService.listEvents(),
    });
    return true;
  }

  const hallMatch = /^\/api\/runtime\/halls\/([^/]+)$/.exec(pathname);
  if (hallMatch) {
    const hallId = decodeURIComponent(hallMatch[1]);
    const runtime = runtimeService.getRuntimeRecord(hallId);
    sendJson(
      response,
      runtime ? 200 : 404,
      runtime
        ? { ok: true, hall: sanitizeRuntimeRecord(runtime, hideDangerousAutomationCommands) }
        : { ok: false, error: "Runtime hall not found" },
    );
    return true;
  }

  const eventMatch = /^\/api\/runtime\/halls\/([^/]+)\/events$/.exec(pathname);
  if (eventMatch) {
    const hallId = decodeURIComponent(eventMatch[1]);
    sendJson(response, 200, {
      ok: true,
      events: runtimeService.listEvents(hallId),
    });
    return true;
  }

  return false;
}

function normalizeShowSavePayload(body: Record<string, unknown>) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    throw new Error("播放表名称不能为空。");
  }
  assertValidShowTitle(title);

  const issuer = readOptionalString(body.issuer) || "GDC";
  const creator = readOptionalString(body.creator) || "SMS";
  assertNoChineseXmlText(issuer, "Issuer");
  assertNoChineseXmlText(creator, "Creator");

  return {
    title,
    showUuid: readOptionalString(body.showUuid),
    contentVersionId: readOptionalString(body.contentVersionId),
    playlistPackId: readOptionalString(body.playlistPackId),
    issuer,
    creator,
    playCount: readOptionalNumber(body.playCount) ?? 1,
    preShowCommands: normalizeCommands(body.preShowCommands),
    segments: normalizeSegments(body.segments),
  };
}

function normalizeSegments(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("播放表至少需要一个 CPL。");
  }

  const segments = value.map((raw) => {
    const record = asRecord(raw);
    return {
      cplUuid: readRequiredString(record.cplUuid, "CPL UUID"),
      commands: normalizeCommands(record.commands),
    };
  });

  if (segments.length === 0) {
    throw new Error("播放表至少需要一个 CPL。");
  }

  return segments;
}

function normalizeCommands(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((raw) => {
    const record = asRecord(raw);
    const label = readRequiredString(record.label, "自动化指令");
    const annotationText = readOptionalString(record.annotationText) || label;
    assertNoChineseXmlText(label, "自动化指令");
    assertNoChineseXmlText(annotationText, "自动化指令备注");
    return {
      markerUuid: readOptionalString(record.markerUuid),
      label,
      annotationText,
      offsetFrames: readOptionalNumber(record.offsetFrames),
      editRate: readOptionalString(record.editRate) || "24 1",
    };
  });
}

function assertValidShowTitle(value: string): void {
  assertNoChineseXmlText(value, "播放表名称");
  if (!/^[A-Za-z0-9 ,./\-_@#%]+$/.test(value)) {
    throw new Error("播放表名称只能包含英文、数字、空格以及 ,./-_@#%。");
  }
}

function assertNoChineseXmlText(value: string, label: string): void {
  if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(value)) {
    throw new Error(`${label}不能包含中文，播放表 XML 内不允许中文字符。`);
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLogDate(value: unknown): string {
  const date = readRequiredString(value, "日志日期");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("日志日期格式必须为 YYYY-MM-DD。");
  }
  return date;
}

function readRequiredString(value: unknown, label: string): string {
  const text = readOptionalString(value);
  if (!text) {
    throw new Error(`${label}不能为空。`);
  }
  return text;
}

function readOptionalNumber(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function sanitizeActivityPayload(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/password|token|secret/i.test(key)) {
      copy[key] = "[redacted]";
    } else {
      copy[key] = raw;
    }
  }
  return copy;
}

async function getDangerousAutomationFilterEnabled(): Promise<boolean> {
  if (dangerousAutomationFilterCache && dangerousAutomationFilterCache.expiresAt > Date.now()) {
    return dangerousAutomationFilterCache.value;
  }

  const value = await readAutomationDangerousCommandFilterEnabled().catch(() => true);
  dangerousAutomationFilterCache = {
    value,
    expiresAt: Date.now() + 30_000,
  };
  return value;
}

function streamRuntime(
  response: ServerResponse,
  initialHalls: HallRuntimeRecord[],
  initialEvents: HallDeviceEvent[],
  eventFilter: (event: HallDeviceEvent) => boolean = () => true,
  snapshotFilter: (record: HallRuntimeRecord) => boolean = () => true,
  hideDangerousAutomationCommands = true,
): void {
  const runtimeService = getRuntimeService();

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  writeSseEvent(response, "bootstrap", {
    halls: initialHalls,
    events: initialEvents,
  });

  const onSnapshot = (record: HallRuntimeRecord) => {
    if (!snapshotFilter(record)) {
      return;
    }
    writeSseEvent(response, "snapshot", sanitizeRuntimeRecord(record, hideDangerousAutomationCommands));
  };

  const onEvent = (event: HallDeviceEvent) => {
    if (!eventFilter(event)) {
      return;
    }
    writeSseEvent(response, "runtime-event", event);
  };

  runtimeService.registry.on("snapshot", onSnapshot);
  runtimeService.registry.on("event", onEvent);

  const heartbeat = setInterval(() => {
    response.write(": keepalive\n\n");
  }, 15_000);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    runtimeService.registry.off("snapshot", onSnapshot);
    runtimeService.registry.off("event", onEvent);
  };

  response.on("close", cleanup);
  response.on("finish", cleanup);
}

function sanitizeRuntimeRecords(
  records: HallRuntimeRecord[],
  hideDangerousAutomationCommands: boolean,
): HallRuntimeRecord[] {
  return records.flatMap((record) => {
    const sanitized = sanitizeRuntimeRecord(record, hideDangerousAutomationCommands);
    return sanitized ? [sanitized] : [];
  });
}

function sanitizeRuntimeRecord(
  record: HallRuntimeRecord | undefined,
  hideDangerousAutomationCommands: boolean,
): HallRuntimeRecord | undefined {
  if (!record) {
    return undefined;
  }

  return {
    ...record,
    snapshot: {
      ...record.snapshot,
      automation: {
        ...record.snapshot.automation,
        labels: filterAutomationLabels(record.snapshot.automation.labels, hideDangerousAutomationCommands),
      },
    },
  };
}

function filterAutomationLabels(
  labels: readonly string[] | undefined,
  hideDangerousAutomationCommands: boolean,
): string[] {
  const normalized = Array.isArray(labels) ? [...labels] : [];
  if (!hideDangerousAutomationCommands) {
    return normalized;
  }

  return normalized.filter((label) => !isDangerousAutomationLabel(label));
}

function isDangerousAutomationLabel(label: string): boolean {
  const normalized = String(label || "").trim().toUpperCase();
  return normalized === "FIRE_ALARM"
    || normalized.startsWith("GPI_")
    || normalized.startsWith("GPO_");
}

function writeSseEvent(response: ServerResponse, eventName: string, payload: unknown): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getHallControlUnavailableReason(runtime: HallRuntimeRecord): string {
  const connectivityState = runtime.snapshot.connectivity?.state;
  if (connectivityState !== "online") {
    return describeConnectivityUnavailableReason(connectivityState, "播放控制");
  }

  if (runtime.snapshot.serverInfo?.projectorStatus?.connectionState !== "Connected") {
    return "放映机未连接，播放控制已禁用。";
  }

  return "";
}

function getHallAutomationUnavailableReason(runtime: HallRuntimeRecord): string {
  const connectivityState = runtime.snapshot.connectivity?.state;
  if (connectivityState !== "online") {
    return describeConnectivityUnavailableReason(connectivityState, "自动化指令");
  }

  if (runtime.snapshot.serverInfo?.projectorStatus?.connectionState !== "Connected") {
    return "放映机未连接，自动化指令已禁用。";
  }

  return "";
}

function describeConnectivityUnavailableReason(
  state: HallRuntimeRecord["snapshot"]["connectivity"]["state"] | undefined,
  capability: string,
): string {
  if (state === "unknown") {
    return `放映服务器连接状态尚未确认，${capability}已禁用。`;
  }

  return `放映服务器离线，${capability}已禁用。`;
}
