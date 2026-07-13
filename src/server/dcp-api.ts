import type { IncomingMessage, ServerResponse } from "node:http";
import type { HallRuntimeRecord } from "../runtime";
import { getRepositoryFtpService } from "./ftp-service";
import { ApiError, readJsonBody, sendJson } from "./http";
import { getActivityService } from "./activity-service";
import {
  buildExternalFtpContentPath,
  buildExternalFtpIngestSourceUri,
  buildExternalFtpSourceUri,
  inspectExternalDcpPackage,
  listExternalFtpDirectory,
  type ExternalFtpSource,
} from "./external-dcp-ftp";
import {
  createExternalFtpSource,
  deleteExternalFtpSource,
  listExternalFtpSourceSummaries,
  readExternalFtpSourceById,
  type ExternalFtpSourceSummary,
} from "./external-ftp-source-store";
import {
  cancelDcpUpload,
  createDcpUploadSession,
  finishDcpUpload,
  listDcpPackages,
  readDcpPackageById,
  writeDcpUploadFile,
  type DcpCplRecord,
  type DcpPackageRecord,
} from "./dcp-store";
import {
  createIngestTask,
  isMissingRemoteIngestStatus,
  isTerminalIngestTaskStatus,
  listIngestTasks,
  readIngestTaskById,
  readActiveIngestTask,
  type IngestTaskRecord,
  updateIngestTaskFromStatus,
  updateIngestTaskStatus,
} from "./ingest-task-store";
import { getRuntimeService } from "./runtime-service";
import { readRepositoryCapacity } from "./repository-capacity";
import { requireSession } from "./session";
import { readRepositoryConfig } from "./setup-store";

interface ExternalFtpSourcePayload {
  readonly id: string;
  readonly label?: string;
  readonly rootPath?: string;
  readonly online?: boolean;
  readonly hallId?: string;
  readonly kind: "hall" | "custom";
  readonly selectable?: boolean;
  readonly disabledReason?: string;
}

