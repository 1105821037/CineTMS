import type { IncomingMessage, ServerResponse } from "node:http";
import { getRepositoryFtpService } from "./ftp-service";
import { ApiError, readJsonBody, sendJson } from "./http";
import { getActivityService } from "./activity-service";
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
import { deleteKdmAsset, listKdmAssets, saveUploadedKdms, type KdmAssetRecord, type KdmUploadInput } from "./kdm-store";
import { getRuntimeService } from "./runtime-service";
import { requireSession } from "./session";
import { readConfiguredHalls, readRepositoryConfig } from "./setup-store";
import {
  downloadZyhxKdms,
  listZyhxKdms,
  loginZyhxKdms,
  ZyhxKdmLoginRequiredError,
  type ZyhxKdmListOptions,
} from "./zyhx-kdm-service";

export async function handleKdmApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/kdm")) {
    return false;
  }

  const session = await requireSession(request);

  if (request.method === "GET" && pathname === "/api/kdm/zyhx/list") {
    const searchParams = new URL(request.url ?? "/", "http://localhost").searchParams;
    let result;
    try {
      result = await listZyhxKdms(readZyhxListOptions(searchParams));
    } catch (error) {
      if (error instanceof ZyhxKdmLoginRequiredError) {
        sendJson(response, 409, {
          ok: false,
          code: "zyhx-login-required",
          error: error.message,
        });
        return true;
      }
      throw error;
    }
    sendJson(response, 200, { ok: true, result: await enrichZyhxKdmListResult(result) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/kdm/zyhx/login") {
    await loginZyhxKdms();
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/kdm/zyhx/download") {
    const body = await readJsonBody(request);
    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string" && id.trim()) : [];
    if (ids.length === 0) {
      throw new ApiError(400, "请至少选择一个中影华夏密钥。");
    }

    let result;
    try {
      result = await downloadZyhxKdms(ids);
    } catch (error) {
      if (error instanceof ZyhxKdmLoginRequiredError) {
        sendJson(response, 409, {
          ok: false,
          code: "zyhx-login-required",
          error: error.message,
        });
        return true;
      }
      throw error;
    }
    const assets = await listAssetsWithRuntimeStatus();
    const tasks = await refreshKdmIngestTasks();

    await getActivityService().create({
      id: `activity-kdm.zyhx-download-${Date.now()}`,
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "kdm.zyhx-download",
      objectType: "kdm",
      objectId: ids.join(","),
      objectName: `中影华夏密钥下载 ${result.downloaded.length} 个`,
      status: result.failed.length === 0 ? "success" : result.downloaded.length > 0 ? "success" : "error",
      resultMessage: `成功 ${result.downloaded.length}，失败 ${result.failed.length}`,
      payload: {
        ids,
        downloaded: result.downloaded.map((item) => ({
          id: item.id,
          uploaded: item.uploaded.map((asset) => asset.messageId || asset.id),
          rejected: item.rejected,
        })),
        failed: result.failed,
      },
    }).catch(() => undefined);

    sendJson(response, 200, {
      ok: true,
      downloaded: result.downloaded,
      failed: result.failed,
      assets,
      tasks,
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/kdm/assets") {
    const assets = await listAssetsWithRuntimeStatus();
    const tasks = await refreshKdmIngestTasks();
    sendJson(response, 200, {
      ok: true,
      assets,
      tasks,
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/kdm/ingest-tasks") {
    const tasks = await refreshKdmIngestTasks();
    sendJson(response, 200, {
      ok: true,
      tasks,
    });
    return true;
  }

  const cancelIngestTaskMatch = /^\/api\/kdm\/ingest-tasks\/([^/]+)\/cancel$/.exec(pathname);
  if (request.method === "POST" && cancelIngestTaskMatch) {
    const taskId = decodeURIComponent(cancelIngestTaskMatch[1]);
    const task = await cancelKdmIngestTask(taskId, session);
    const tasks = await refreshKdmIngestTasks();
    sendJson(response, 200, { ok: true, task, tasks });
    return true;
  }

  const hallKdmMatch = /^\/api\/kdm\/halls\/([^/]+)$/.exec(pathname);
  if (request.method === "GET" && hallKdmMatch) {
    const hallId = decodeURIComponent(hallKdmMatch[1]);
    sendJson(response, 200, {
      ok: true,
      ...(await buildHallKdmPayload(hallId)),
    });
    return true;
  }

  const hallKdmImportMatch = /^\/api\/kdm\/halls\/([^/]+)\/import$/.exec(pathname);
  if (request.method === "POST" && hallKdmImportMatch) {
    const hallId = decodeURIComponent(hallKdmImportMatch[1]);
    const body = await readJsonBody(request);
    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string" && id) : [];
    if (ids.length === 0) {
      throw new ApiError(400, "请至少选择一个 KDM。");
    }

    const result = await importHallKdmAssets(hallId, ids, session, "hall-repository");
    sendJson(response, 200, {
      ok: true,
      ...result,
      ...(await buildHallKdmPayload(hallId)),
    });
    return true;
  }

  const hallKdmUploadImportMatch = /^\/api\/kdm\/halls\/([^/]+)\/upload-import$/.exec(pathname);
  if (request.method === "POST" && hallKdmUploadImportMatch) {
    const hallId = decodeURIComponent(hallKdmUploadImportMatch[1]);
    const body = await readJsonBody(request);
    const files = normalizeUploadFiles(body.files);
    if (files.length === 0) {
      throw new ApiError(400, "请至少选择一个 KDM 文件。");
    }

    const uploadResult = await saveUploadedKdms(files);
    const uploadedIds = new Set(uploadResult.uploaded.flatMap((asset) => [
      asset.id,
      asset.messageId,
      asset.sha1,
    ].filter(Boolean)));
    const enrichedAssets = await listAssetsWithRuntimeStatus();
    const targetAssets = enrichedAssets.filter((asset) =>
      asset.targetHall?.hallId === hallId
      && (uploadedIds.has(asset.id) || uploadedIds.has(asset.messageId) || uploadedIds.has(asset.sha1)),
    );

    const result = await importHallKdmAssets(
      hallId,
      targetAssets.map((asset) => asset.id),
      session,
      "hall-upload",
    );

    const skipped = uploadResult.uploaded
      .filter((asset) => !targetAssets.some((target) => target.messageId === asset.messageId || target.sha1 === asset.sha1))
      .map((asset) => ({
        id: asset.id,
        fileName: asset.fileName,
        error: "该 KDM 的目标设备不是当前影厅，已保留在存储库。",
      }));

    sendJson(response, 200, {
      ok: true,
      uploaded: uploadResult.uploaded,
      rejected: uploadResult.rejected,
      skipped,
      imported: result.imported,
      failed: [...result.failed, ...skipped],
      ...(await buildHallKdmPayload(hallId)),
    });
    return true;
  }

  const hallKdmDeleteDeviceMatch = /^\/api\/kdm\/halls\/([^/]+)\/device\/([^/]+)$/.exec(pathname);
  if (request.method === "DELETE" && hallKdmDeleteDeviceMatch) {
    const hallId = decodeURIComponent(hallKdmDeleteDeviceMatch[1]);
    const assetUuid = decodeURIComponent(hallKdmDeleteDeviceMatch[2]);
    await getRuntimeService().deleteKdmFromDevice(hallId, assetUuid);

    await getActivityService().create({
      id: `activity-kdm.hall-delete-device-${assetUuid}-${Date.now()}`,
      actorType: "user",
      actorId: session.username,
      action: "kdm.hall-delete-device",
      objectType: "kdm",
      objectId: assetUuid,
      objectName: assetUuid,
      hallId,
      status: "success",
      resultMessage: "已从影厅设备删除 KDM。",
      payload: { hallId, assetUuid },
    }).catch(() => undefined);

    sendJson(response, 200, {
      ok: true,
      hallId,
      assetUuid,
      ...(await buildHallKdmPayload(hallId)),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/kdm/upload") {
    const body = await readJsonBody(request);
    const files = normalizeUploadFiles(body.files);
    if (files.length === 0) {
      throw new ApiError(400, "请至少选择一个 KDM 文件。");
    }

    const result = await saveUploadedKdms(files);
    const assets = await listAssetsWithRuntimeStatus();
    const tasks = await refreshKdmIngestTasks();
    sendJson(response, 200, {
      ok: true,
      uploaded: result.uploaded,
      rejected: result.rejected,
      assets,
      tasks,
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/kdm/batch-delete") {
    const body = await readJsonBody(request);
    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string" && id) : [];
    if (ids.length === 0) {
      throw new ApiError(400, "请至少选择一个 KDM。");
    }

    const enrichedAssets = await listAssetsWithRuntimeStatus();
    const deleted: Array<{ id: string; fileName: string; targetHall?: unknown }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    const onDevice: Array<{ id: string; messageId: string; hallId: string; hallName: string; title: string }> = [];

    for (const id of ids) {
      const enriched = enrichedAssets.find((a) => a.id === id || a.messageId === id);
      try {
        const result = await deleteKdmAsset(id);
        if (!result) {
          failed.push({ id, error: "未找到" });
          continue;
        }
        const targetHall = enriched?.targetHall;
        deleted.push({ id: result.id, fileName: result.fileName, targetHall });
        if (targetHall && (targetHall as { existingKdmStatus?: string }).existingKdmStatus === "present" && targetHall.online) {
          onDevice.push({
            id: result.id,
            messageId: result.messageId,
            hallId: targetHall.hallId,
            hallName: targetHall.hallName,
            title: result.contentTitleText || result.annotationText || result.fileName,
          });
        }
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : "删除失败" });
      }
    }

    await getActivityService().create({
      id: `activity-kdm.batch-delete-${Date.now()}`,
      actorType: "user",
      actorId: session.username,
      action: "kdm.batch-delete",
      objectType: "kdm",
      objectId: ids.join(","),
      objectName: `批量删除 ${deleted.length} 个 KDM`,
      status: failed.length === 0 ? "success" : "error",
      resultMessage: `成功 ${deleted.length}，失败 ${failed.length}`,
      payload: { deleted: deleted.map((d) => d.id), failed },
    }).catch(() => undefined);

    const assets = await listAssetsWithRuntimeStatus();
    const tasks = await refreshKdmIngestTasks();
    sendJson(response, 200, { ok: true, deleted, failed, onDevice, assets, tasks });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/kdm/batch-import") {
    const body = await readJsonBody(request);
    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string" && id) : [];
    if (ids.length === 0) {
      throw new ApiError(400, "请至少选择一个可导入的 KDM。");
    }

    const uniqueIds = [...new Set(ids)];
    const enrichedAssets = await listAssetsWithRuntimeStatus();
    const assetsById = new Map<string, KdmAssetRecord>();
    for (const asset of enrichedAssets) {
      assetsById.set(asset.id, asset);
      if (asset.messageId) {
        assetsById.set(asset.messageId, asset);
      }
    }

    const imported: Array<{
      assetId: string;
      hall: KdmAssetRecord["targetHall"];
      ingestUuid: string;
      task: IngestTaskRecord | null;
      reused?: boolean;
    }> = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of uniqueIds) {
      const asset = assetsById.get(id);
      if (!asset) {
        failed.push({ id, error: "未找到指定的 KDM 文件。" });
        continue;
      }

      if (isExpired(asset.validAfter)) {
        failed.push({ id, error: "该 KDM 已过期，不能批量导入。" });
        continue;
      }

      try {
        const result = await importKdmAsset(asset, session, "batch");
        imported.push(result);
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : "KDM 导入任务创建失败。" });
      }
    }

    await getActivityService().create({
      id: `activity-kdm.batch-import-${Date.now()}`,
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "kdm.batch-import",
      objectType: "kdm",
      objectId: uniqueIds.join(","),
      objectName: `批量导入 ${imported.length} 个 KDM`,
      status: failed.length === 0 ? "success" : imported.length > 0 ? "success" : "error",
      resultMessage: `成功 ${imported.length}，失败 ${failed.length}`,
      payload: {
        imported: imported.map((item) => ({
          assetId: item.assetId,
          hallId: item.hall?.hallId,
          ingestUuid: item.ingestUuid,
          reused: item.reused === true,
        })),
        failed,
      },
    }).catch(() => undefined);

    const assets = await listAssetsWithRuntimeStatus();
    const tasks = await refreshKdmIngestTasks();
    sendJson(response, 200, {
      ok: true,
      imported,
      failed,
      assets,
      tasks,
    });
    return true;
  }

  const deleteMatch = /^\/api\/kdm\/assets\/([^/]+)$/.exec(pathname);
  if (request.method === "DELETE" && deleteMatch) {
    const assetId = decodeURIComponent(deleteMatch[1]);
    const enrichedAssets = await listAssetsWithRuntimeStatus();
    const enrichedAsset = enrichedAssets.find((a) => a.id === assetId || a.messageId === assetId);

    const deleted = await deleteKdmAsset(assetId);
    if (!deleted) {
      throw new ApiError(404, "未找到指定的 KDM 文件。");
    }

    const deletedWithStatus = enrichedAsset ? { ...deleted, targetHall: enrichedAsset.targetHall } : deleted;

    await getActivityService().create({
      id: `activity-kdm.delete-${deleted.messageId}-${Date.now()}`,
      actorType: "user",
      actorId: session.username,
      action: "kdm.delete",
      objectType: "kdm",
      objectId: deleted.messageId || deleted.id,
      objectName: deleted.contentTitleText || deleted.annotationText || deleted.fileName,
      status: "success",
      resultMessage: `已删除 KDM: ${deleted.fileName}`,
      payload: buildKdmActivityPayload(deleted),
    }).catch(() => undefined);

    const assets = await listAssetsWithRuntimeStatus();
    const tasks = await refreshKdmIngestTasks();
    sendJson(response, 200, { ok: true, deleted: deletedWithStatus, assets, tasks });
    return true;
  }

  const deleteDeviceMatch = /^\/api\/kdm\/assets\/([^/]+)\/delete-from-device$/.exec(pathname);
  if (request.method === "POST" && deleteDeviceMatch) {
    const assetId = decodeURIComponent(deleteDeviceMatch[1]);
    const body = await readJsonBody(request);
    const hallId = typeof body.hallId === "string" ? body.hallId : "";
    if (!hallId) {
      throw new ApiError(400, "缺少 hallId 参数。");
    }

    const uuid = typeof body.uuid === "string" ? body.uuid : assetId;
    await getRuntimeService().deleteKdmFromDevice(hallId, uuid);

    await getActivityService().create({
      id: `activity-kdm.delete-device-${uuid}-${Date.now()}`,
      actorType: "user",
      actorId: session.username,
      action: "kdm.delete-device",
      objectType: "kdm",
      objectId: uuid,
      objectName: typeof body.title === "string" ? body.title : uuid,
      hallId,
      status: "success",
      resultMessage: `已从设备删除 KDM`,
      payload: { hallId, uuid },
    }).catch(() => undefined);

    sendJson(response, 200, { ok: true, hallId, uuid });
    return true;
  }

  const importMatch = /^\/api\/kdm\/assets\/([^/]+)\/import$/.exec(pathname);
  if (request.method === "POST" && importMatch) {
    const assetId = decodeURIComponent(importMatch[1]);
    const asset = (await listAssetsWithRuntimeStatus()).find((item) => item.id === assetId || item.messageId === assetId);
    if (!asset) {
      throw new ApiError(404, "未找到指定的 KDM 文件。");
    }
    const result = await importKdmAsset(asset, session, "single");
    sendJson(response, 200, {
      ok: true,
      ...result,
    });
    return true;
  }

  return false;
}

async function importKdmAsset(
  asset: KdmAssetRecord,
  session: Awaited<ReturnType<typeof requireSession>>,
  mode: "single" | "batch" | "hall-repository" | "hall-upload",
): Promise<{
  assetId: string;
  hall: KdmAssetRecord["targetHall"];
  ingestUuid: string;
  source?: string;
  task: IngestTaskRecord | null;
  reused?: boolean;
}> {
  if (isExpired(asset.validAfter)) {
    throw new ApiError(409, "该 KDM 已过期，无法导入。");
  }

  if (!asset.targetHall) {
    throw new ApiError(409, `未找到设备码 ${asset.targetDeviceCode || "-"} 对应的已配置影厅。`);
  }

  if (!asset.targetHall.online) {
    throw new ApiError(409, `目标设备 ${asset.targetHall.deviceCode} 当前离线，无法导入。`);
  }

  const existingKdmStatus = await readExistingKdmStatus(asset);
  if (existingKdmStatus === "present") {
    throw new ApiError(409, `目标设备 ${asset.targetHall.deviceCode} 内已存在该 KDM，不能重复导入。`);
  }
  if (existingKdmStatus === "unknown") {
    throw new ApiError(409, `无法确认目标设备 ${asset.targetHall.deviceCode} 是否已存在该 KDM，请刷新后重试。`);
  }

  const activeTask = await readActiveIngestTask("KDM", asset.targetHall.hallId, asset.messageId || asset.id);
  if (activeTask) {
    const refreshed = await refreshIngestTask(activeTask);
    await getActivityService().create({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "kdm.ingest.reuse",
      objectType: "kdm",
      objectId: asset.messageId || asset.id,
      objectName: asset.contentTitleText || asset.annotationText || asset.fileName,
      hallId: asset.targetHall.hallId,
      status: "success",
      resultMessage: "已有未完成的 KDM 摄取任务。",
      payload: buildKdmActivityPayload(asset, refreshed ?? activeTask, { mode }),
    }).catch(() => undefined);
    return {
      assetId: asset.id,
      hall: asset.targetHall,
      ingestUuid: refreshed?.ingestUuid ?? activeTask.ingestUuid,
      task: refreshed ?? activeTask,
      reused: true,
    };
  }

  const ftp = getRepositoryFtpService().getStatus();
  if (ftp.state !== "running") {
    throw new ApiError(409, "FTP 服务未运行，无法向 GDC 提供 KDM 文件。");
  }

  const repository = await readRepositoryConfig();
  const endpointHost = repository.projectorAccessHost || ftp.passiveHost || (ftp.host !== "0.0.0.0" ? ftp.host : "");
  if (!endpointHost) {
    throw new ApiError(409, "FTP 服务未配置放映机可访问地址，请先到系统设置中填写“放映机访问地址”。");
  }

  const encodedRelativePath = encodeFtpPath(asset.relativePath);
  const source = `ftp://${endpointHost}:${ftp.port}`;
  const path = `/${encodedRelativePath}`;
  let importResult;
  const startedAt = Date.now();
  try {
    importResult = await getRuntimeService().ingestFile(asset.targetHall.hallId, {
      source,
      // GDC on this site accepts KDM imports when the FTP root and full path are
      // split exactly like the successful manual test command.
      path,
      assetType: "KDM",
    });
  } catch (error) {
    await getActivityService().create({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "kdm.ingest.create",
      objectType: "kdm",
      objectId: asset.messageId || asset.id,
      objectName: asset.contentTitleText || asset.annotationText || asset.fileName,
      hallId: asset.targetHall.hallId,
      status: "error",
      resultMessage: error instanceof Error ? error.message : "KDM 摄取任务创建失败。",
      durationMs: Date.now() - startedAt,
      payload: buildKdmActivityPayload(asset, undefined, { source, path, mode }),
    }).catch(() => undefined);
    throw error;
  }

  const task = await createIngestTask({
    type: "KDM",
    hallId: asset.targetHall.hallId,
    hallName: asset.targetHall.hallName,
    assetId: asset.messageId || asset.id,
    assetTitle: asset.contentTitleText || asset.annotationText || asset.fileName,
    ingestUuid: importResult.ingestUuid,
    source,
    path,
    metadata: {
      fileName: asset.fileName,
      relativePath: asset.relativePath,
      compositionPlaylistId: asset.compositionPlaylistId,
      targetDeviceCode: asset.targetDeviceCode,
    },
  });
  await getActivityService().create({
    actorType: "user",
    actorId: String(session.userId),
    actorName: session.username,
    action: "kdm.ingest.create",
    objectType: "kdm",
    objectId: asset.messageId || asset.id,
    objectName: asset.contentTitleText || asset.annotationText || asset.fileName,
    hallId: asset.targetHall.hallId,
    status: "success",
    resultMessage: "已创建 KDM 摄取任务。",
    durationMs: Date.now() - startedAt,
    payload: buildKdmActivityPayload(asset, task ?? undefined, {
      ingestUuid: importResult.ingestUuid,
      source,
      path,
      mode,
    }),
  }).catch(() => undefined);

  return {
    assetId: asset.id,
    hall: asset.targetHall,
    ingestUuid: importResult.ingestUuid,
    source,
    task,
  };
}

function readZyhxListOptions(searchParams: URLSearchParams): ZyhxKdmListOptions {
  return {
    page: readPositiveInteger(searchParams.get("page"), 1),
    pagesize: readPositiveInteger(searchParams.get("pagesize"), 100),
    keyword: searchParams.get("keyword")?.trim() || undefined,
    downloaded: readOptionalInteger(searchParams.get("downloaded")),
    pid: searchParams.get("pid")?.trim() || undefined,
    category: readOptionalInteger(searchParams.get("category")),
    term: readOptionalInteger(searchParams.get("term")),
  };
}

async function enrichZyhxKdmListResult(result: unknown): Promise<unknown> {
  if (!isPlainRecord(result) || !Array.isArray(result.data)) {
    return result;
  }

  const [assets, halls] = await Promise.all([
    listKdmAssets(),
    readConfiguredHalls().catch(() => []),
  ]);
  const hallBySerial = new Map<string, { hallId: string; hallName: string }>();
  for (const hall of halls) {
    const serial = hall.gdcDeviceInfo?.serial?.trim();
    if (serial) {
      hallBySerial.set(serial, { hallId: hall.id, hallName: hall.name });
    }
  }
  const deviceKdmUuidsByHallId = await readZyhxDeviceKdmUuidsByHall(result.data, hallBySerial);

  return {
    ...result,
    data: result.data.map((item) => enrichZyhxKdmItem(item, assets, hallBySerial, deviceKdmUuidsByHallId)),
  };
}

function enrichZyhxKdmItem(
  item: unknown,
  assets: readonly KdmAssetRecord[],
  hallBySerial: ReadonlyMap<string, { hallId: string; hallName: string }>,
  deviceKdmUuidsByHallId: ReadonlyMap<string, ZyhxDeviceKdmStatus>,
): unknown {
  if (!isPlainRecord(item)) {
    return item;
  }

  const worksheet = Array.isArray(item.worksheet) ? item.worksheet : [];
  const enrichedWorksheet = worksheet.map((entry) => enrichZyhxWorksheetEntry(entry, assets, hallBySerial, deviceKdmUuidsByHallId));
  const requiredCount = Number.isInteger(Number(item.kdmcount)) && Number(item.kdmcount) > 0
    ? Number(item.kdmcount)
    : enrichedWorksheet.length;
  const presentCount = enrichedWorksheet.filter((entry) => isPlainRecord(entry) && entry.localPresent === true).length;

  return {
    ...item,
    worksheet: enrichedWorksheet,
    localStatus: {
      requiredCount,
      presentCount,
      missingCount: Math.max(0, requiredCount - presentCount),
      complete: requiredCount > 0 && presentCount >= requiredCount,
    },
  };
}

function enrichZyhxWorksheetEntry(
  entry: unknown,
  assets: readonly KdmAssetRecord[],
  hallBySerial: ReadonlyMap<string, { hallId: string; hallName: string }>,
  deviceKdmUuidsByHallId: ReadonlyMap<string, ZyhxDeviceKdmStatus>,
): unknown {
  if (!isPlainRecord(entry)) {
    return entry;
  }

  const sn = readStringValue(entry.sn);
  const cpl = readStringValue(entry.cpl);
  const nvb = readStringValue(entry.nvb);
  const nva = readStringValue(entry.nva);
  const hall = sn ? hallBySerial.get(sn) : undefined;
  const asset = assets.find((candidate) => isZyhxWorksheetAssetMatch(candidate, { sn, cpl, nvb, nva }));
  const deviceStatus = resolveZyhxDeviceKdmStatus(asset, hall?.hallId, deviceKdmUuidsByHallId);

  return {
    ...entry,
    hallId: hall?.hallId,
    hallName: hall?.hallName,
    localPresent: Boolean(asset),
    localAssetId: asset?.id,
    localFileName: asset?.fileName,
    deviceKdmStatus: deviceStatus.status,
    deviceKdmMessage: deviceStatus.message,
  };
}

interface ZyhxDeviceKdmStatus {
  readonly online: boolean;
  readonly uuids?: ReadonlySet<string>;
  readonly error?: string;
}

async function readZyhxDeviceKdmUuidsByHall(
  items: readonly unknown[],
  hallBySerial: ReadonlyMap<string, { hallId: string; hallName: string }>,
): Promise<Map<string, ZyhxDeviceKdmStatus>> {
  const runtimeService = getRuntimeService();
  const onlineHallIds = new Set(
    runtimeService
      .listRuntimeRecords()
      .filter((runtime) => runtime.snapshot.connectivity?.state === "online")
      .map((runtime) => runtime.registration.hallId),
  );
  const hallIds = new Set<string>();

  for (const item of items) {
    if (!isPlainRecord(item) || !Array.isArray(item.worksheet)) {
      continue;
    }
    for (const entry of item.worksheet) {
      if (!isPlainRecord(entry)) {
        continue;
      }
      const sn = readStringValue(entry.sn);
      const hallId = sn ? hallBySerial.get(sn)?.hallId : undefined;
      if (hallId) {
        hallIds.add(hallId);
      }
    }
  }

  const result = new Map<string, ZyhxDeviceKdmStatus>();
  await Promise.all([...hallIds].map(async (hallId) => {
    if (!onlineHallIds.has(hallId)) {
      result.set(hallId, { online: false });
      return;
    }

    try {
      const uuids = await runtimeService.listKdmAssetUuids(hallId);
      result.set(hallId, {
        online: true,
        uuids: new Set(uuids.map(normalizeUuid)),
      });
    } catch (error) {
      result.set(hallId, {
        online: true,
        error: error instanceof Error ? error.message : "读取影厅 KDM 列表失败。",
      });
    }
  }));

  return result;
}

function resolveZyhxDeviceKdmStatus(
  asset: KdmAssetRecord | undefined,
  hallId: string | undefined,
  deviceKdmUuidsByHallId: ReadonlyMap<string, ZyhxDeviceKdmStatus>,
): { status: "present" | "absent" | "offline" | "unknown" | "local-missing"; message: string } {
  if (!hallId) {
    return { status: "unknown", message: "未匹配到影厅配置。" };
  }

  const deviceStatus = deviceKdmUuidsByHallId.get(hallId);
  if (!deviceStatus?.online) {
    return { status: "offline", message: "影厅离线，无法确认。" };
  }

  if (deviceStatus.error || !deviceStatus.uuids) {
    return { status: "unknown", message: deviceStatus.error || "无法读取影厅 KDM 列表。" };
  }

  if (!asset) {
    return { status: "local-missing", message: "本地缺少该 KDM，无法确认设备内 UUID。" };
  }

  return deviceStatus.uuids.has(normalizeUuid(asset.messageId || asset.id))
    ? { status: "present", message: "影厅内已存在。" }
    : { status: "absent", message: "影厅内未找到。" };
}

function isZyhxWorksheetAssetMatch(
  asset: KdmAssetRecord,
  entry: { readonly sn: string; readonly cpl: string; readonly nvb: string; readonly nva: string },
): boolean {
  if (entry.sn && asset.targetDeviceCode !== entry.sn) {
    return false;
  }

  if (entry.cpl) {
    const assetTitle = normalizeZyhxText(asset.contentTitleText || asset.annotationText || "");
    if (!assetTitle.includes(normalizeZyhxText(entry.cpl))) {
      return false;
    }
  }

  return normalizeZyhxDate(asset.validBefore) === normalizeZyhxDate(entry.nvb)
    && normalizeZyhxDate(asset.validAfter) === normalizeZyhxDate(entry.nva);
}

function normalizeZyhxText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function normalizeZyhxDate(value: string | undefined): string {
  const match = String(value || "").replace("T", " ").match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : String(value || "").trim();
}

function readStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readPositiveInteger(value: string | null, fallback: number): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function readOptionalInteger(value: string | null): number | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : undefined;
}

async function buildHallKdmPayload(hallId: string): Promise<{
  hall: {
    hallId: string;
    hallName: string;
    online: boolean;
    host: string;
    port: number;
  };
  deviceKdms: Awaited<ReturnType<ReturnType<typeof getRuntimeService>["listKdmDetails"]>>;
  deviceReadError?: string;
  repositoryAssets: KdmAssetRecord[];
  tasks: IngestTaskRecord[];
}> {
  const runtimeService = getRuntimeService();
  const runtime = runtimeService.getRuntimeRecord(hallId);
  if (!runtime) {
    throw new ApiError(404, "未找到目标影厅。");
  }

  const online = runtime.snapshot.connectivity?.state === "online";
  let deviceKdms: Awaited<ReturnType<ReturnType<typeof getRuntimeService>["listKdmDetails"]>> = [];
  let deviceReadError: string | undefined;
  if (online) {
    try {
      deviceKdms = await runtimeService.listKdmDetails(hallId);
    } catch (error) {
      deviceReadError = error instanceof Error ? error.message : "读取设备内 KDM 失败。";
    }
  }

  const assets = await listAssetsWithRuntimeStatus();
  const tasks = (await refreshKdmIngestTasks()).filter((task) => task.hallId === hallId);

  return {
    hall: {
      hallId: runtime.registration.hallId,
      hallName: runtime.registration.hallName || runtime.registration.hallId,
      online,
      host: runtime.registration.host,
      port: runtime.registration.port,
    },
    deviceKdms,
    deviceReadError,
    repositoryAssets: assets.filter((asset) => asset.targetHall?.hallId === hallId),
    tasks,
  };
}

async function importHallKdmAssets(
  hallId: string,
  ids: readonly string[],
  session: Awaited<ReturnType<typeof requireSession>>,
  mode: "hall-repository" | "hall-upload",
): Promise<{
  imported: Array<{
    assetId: string;
    hall: KdmAssetRecord["targetHall"];
    ingestUuid: string;
    task: IngestTaskRecord | null;
    reused?: boolean;
  }>;
  failed: Array<{ id: string; error: string }>;
}> {
  const uniqueIds = [...new Set(ids)];
  const assets = await listAssetsWithRuntimeStatus();
  const assetsById = new Map<string, KdmAssetRecord>();
  for (const asset of assets) {
    assetsById.set(asset.id, asset);
    if (asset.messageId) {
      assetsById.set(asset.messageId, asset);
    }
  }

  const imported: Array<{
    assetId: string;
    hall: KdmAssetRecord["targetHall"];
    ingestUuid: string;
    task: IngestTaskRecord | null;
    reused?: boolean;
  }> = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of uniqueIds) {
    const asset = assetsById.get(id);
    if (!asset) {
      failed.push({ id, error: "未找到指定的 KDM 文件。" });
      continue;
    }

    if (asset.targetHall?.hallId !== hallId) {
      failed.push({ id, error: "该 KDM 的目标设备不是当前影厅。" });
      continue;
    }

    try {
      imported.push(await importKdmAsset(asset, session, mode));
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : "KDM 导入任务创建失败。" });
    }
  }

  await getActivityService().create({
    id: `activity-kdm.${mode}-${Date.now()}`,
    actorType: "user",
    actorId: String(session.userId),
    actorName: session.username,
    action: `kdm.${mode}`,
    objectType: "kdm",
    objectId: uniqueIds.join(","),
    objectName: `影厅导入 ${imported.length} 个 KDM`,
    hallId,
    status: failed.length === 0 ? "success" : imported.length > 0 ? "success" : "error",
    resultMessage: `成功 ${imported.length}，失败 ${failed.length}`,
    payload: {
      imported: imported.map((item) => ({
        assetId: item.assetId,
        ingestUuid: item.ingestUuid,
        reused: item.reused === true,
      })),
      failed,
    },
  }).catch(() => undefined);

  return { imported, failed };
}