export async function handleDcpApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith("/api/dcp")) {
    return false;
  }

  const session = await requireSession(request);

  if (request.method === "GET" && pathname === "/api/dcp/assets") {
    const [packages, tasks, repositoryCapacity] = await Promise.all([
      listDcpPackages(),
      refreshDcpIngestTasks(),
      readRepositoryCapacity(),
    ]);
    sendJson(response, 200, {
      ok: true,
      packages,
      cpls: flattenDcpCpls(packages),
      halls: listOnlineImportTargets(),
      tasks,
      repositoryCapacity,
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/dcp/ingest-tasks") {
    const tasks = await refreshDcpIngestTasks();
    sendJson(response, 200, { ok: true, tasks });
    return true;
  }

  const cancelIngestTaskMatch = /^\/api\/dcp\/ingest-tasks\/([^/]+)\/cancel$/.exec(pathname);
  if (request.method === "POST" && cancelIngestTaskMatch) {
    const taskId = decodeURIComponent(cancelIngestTaskMatch[1]);
    const task = await cancelDcpIngestTask(taskId, session);
    const tasks = await refreshDcpIngestTasks();
    sendJson(response, 200, { ok: true, task, tasks });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/dcp/external-ftp/sources") {
    const targetHallId = searchParams.get("hallId") || "";
    sendJson(response, 200, { ok: true, sources: await listExternalFtpSources(targetHallId) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/external-ftp/sources") {
    const body = await readJsonBody(request);
    const source = await createExternalFtpSource(body.source);
    const targetHallId = typeof body.hallId === "string" ? body.hallId : "";
    sendJson(response, 200, { ok: true, source, sources: await listExternalFtpSources(targetHallId) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/external-ftp/sources/remove") {
    const body = await readJsonBody(request);
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
    if (!sourceId || sourceId.startsWith("hall:")) {
      throw new ApiError(400, "只能移除手动添加的 FTP 来源。");
    }
    const deleted = await deleteExternalFtpSource(sourceId);
    if (!deleted) {
      throw new ApiError(404, "外部 FTP 来源不存在。");
    }
    const targetHallId = typeof body.hallId === "string" ? body.hallId : "";
    sendJson(response, 200, { ok: true, sources: await listExternalFtpSources(targetHallId) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/external-ftp/list") {
    const body = await readJsonBody(request);
    const targetHallId = typeof body.hallId === "string" ? body.hallId.trim() : "";
    const source = await resolveExternalFtpSource(body.sourceId, targetHallId);
    const path = typeof body.path === "string" ? body.path : "";
    const listing = await listExternalFtpDirectory(source, path);
    sendJson(response, 200, { ok: true, ...listing });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/external-ftp/package") {
    const body = await readJsonBody(request);
    const targetHallId = typeof body.hallId === "string" ? body.hallId.trim() : "";
    const source = await resolveExternalFtpSource(body.sourceId, targetHallId);
    const path = typeof body.path === "string" ? body.path : "";
    const dcpPackage = await inspectExternalDcpPackage(source, path);
    sendJson(response, 200, { ok: true, package: toExternalDcpPackagePayload(dcpPackage) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/external-ftp/ingest") {
    const body = await readJsonBody(request);
    const packagePath = typeof body.path === "string" ? body.path : "";
    const cplUuid = typeof body.cplUuid === "string" ? body.cplUuid.trim() : "";
    const hallId = typeof body.hallId === "string" ? body.hallId.trim() : "";
    if (!cplUuid) {
      throw new ApiError(400, "请选择要导入的影片版本。");
    }
    if (!hallId) {
      throw new ApiError(400, "请选择目标影厅。");
    }
    const source = await resolveExternalFtpSource(body.sourceId, hallId);

    const result = await importExternalDcpCpl(source, packagePath, cplUuid, hallId, session);
    const tasks = await refreshDcpIngestTasks();
    sendJson(response, 200, { ok: true, ...result, tasks });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/upload/start") {
    const body = await readJsonBody(request);
    const packageName = typeof body.packageName === "string" ? body.packageName : "";
    if (!packageName.trim()) {
      throw new ApiError(400, "缺少影片包名称。");
    }
    const upload = await createDcpUploadSession(packageName);
    sendJson(response, 200, { ok: true, upload });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/upload-file") {
    const uploadId = searchParams.get("uploadId") || "";
    const relativePath = searchParams.get("relativePath") || "";
    if (!uploadId || !relativePath) {
      throw new ApiError(400, "缺少上传会话或文件路径。");
    }
    await writeDcpUploadFile(uploadId, relativePath, request);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/upload/finish") {
    const body = await readJsonBody(request);
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    if (!uploadId) {
      throw new ApiError(400, "缺少上传会话。");
    }
    const uploaded = await finishDcpUpload(uploadId);
    await getActivityService().create({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "dcp.upload",
      objectType: "dcp",
      objectId: uploaded.id,
      objectName: uploaded.name,
      status: "success",
      resultMessage: `已上传影片包：${uploaded.name}`,
      payload: {
        packageId: uploaded.id,
        relativePath: uploaded.relativePath,
        cplCount: uploaded.cplCount,
        pklCount: uploaded.pklCount,
        size: uploaded.size,
      },
    }).catch(() => undefined);
    const [packages, tasks, repositoryCapacity] = await Promise.all([
      listDcpPackages(),
      refreshDcpIngestTasks(),
      readRepositoryCapacity(),
    ]);
    sendJson(response, 200, {
      ok: true,
      uploaded,
      packages,
      cpls: flattenDcpCpls(packages),
      halls: listOnlineImportTargets(),
      tasks,
      repositoryCapacity,
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/upload/cancel") {
    const body = await readJsonBody(request);
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
    if (uploadId) {
      await cancelDcpUpload(uploadId);
    }
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/ingest-check") {
    const body = await readJsonBody(request);
    const items = normalizeCheckItems(body);
    if (items.length === 0) {
      throw new ApiError(400, "请至少选择一个影片版本。");
    }

    const check = await checkDcpImportTargets(items);
    sendJson(response, 200, { ok: true, check });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/dcp/ingest") {
    const body = await readJsonBody(request);
    const items = normalizeIngestItems(body.items);
    const hallIds = Array.isArray(body.hallIds)
      ? [...new Set(body.hallIds.filter((id: unknown) => typeof id === "string" && id.trim()).map(String))]
      : [];
    if (items.length === 0) {
      throw new ApiError(400, "请至少选择一个影片版本。");
    }
    if (hallIds.length === 0) {
      throw new ApiError(400, "请选择目标影厅。");
    }

    const result = await importDcpItems(items, hallIds, session);
    const [packages, tasks, repositoryCapacity] = await Promise.all([
      listDcpPackages(),
      refreshDcpIngestTasks(),
      readRepositoryCapacity(),
    ]);
    sendJson(response, 200, {
      ok: true,
      ...result,
      packages,
      cpls: flattenDcpCpls(packages),
      halls: listOnlineImportTargets(),
      tasks,
      repositoryCapacity,
    });
    return true;
  }

  return false;
}

async function importDcpItems(
  items: readonly { packageId: string; cplUuid: string }[],
  hallIds: readonly string[],
  session: Awaited<ReturnType<typeof requireSession>>,
): Promise<{
  imported: Array<{ packageId: string; cplUuid: string; hallId: string; ingestUuid: string; task: IngestTaskRecord | null; reused?: boolean }>;
  failed: Array<{ packageId: string; cplUuid: string; hallId?: string; error: string }>;
}> {
  const packages = await listDcpPackages();
  const packageById = new Map<string, DcpPackageRecord>();
  for (const item of packages) {
    packageById.set(item.id, item);
    packageById.set(item.name, item);
  }

  const imported: Array<{ packageId: string; cplUuid: string; hallId: string; ingestUuid: string; task: IngestTaskRecord | null; reused?: boolean }> = [];
  const failed: Array<{ packageId: string; cplUuid: string; hallId?: string; error: string }> = [];

  for (const item of items) {
    const dcpPackage = packageById.get(item.packageId);
    if (!dcpPackage) {
      failed.push({ packageId: item.packageId, cplUuid: item.cplUuid, error: "未找到指定的影片包。" });
      continue;
    }
    const cpl = dcpPackage.cpls.find((candidate) => normalizeUuid(candidate.uuid) === normalizeUuid(item.cplUuid));
    if (!cpl) {
      failed.push({ packageId: dcpPackage.id, cplUuid: item.cplUuid, error: "未找到指定的影片版本。" });
    }
  }

  const uniqueRequests = uniqueIngestRequests(items, hallIds, packageById);
  for (const request of uniqueRequests) {
    try {
      const result = await importDcpCpl(request.dcpPackage, request.cpl, request.hallId, session);
      imported.push(result);
    } catch (error) {
      failed.push({
        packageId: request.dcpPackage.id,
        cplUuid: request.cpl.uuid,
        hallId: request.hallId,
        error: error instanceof Error ? error.message : "影片版本导入任务创建失败。",
      });
    }
  }

  await getActivityService().create({
    actorType: "user",
    actorId: String(session.userId),
    actorName: session.username,
    action: "dcp.ingest.batch",
    objectType: "dcp",
    objectId: items.map((item) => item.cplUuid).join(","),
    objectName: `批量导入 ${imported.length} 个影片版本`,
    status: failed.length === 0 ? "success" : imported.length > 0 ? "success" : "error",
    resultMessage: `成功 ${imported.length}，失败 ${failed.length}`,
    payload: { imported, failed },
  }).catch(() => undefined);

  return { imported, failed };
}

async function importDcpCpl(
  dcpPackage: DcpPackageRecord,
  cpl: DcpCplRecord,
  hallId: string,
  session: Awaited<ReturnType<typeof requireSession>>,
): Promise<{ packageId: string; cplUuid: string; hallId: string; ingestUuid: string; task: IngestTaskRecord | null; reused?: boolean }> {
  if (dcpPackage.status === "error") {
    throw new ApiError(409, "影片包校验未通过，无法导入。");
  }
  if (!dcpPackage.assetMapPath) {
    throw new ApiError(409, "影片包缺少 ASSETMAP，无法导入。");
  }
  if (!cpl.pklUuid) {
    throw new ApiError(409, "该影片版本未关联到 PKL，无法导入。");
  }

  const runtime = getRuntimeService().getRuntimeRecord(hallId);
  if (!runtime) {
    throw new ApiError(404, "未找到目标影厅。");
  }
  if (runtime.snapshot.connectivity?.state !== "online") {
    throw new ApiError(409, `目标影厅 ${runtime.registration.hallName || hallId} 当前离线，无法导入。`);
  }

  const readiness = await checkHallDcpReadiness(runtime, [cpl], getDcpRequiredBytes([cpl]), { force: true });
  if (!readiness.selectable) {
    throw new ApiError(409, readiness.reason || `目标影厅 ${runtime.registration.hallName || hallId} 当前不可导入。`);
  }

  const assetId = `${dcpPackage.id}:${normalizeUuid(cpl.pklUuid)}`;
  const activeTask = await readActiveIngestTask("DCP", hallId, assetId);
  if (activeTask) {
    const refreshed = await refreshIngestTask(activeTask);
    return {
      packageId: dcpPackage.id,
      cplUuid: cpl.uuid,
      hallId,
      ingestUuid: refreshed?.ingestUuid ?? activeTask.ingestUuid,
      task: refreshed ?? activeTask,
      reused: true,
    };
  }

  const ftp = getRepositoryFtpService().getStatus();
  if (ftp.state !== "running") {
    throw new ApiError(409, "FTP 服务未运行，无法向 GDC 提供影片包文件。");
  }

  const repository = await readRepositoryConfig();
  const endpointHost = repository.projectorAccessHost || ftp.passiveHost || (ftp.host !== "0.0.0.0" ? ftp.host : "");
  if (!endpointHost) {
    throw new ApiError(409, "FTP 服务未配置放映机可访问地址，请先到系统设置中填写“放映机访问地址”。");
  }

  const source = `ftp://${endpointHost}:${ftp.port}`;
  const path = encodeFtpPath(`${dcpPackage.relativePath}/${dcpPackage.assetMapPath}`);
  const startedAt = Date.now();
  let importResult;
  try {
    importResult = await getRuntimeService().ingestContent(hallId, {
      source,
      path,
      assetUuid: cpl.pklUuid,
      assetType: "PKL",
    });
  } catch (error) {
    await getActivityService().create({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "dcp.ingest.create",
      objectType: "dcp",
      objectId: cpl.uuid,
      objectName: cpl.contentTitleText || cpl.annotationText || cpl.fileName,
      hallId,
      status: "error",
      resultMessage: error instanceof Error ? error.message : "DCP 摄取任务创建失败。",
      durationMs: Date.now() - startedAt,
      payload: buildDcpActivityPayload(dcpPackage, cpl, { source, path }),
    }).catch(() => undefined);
    throw error;
  }

  const task = await createIngestTask({
    type: "DCP",
    hallId,
    hallName: runtime.registration.hallName,
    assetId,
    assetTitle: cpl.contentTitleText || cpl.annotationText || dcpPackage.name,
    ingestUuid: importResult.ingestUuid,
    source,
    path,
    metadata: buildDcpActivityPayload(dcpPackage, cpl, {
      pklUuid: cpl.pklUuid,
      pklPath: cpl.pklPath,
    }),
  });
  await getActivityService().create({
    actorType: "user",
    actorId: String(session.userId),
    actorName: session.username,
    action: "dcp.ingest.create",
    objectType: "dcp",
    objectId: cpl.uuid,
    objectName: cpl.contentTitleText || cpl.annotationText || cpl.fileName,
    hallId,
    status: "success",
    resultMessage: "已创建 DCP 内容摄取任务。",
    durationMs: Date.now() - startedAt,
    payload: buildDcpActivityPayload(dcpPackage, cpl, {
      ingestUuid: importResult.ingestUuid,
      taskId: task?.id,
      source,
      path,
    }),
  }).catch(() => undefined);

  return {
    packageId: dcpPackage.id,
    cplUuid: cpl.uuid,
    hallId,
    ingestUuid: importResult.ingestUuid,
    task,
  };
}

async function importExternalDcpCpl(
  source: ExternalFtpSource,
  packagePath: string,
  cplUuid: string,
  hallId: string,
  session: Awaited<ReturnType<typeof requireSession>>,
): Promise<{
  imported: Array<{ packageId: string; cplUuid: string; hallId: string; ingestUuid: string; task: IngestTaskRecord | null; reused?: boolean }>;
  failed: Array<{ packageId: string; cplUuid: string; hallId?: string; error: string }>;
}> {
  const dcpPackage = await inspectExternalDcpPackage(source, packagePath);
  const cpl = dcpPackage.cpls.find((candidate) => normalizeUuid(candidate.uuid) === normalizeUuid(cplUuid));
  if (!cpl) {
    throw new ApiError(404, "未找到指定的影片版本。");
  }

  try {
    const imported = await importExternalDcpPackageCpl(dcpPackage, cpl, source, hallId, session);
    await getActivityService().create({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "dcp.external-ingest.batch",
      objectType: "dcp",
      objectId: cpl.uuid,
      objectName: cpl.contentTitleText || cpl.annotationText || dcpPackage.name,
      hallId,
      status: "success",
      resultMessage: "已创建外部 DCP 导入任务。",
      payload: { imported, source: buildExternalFtpSourceUri(source), packagePath },
    }).catch(() => undefined);
    return { imported: [imported], failed: [] };
  } catch (error) {
    const failed = {
      packageId: dcpPackage.id,
      cplUuid: cpl.uuid,
      hallId,
      error: error instanceof Error ? error.message : "外部影片版本导入任务创建失败。",
    };
    await getActivityService().create({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "dcp.external-ingest.batch",
      objectType: "dcp",
      objectId: cpl.uuid,
      objectName: cpl.contentTitleText || cpl.annotationText || dcpPackage.name,
      hallId,
      status: "error",
      resultMessage: failed.error,
      payload: { failed, source: buildExternalFtpSourceUri(source), packagePath },
    }).catch(() => undefined);
    return { imported: [], failed: [failed] };
  }
}

async function importExternalDcpPackageCpl(
  dcpPackage: DcpPackageRecord,
  cpl: DcpCplRecord,
  sourceConfig: ExternalFtpSource,
  hallId: string,
  session: Awaited<ReturnType<typeof requireSession>>,
): Promise<{ packageId: string; cplUuid: string; hallId: string; ingestUuid: string; task: IngestTaskRecord | null; reused?: boolean }> {
  if (dcpPackage.status === "error") {
    throw new ApiError(409, "影片包校验未通过，无法导入。");
  }
  if (!dcpPackage.assetMapPath) {
    throw new ApiError(409, "影片包缺少 ASSETMAP，无法导入。");
  }
  if (!cpl.pklUuid) {
    throw new ApiError(409, "该影片版本未关联到 PKL，无法导入。");
  }

  const runtime = getRuntimeService().getRuntimeRecord(hallId);
  if (!runtime) {
    throw new ApiError(404, "未找到目标影厅。");
  }
  if (runtime.snapshot.connectivity?.state !== "online") {
    throw new ApiError(409, `目标影厅 ${runtime.registration.hallName || hallId} 当前离线，无法导入。`);
  }

  const readiness = await checkHallDcpReadiness(runtime, [cpl], getDcpRequiredBytes([cpl]), { force: true });
  if (!readiness.selectable) {
    throw new ApiError(409, readiness.reason || `目标影厅 ${runtime.registration.hallName || hallId} 当前不可导入。`);
  }

  const source = buildExternalFtpSourceUri(sourceConfig);
  const ingestSource = buildExternalFtpIngestSourceUri(sourceConfig);
  const path = buildExternalFtpContentPath(sourceConfig, dcpPackage.relativePath, dcpPackage.assetMapPath);
  const assetId = `${dcpPackage.id}:${normalizeUuid(cpl.pklUuid)}`;
  const activeTask = await readActiveIngestTask("DCP", hallId, assetId);
  if (activeTask) {
    const refreshed = await refreshIngestTask(activeTask);
    return {
      packageId: dcpPackage.id,
      cplUuid: cpl.uuid,
      hallId,
      ingestUuid: refreshed?.ingestUuid ?? activeTask.ingestUuid,
      task: refreshed ?? activeTask,
      reused: true,
    };
  }

  const startedAt = Date.now();
  let importResult;
  try {
    importResult = await getRuntimeService().ingestContent(hallId, {
      source: ingestSource,
      path,
      assetUuid: cpl.pklUuid,
      assetType: "PKL",
    });
  } catch (error) {
    await getActivityService().create({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "dcp.external-ingest.create",
      objectType: "dcp",
      objectId: cpl.uuid,
      objectName: cpl.contentTitleText || cpl.annotationText || dcpPackage.name,
      hallId,
      status: "error",
      resultMessage: error instanceof Error ? error.message : "外部 DCP 摄取任务创建失败。",
      durationMs: Date.now() - startedAt,
      payload: buildDcpActivityPayload(dcpPackage, cpl, { source, path, external: true }),
    }).catch(() => undefined);
    throw error;
  }

  const task = await createIngestTask({
    type: "DCP",
    hallId,
    hallName: runtime.registration.hallName,
    assetId,
    assetTitle: cpl.contentTitleText || cpl.annotationText || dcpPackage.name,
    ingestUuid: importResult.ingestUuid,
    source,
    path,
    metadata: buildDcpActivityPayload(dcpPackage, cpl, {
      external: true,
      sourceLabel: sourceConfig.label,
      pklUuid: cpl.pklUuid,
      pklPath: cpl.pklPath,
    }),
  });
  await getActivityService().create({
    actorType: "user",
    actorId: String(session.userId),
    actorName: session.username,
    action: "dcp.external-ingest.create",
    objectType: "dcp",
    objectId: cpl.uuid,
    objectName: cpl.contentTitleText || cpl.annotationText || dcpPackage.name,
    hallId,
    status: "success",
    resultMessage: "已创建外部 DCP 内容摄取任务。",
    durationMs: Date.now() - startedAt,
    payload: buildDcpActivityPayload(dcpPackage, cpl, {
      external: true,
      ingestUuid: importResult.ingestUuid,
      taskId: task?.id,
      source,
      path,
    }),
  }).catch(() => undefined);

  return {
    packageId: dcpPackage.id,
    cplUuid: cpl.uuid,
    hallId,
    ingestUuid: importResult.ingestUuid,
    task,
  };
}

async function checkDcpImportTargets(items: readonly { packageId: string; cplUuid: string }[]): Promise<{
  readonly items: ReadonlyArray<{
    readonly packageId: string;
    readonly packageName: string;
    readonly cplUuid: string;
    readonly title?: string;
    readonly requiredSize?: number;
  }>;
  readonly requiredSize: number;
  readonly halls: readonly DcpHallImportCheck[];
}> {
  const packages = await listDcpPackages();
  const packageById = new Map<string, DcpPackageRecord>();
  for (const dcpPackage of packages) {
    packageById.set(dcpPackage.id, dcpPackage);
    packageById.set(dcpPackage.name, dcpPackage);
  }

  const selected: Array<{ dcpPackage: DcpPackageRecord; cpl: DcpCplRecord }> = [];
  for (const item of items) {
    const dcpPackage = packageById.get(item.packageId);
    if (!dcpPackage) {
      throw new ApiError(404, "未找到指定的影片包。");
    }
    const cpl = dcpPackage.cpls.find((candidate) => normalizeUuid(candidate.uuid) === normalizeUuid(item.cplUuid));
    if (!cpl) {
      throw new ApiError(404, "未找到指定的影片版本。");
    }
    selected.push({ dcpPackage, cpl });
  }

  const cpls = selected.map((item) => item.cpl);
  const requiredSize = getDcpRequiredBytes(cpls);
  const halls = await Promise.all(
    getRuntimeService().listRuntimeRecords().map((runtime) =>
      checkHallDcpReadiness(runtime, cpls, requiredSize, { force: true }),
    ),
  );

  return {
    items: selected.map(({ dcpPackage, cpl }) => ({
      packageId: dcpPackage.id,
      packageName: dcpPackage.name,
      cplUuid: cpl.uuid,
      title: cpl.contentTitleText || cpl.annotationText || cpl.fileName,
      requiredSize: cpl.requiredSize,
    })),
    requiredSize,
    halls,
  };
}

interface DcpHallImportCheck {
  readonly hallId: string;
  readonly hallName?: string;
  readonly deviceId?: string;
  readonly online: boolean;
  readonly selectable: boolean;
  readonly reason?: string;
  readonly existingCplUuids: readonly string[];
  readonly missingCplUuids: readonly string[];
  readonly storage?: {
    readonly totalSpace?: number;
    readonly freeSpace?: number;
    readonly usedSpace?: number;
    readonly requiredSize: number;
    readonly enough: boolean | "unknown";
  };
}

async function checkHallDcpReadiness(
  runtime: HallRuntimeRecord,
  cpls: readonly DcpCplRecord[],
  requiredSize: number,
  options: { force?: boolean } = {},
): Promise<DcpHallImportCheck> {
  const base = {
    hallId: runtime.registration.hallId,
    hallName: runtime.registration.hallName,
    deviceId: runtime.registration.deviceId,
  };

  let current = runtime;
  let storageOverride = current.snapshot.serverInfo?.storageInfo;
  let existingCplUuids: string[] = [];
  if (options.force) {
    if (runtime.snapshot.connectivity?.state === "online") {
      try {
        const probe = await getRuntimeService().probeDcpImportReadiness(runtime.registration.hallId);
        storageOverride = probe.storageInfo;
        existingCplUuids = probe.cplUuids;
        current = {
          ...runtime,
          snapshot: {
            ...runtime.snapshot,
            serverInfo: {
              ...runtime.snapshot.serverInfo,
              storageInfo: storageOverride,
            },
          },
        };
      } catch (error) {
        return {
          ...base,
          online: true,
          selectable: false,
          reason: error instanceof Error ? error.message : "无法读取影厅存储或影片版本列表",
          existingCplUuids: [],
          missingCplUuids: cpls.map((cpl) => cpl.uuid),
          storage: buildStorageCheck(current, requiredSize, storageOverride),
        };
      }
    }
  }

  if (current.snapshot.connectivity?.state !== "online" && existingCplUuids.length === 0) {
    return {
      ...base,
      online: false,
      selectable: false,
      reason: "影厅离线",
      existingCplUuids: [],
      missingCplUuids: cpls.map((cpl) => cpl.uuid),
      storage: buildStorageCheck(current, requiredSize, storageOverride),
    };
  }

  if (!options.force) {
    try {
      existingCplUuids = await getRuntimeService().listCplUuids(current.registration.hallId);
    } catch (error) {
      return {
        ...base,
        online: true,
        selectable: false,
        reason: error instanceof Error ? error.message : "无法读取影厅影片版本列表",
        existingCplUuids: [],
        missingCplUuids: cpls.map((cpl) => cpl.uuid),
        storage: buildStorageCheck(current, requiredSize, storageOverride),
      };
    }
  }

  const existingSet = new Set(existingCplUuids.map(normalizeUuid));
  const requestedCplUuids = cpls.map((cpl) => cpl.uuid);
  const duplicated = requestedCplUuids.filter((cplUuid) => existingSet.has(normalizeUuid(cplUuid)));
  const storage = buildStorageCheck(current, requiredSize, storageOverride);

  if (duplicated.length > 0) {
    return {
      ...base,
      online: true,
      selectable: false,
      reason: "影厅已存在该版本",
      existingCplUuids: duplicated,
      missingCplUuids: requestedCplUuids.filter((cplUuid) => !existingSet.has(normalizeUuid(cplUuid))),
      storage,
    };
  }

  if (storage?.enough === false) {
    return {
      ...base,
      online: true,
      selectable: false,
      reason: "剩余存储空间不足",
      existingCplUuids: [],
      missingCplUuids: requestedCplUuids,
      storage,
    };
  }
  if (storage?.enough === "unknown") {
    return {
      ...base,
      online: true,
      selectable: false,
      reason: "无法确认剩余存储空间",
      existingCplUuids: [],
      missingCplUuids: requestedCplUuids,
      storage,
    };
  }

  return {
    ...base,
    online: true,
    selectable: true,
    existingCplUuids: [],
    missingCplUuids: requestedCplUuids,
    storage,
  };
}

function buildStorageCheck(
  runtime: HallRuntimeRecord,
  requiredSize: number,
  storageOverride?: HallRuntimeRecord["snapshot"]["serverInfo"]["storageInfo"],
): DcpHallImportCheck["storage"] {
  const storageInfo = storageOverride ?? runtime.snapshot.serverInfo?.storageInfo;
  const freeSpace = storageInfo?.freeSpace;
  const enough = Number.isFinite(freeSpace) && Number.isFinite(requiredSize) && requiredSize > 0
    ? Number(freeSpace) >= requiredSize
    : "unknown";
  return {
    totalSpace: storageInfo?.totalSpace,
    freeSpace,
    usedSpace: storageInfo?.usedSpace,
    requiredSize,
    enough,
  };
}

function getDcpRequiredBytes(cpls: readonly DcpCplRecord[]): number {
  const total = cpls.reduce((sum, cpl) => sum + (Number(cpl.requiredSize) || 0), 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

async function refreshDcpIngestTasks(): Promise<IngestTaskRecord[]> {
  const tasks = await listIngestTasks({ type: "DCP", limit: 100 });
  const unreachableHalls = new Set<string>();
  const refreshed: IngestTaskRecord[] = [];

  for (const task of tasks) {
    if (!isTerminalIngestTaskStatus(task.status) && unreachableHalls.has(task.hallId)) {
      refreshed.push(await markIngestTaskUnreachable(task, new Error("同影厅前序 GDC 请求失败。")) ?? task);
      continue;
    }

    const next = await refreshIngestTask(task) ?? task;
    refreshed.push(next);
    if (!isTerminalIngestTaskStatus(task.status) && next.status === "unreachable") {
      unreachableHalls.add(task.hallId);
    }
  }

  return refreshed;
}

async function refreshIngestTask(task: IngestTaskRecord): Promise<IngestTaskRecord | null> {
  if (isTerminalIngestTaskStatus(task.status)) {
    return task;
  }
  try {
    const status = await getRuntimeService().getIngestStatus(task.hallId, task.ingestUuid);
    if (isMissingRemoteIngestStatus(status)) {
      return resolveMissingDcpIngestTask(task, status);
    }
    return updateIngestTaskFromStatus(task, status);
  } catch (error) {
    return markIngestTaskUnreachable(task, error);
  }
}

async function markIngestTaskUnreachable(
  task: IngestTaskRecord,
  error: unknown,
): Promise<IngestTaskRecord | null> {
  if (task.status === "unreachable") {
    return task;
  }

  return updateIngestTaskStatus(task, "unreachable", {
    remoteStatus: "Unreachable",
    description: `影厅离线或 GDC 无响应，暂无法确认导入状态。${formatErrorSuffix(error)}`,
  });
}

async function resolveMissingDcpIngestTask(
  task: IngestTaskRecord,
  status: Awaited<ReturnType<ReturnType<typeof getRuntimeService>["getIngestStatus"]>>,
): Promise<IngestTaskRecord | null> {
  let ingestUuids: string[] = [];
  try {
    ingestUuids = await getRuntimeService().listIngestUuids(task.hallId);
  } catch {
    return updateIngestTaskFromStatus(task, status);
  }

  const stillListed = ingestUuids.some((uuid) => normalizeUuid(uuid) === normalizeUuid(task.ingestUuid));
  if (stillListed) {
    return updateIngestTaskFromStatus(task, status);
  }

  const cplUuid = typeof task.metadata.cplUuid === "string" ? task.metadata.cplUuid : "";
  if (cplUuid) {
    try {
      const cplUuids = await getRuntimeService().listCplUuids(task.hallId);
      if (cplUuids.some((uuid) => normalizeUuid(uuid) === normalizeUuid(cplUuid))) {
        return updateIngestTaskStatus(task, "complete", {
          remoteStatus: status.status || "Unknown",
          description: "GDC 已移除摄取任务，设备内已存在对应 CPL。",
          transferredSize: status.transferredSize,
          totalSize: status.totalSize,
        });
      }
    } catch {
      // If content verification fails, keep the lifecycle explicit instead of
      // leaving a stale active task that blocks future imports.
    }
  }

  return updateIngestTaskStatus(task, "removed", {
    remoteStatus: status.status || "Unknown",
    description: "GDC 已移除或找不到该摄取任务。",
    transferredSize: status.transferredSize,
    totalSize: status.totalSize,
  });
}

async function cancelDcpIngestTask(
  taskId: string,
  session: Awaited<ReturnType<typeof requireSession>>,
): Promise<IngestTaskRecord> {
  const task = await readIngestTaskById(taskId);
  if (!task || task.type !== "DCP") {
    throw new ApiError(404, "未找到指定的 DCP 导入任务。");
  }
  if (isTerminalIngestTaskStatus(task.status)) {
    throw new ApiError(409, "该导入任务已结束，无法取消。");
  }

  await getRuntimeService().cancelIngest(task.hallId, task.ingestUuid);
  const updated = await updateIngestTaskStatus(task, "cancelled", {
    remoteStatus: "Cancelled",
    description: "用户已从 TMS 取消该摄取任务。",
  });

  await getActivityService().create({
    actorType: "user",
    actorId: String(session.userId),
    actorName: session.username,
    action: "dcp.ingest.cancel",
    objectType: "dcp",
    objectId: task.assetId,
    objectName: task.assetTitle,
    hallId: task.hallId,
    status: "success",
    resultMessage: "已取消 DCP 摄取任务。",
    payload: {
      taskId: task.id,
      ingestUuid: task.ingestUuid,
      remoteStatus: updated?.remoteStatus,
      ...task.metadata,
    },
  }).catch(() => undefined);

  return updated ?? task;
}

function flattenDcpCpls(packages: readonly DcpPackageRecord[]) {
  return packages.flatMap((dcpPackage) => dcpPackage.cpls.map((cpl) => ({
    ...cpl,
    packageId: dcpPackage.id,
    packageName: dcpPackage.name,
    packageRelativePath: dcpPackage.relativePath,
    packageStatus: dcpPackage.status,
    packageValidationMessages: dcpPackage.validationMessages,
    packageSize: dcpPackage.size,
    assetMapPath: dcpPackage.assetMapPath,
  })));
}

function toExternalDcpPackagePayload(dcpPackage: DcpPackageRecord) {
  return {
    ...dcpPackage,
    absolutePath: undefined,
    cpls: dcpPackage.cpls.map((cpl) => ({
      ...cpl,
      packageId: dcpPackage.id,
      packageName: dcpPackage.name,
      packageStatus: dcpPackage.status,
      packageValidationMessages: dcpPackage.validationMessages,
      packageSize: dcpPackage.size,
      assetMapPath: dcpPackage.assetMapPath,
    })),
  };
}

function listOnlineImportTargets() {
  return getRuntimeService().listRuntimeRecords().map((runtime) => ({
    hallId: runtime.registration.hallId,
    hallName: runtime.registration.hallName,
    deviceId: runtime.registration.deviceId,
    online: runtime.snapshot.connectivity?.state === "online",
  }));
}

async function listExternalFtpSources(targetHallId = ""): Promise<ExternalFtpSourcePayload[]> {
  return [
    ...listHallExternalFtpSources(targetHallId),
    ...(await listExternalFtpSourceSummaries()).map(toExternalFtpSourcePayload),
  ];
}

function listHallExternalFtpSources(targetHallId = ""): ExternalFtpSourcePayload[] {
  return getRuntimeService().listRuntimeRecords()
    .filter((runtime) => !targetHallId || runtime.registration.hallId !== targetHallId)
    .map((runtime) => {
      const hallId = runtime.registration.hallId;
      const online = runtime.snapshot.connectivity?.state === "online";
      const hasHost = Boolean(runtime.registration.host);
      const disabledReason = !online
        ? "离线"
        : !hasHost
          ? "未配置 FTP 地址"
          : "";
      return {
        id: `hall:${hallId}`,
        label: runtime.registration.hallName || hallId,
        rootPath: "",
        online,
        hallId,
        kind: "hall" as const,
        selectable: !disabledReason,
        disabledReason: disabledReason || undefined,
      };
    });
}

async function resolveExternalFtpSource(value: unknown, targetHallId = ""): Promise<ExternalFtpSource> {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    throw new ApiError(400, "请选择外部 FTP 来源。");
  }
  if (id.startsWith("hall:")) {
    return readHallExternalFtpSource(id.slice("hall:".length), targetHallId);
  }
  const source = await readExternalFtpSourceById(id);
  if (!source) {
    throw new ApiError(404, "外部 FTP 来源不存在。");
  }
  return source;
}

function toExternalFtpSourcePayload(source: ExternalFtpSourceSummary): ExternalFtpSourcePayload {
  return {
    id: source.id,
    label: source.label,
    rootPath: source.rootPath,
    kind: "custom",
    selectable: true,
  };
}

function readHallExternalFtpSource(hallId: string, targetHallId = ""): ExternalFtpSource {
  const runtime = getRuntimeService().listRuntimeRecords()
    .find((item) => item.registration.hallId === hallId);
  if (!runtime) {
    throw new ApiError(404, "外部 FTP 来源不存在。");
  }
  if (targetHallId && hallId === targetHallId) {
    throw new ApiError(400, "不能从本机 FTP 导入。");
  }
  if (runtime.snapshot.connectivity?.state !== "online" || !runtime.registration.host) {
    throw new ApiError(400, "影厅 FTP 来源不可用。");
  }
  return {
    label: runtime.registration.hallName || runtime.registration.hallId,
    host: runtime.registration.host,
    port: 21,
    username: "content",
    password: "content",
    rootPath: "",
  };
}

function normalizeIngestItems(value: unknown): Array<{ packageId: string; cplUuid: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const packageId = typeof record.packageId === "string" ? record.packageId.trim() : "";
    const cplUuid = typeof record.cplUuid === "string" ? record.cplUuid.trim() : "";
    return packageId && cplUuid ? [{ packageId, cplUuid }] : [];
  });
}

function normalizeCheckItems(body: Record<string, unknown>): Array<{ packageId: string; cplUuid: string }> {
  const items = normalizeIngestItems(body.items);
  if (items.length > 0) {
    return items;
  }
  const packageId = typeof body.packageId === "string" ? body.packageId.trim() : "";
  const cplUuid = typeof body.cplUuid === "string" ? body.cplUuid.trim() : "";
  return packageId && cplUuid ? [{ packageId, cplUuid }] : [];
}

function formatErrorSuffix(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message ? `（${message}）` : "";
}

function uniqueIngestRequests(
  items: readonly { packageId: string; cplUuid: string }[],
  hallIds: readonly string[],
  packageById: Map<string, DcpPackageRecord>,
) {
  const requests: Array<{ dcpPackage: DcpPackageRecord; cpl: DcpCplRecord; hallId: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const dcpPackage = packageById.get(item.packageId);
    if (!dcpPackage) {
      continue;
    }
    const cpl = dcpPackage.cpls.find((candidate) => normalizeUuid(candidate.uuid) === normalizeUuid(item.cplUuid));
    if (!cpl) {
      continue;
    }
    for (const hallId of hallIds) {
      const key = `${dcpPackage.id}:${normalizeUuid(cpl.pklUuid || cpl.uuid)}:${hallId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      requests.push({ dcpPackage, cpl, hallId });
    }
  }
  return requests;
}

function buildDcpActivityPayload(
  dcpPackage: DcpPackageRecord,
  cpl: DcpCplRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    packageId: dcpPackage.id,
    packageName: dcpPackage.name,
    packageRelativePath: dcpPackage.relativePath,
    cplUuid: cpl.uuid,
    cplTitle: cpl.contentTitleText || cpl.annotationText,
    pklUuid: cpl.pklUuid,
    pklPath: cpl.pklPath,
    ...extra,
  };
}

function encodeFtpPath(relativePath: string): string {
  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeUuid(value: string): string {
  return value.trim().toLowerCase().replace(/^urn:uuid:/, "");
}