async function refreshKdmIngestTasks(): Promise<IngestTaskRecord[]> {
  const tasks = await listIngestTasks({ type: "KDM", limit: 100 });
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
      const updated = await resolveMissingKdmIngestTask(task, status);
      await publishTaskTerminalActivity(task, updated ?? task);
      return updated;
    }
    const verifiedComplete = await isKdmPresentAfterStatus(task, status.status);
    const updated = await updateIngestTaskFromStatus(task, status, {
      verifiedComplete,
      requireVerifiedComplete: task.type === "KDM",
    });
    await publishTaskTerminalActivity(task, updated ?? task);
    return updated;
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

async function resolveMissingKdmIngestTask(
  task: IngestTaskRecord,
  status: Awaited<ReturnType<ReturnType<typeof getRuntimeService>["getIngestStatus"]>>,
): Promise<IngestTaskRecord | null> {
  let ingestUuids: string[] = [];
  try {
    ingestUuids = await getRuntimeService().listIngestUuids(task.hallId);
  } catch {
    return updateIngestTaskFromStatus(task, status, { requireVerifiedComplete: true });
  }

  const stillListed = ingestUuids.some((uuid) => normalizeUuid(uuid) === normalizeUuid(task.ingestUuid));
  if (stillListed) {
    return updateIngestTaskFromStatus(task, status, { requireVerifiedComplete: true });
  }

  try {
    const uuids = await getRuntimeService().listKdmAssetUuids(task.hallId);
    if (new Set(uuids.map(normalizeUuid)).has(normalizeUuid(task.assetId))) {
      return updateIngestTaskStatus(task, "complete", {
        remoteStatus: status.status || "Unknown",
        description: "GDC 已移除摄取任务，设备内已存在对应 KDM。",
        transferredSize: status.transferredSize,
        totalSize: status.totalSize,
      });
    }
  } catch {
    // Fall through to removed so the task no longer blocks a retry.
  }

  return updateIngestTaskStatus(task, "removed", {
    remoteStatus: status.status || "Unknown",
    description: "GDC 已移除或找不到该摄取任务。",
    transferredSize: status.transferredSize,
    totalSize: status.totalSize,
  });
}

async function cancelKdmIngestTask(
  taskId: string,
  session: Awaited<ReturnType<typeof requireSession>>,
): Promise<IngestTaskRecord> {
  const task = await readIngestTaskById(taskId);
  if (!task || task.type !== "KDM") {
    throw new ApiError(404, "未找到指定的 KDM 导入任务。");
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
    action: "kdm.ingest.cancel",
    objectType: "kdm",
    objectId: task.assetId,
    objectName: task.assetTitle,
    hallId: task.hallId,
    status: "success",
    resultMessage: "已取消 KDM 摄取任务。",
    payload: {
      taskId: task.id,
      ingestUuid: task.ingestUuid,
      remoteStatus: updated?.remoteStatus,
      ...task.metadata,
    },
  }).catch(() => undefined);

  return updated ?? task;
}

async function isKdmPresentAfterStatus(task: IngestTaskRecord, remoteStatus: string | undefined): Promise<boolean> {
  if (task.type !== "KDM") {
    return false;
  }

  const normalizedRemoteStatus = (remoteStatus || "").trim().toLowerCase();
  if (normalizedRemoteStatus !== "complete" && normalizedRemoteStatus !== "completed") {
    return false;
  }

  try {
    const uuids = await getRuntimeService().listKdmAssetUuids(task.hallId);
    return new Set(uuids.map(normalizeUuid)).has(normalizeUuid(task.assetId));
  } catch {
    return false;
  }
}

async function listAssetsWithRuntimeStatus() {
  const runtimeService = getRuntimeService();
  const onlineHallIds = new Set(
    runtimeService
      .listRuntimeRecords()
      .filter((runtime) => runtime.snapshot.connectivity?.state === "online")
      .map((runtime) => runtime.registration.hallId),
  );
  const assets = await listKdmAssets({ onlineHallIds });
  const kdmUuidsByHallId = await readKdmUuidsByOnlineHall(assets);

  return assets.map((asset) => {
    if (!asset.targetHall?.online) {
      return asset;
    }

    const existingUuids = kdmUuidsByHallId.get(asset.targetHall.hallId);
    return {
      ...asset,
      targetHall: {
        ...asset.targetHall,
        existingKdmStatus: existingUuids
          ? existingUuids.has(normalizeUuid(asset.messageId || asset.id))
            ? "present" as const
            : "absent" as const
          : "unknown" as const,
      },
    };
  });
}

async function readKdmUuidsByOnlineHall(assets: readonly KdmAssetRecord[]): Promise<Map<string, Set<string>>> {
  const runtimeService = getRuntimeService();
  const hallIds = [...new Set(
    assets
      .map((asset) => asset.targetHall?.online ? asset.targetHall.hallId : undefined)
      .filter((hallId): hallId is string => Boolean(hallId)),
  )];
  const result = new Map<string, Set<string>>();

  await Promise.all(
    hallIds.map(async (hallId) => {
      try {
        const uuids = await runtimeService.listKdmAssetUuids(hallId);
        result.set(hallId, new Set(uuids.map(normalizeUuid)));
      } catch {
        // Unknown is safer than claiming the KDM is absent when the device cannot answer.
      }
    }),
  );

  return result;
}

async function readExistingKdmStatus(asset: KdmAssetRecord): Promise<"present" | "absent" | "unknown"> {
  if (!asset.targetHall?.online) {
    return "unknown";
  }

  try {
    const uuids = await getRuntimeService().listKdmAssetUuids(asset.targetHall.hallId);
    const existingUuids = new Set(uuids.map(normalizeUuid));
    return existingUuids.has(normalizeUuid(asset.messageId || asset.id)) ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

function normalizeUuid(value: string): string {
  return value.trim().toLowerCase().replace(/^urn:uuid:/, "");
}

function formatErrorSuffix(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message ? `（${message}）` : "";
}

function isExpired(value: string | undefined): boolean {
  const time = Date.parse(value || "");
  return Number.isFinite(time) && time < Date.now();
}

async function publishTaskTerminalActivity(previous: IngestTaskRecord, current: IngestTaskRecord): Promise<void> {
  if (previous.status === current.status || !isTerminalIngestTaskStatus(current.status)) {
    return;
  }

  const action = current.status === "complete"
    ? "kdm.ingest.complete"
    : current.status === "cancelled"
      ? "kdm.ingest.cancelled"
      : current.status === "removed"
        ? "kdm.ingest.removed"
        : "kdm.ingest.fail";
  await getActivityService().create({
    id: `activity-${action}-${current.ingestUuid}`,
    actorType: "system",
    action,
    objectType: "kdm",
    objectId: current.assetId,
    objectName: current.assetTitle,
    hallId: current.hallId,
    status: current.status === "complete" || current.status === "cancelled" || current.status === "removed"
      ? "success"
      : "error",
    resultMessage: current.description,
    payload: {
      taskId: current.id,
      ingestUuid: current.ingestUuid,
      remoteStatus: current.remoteStatus,
      transferredSize: current.transferredSize,
      totalSize: current.totalSize,
      errorList: current.errorList,
      warningList: current.warningList,
      ...current.metadata,
    },
  }).catch(() => undefined);
}

function buildKdmActivityPayload(
  asset: KdmAssetRecord,
  task?: IngestTaskRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assetId: asset.id,
    messageId: asset.messageId,
    fileName: asset.fileName,
    relativePath: asset.relativePath,
    targetDeviceCode: asset.targetDeviceCode,
    compositionPlaylistId: asset.compositionPlaylistId,
    ingestUuid: task?.ingestUuid,
    taskId: task?.id,
    taskStatus: task?.status,
    ...extra,
  };
}

function normalizeUploadFiles(value: unknown): KdmUploadInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const content = typeof record.content === "string" ? record.content : "";
    const encoding = record.encoding === "base64" ? "base64" : "text";
    return name && content ? [{ name, content, encoding }] : [];
  });
}

function encodeFtpPath(relativePath: string): string {
  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
