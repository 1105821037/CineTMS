import type { IncomingMessage, ServerResponse } from "node:http";
import { platform } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { getRepositoryFtpService } from "./ftp-service";
import { readJsonBody, readRequiredString, sendJson } from "./http";
import { getActivityService } from "./activity-service";
import { getRuntimeService } from "./runtime-service";
import { readRepositoryCapacity } from "./repository-capacity";
import { requireSession } from "./session";
import { clearTicketingFinixxClient } from "./finixx-client-service";
import { resolveFinixxConfig, sanitizeFinixxConfig } from "./finixx-config";
import { normalizeHallConfigList } from "./setup-api";
import {
  deleteSingleHall,
  getDefaultRepositoryPath,
  readAutomationDangerousCommandFilterEnabled,
  readConfiguredHalls,
  readFilmSchedulerRecoverySettings,
  readFinixxConfig,
  readRepositoryConfig,
  readZyhxKdmAccountConfig,
  saveAutomationDangerousCommandFilterEnabled,
  saveConfiguredHalls,
  saveFilmSchedulerRecoverySettings,
  saveFinixxConfig,
  saveRepositoryConfig,
  saveZyhxKdmAccountConfig,
  upsertSingleHall,
} from "./setup-store";

const windowsRootPath = "__windows_drives__";

export async function handleSystemApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/system/")) {
    return false;
  }

  const session = await requireSession(request);
  const activityService = getActivityService();
  const ftpService = getRepositoryFtpService();

  if (request.method === "GET" && pathname === "/api/system/version") {
    sendJson(response, 200, {
      ok: true,
      version: await readSystemVersion(),
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/system/directories") {
    const searchParams = new URL(request.url ?? "/", "http://localhost").searchParams;
    const requestedPath = searchParams.get("path")?.trim() || "";
    const payload = await listServerDirectory(requestedPath);
    sendJson(response, 200, { ok: true, ...payload });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/system/directories") {
    const body = await readJsonBody(request);
    const parentPath = readRequiredString(body, "parentPath");
    const folderName = readRequiredString(body, "name");
    const createdPath = await createServerDirectory(parentPath, folderName);
    const payload = await listServerDirectory(createdPath);
    sendJson(response, 200, { ok: true, createdPath, ...payload });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/system/settings") {
    const [repository, hideDangerousCommands, schedulerRecovery, repositoryCapacity, zyhxKdmAccount] = await Promise.all([
      readRepositoryConfig(),
      readAutomationDangerousCommandFilterEnabled(),
      readFilmSchedulerRecoverySettings(),
      readRepositoryCapacity(),
      readZyhxKdmAccountConfig(),
    ]);
    sendJson(response, 200, {
      ok: true,
      repositoryPath: repository.path,
      projectorAccessHost: repository.projectorAccessHost || "",
      repositoryCapacity,
      ftp: ftpService.getStatus(),
      automation: {
        hideDangerousCommands,
      },
      filmScheduler: {
        recovery: schedulerRecovery,
      },
      zyhxKdm: {
        username: zyhxKdmAccount?.username || "",
        hasPassword: Boolean(zyhxKdmAccount?.password),
      },
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/system/settings") {
    const body = await readJsonBody(request);
    const hasRepositoryPath = typeof body.repositoryPath === "string" && body.repositoryPath.trim().length > 0;
    const hasProjectorAccessHost = typeof body.projectorAccessHost === "string";
    const hasDangerousFilter = typeof body.hideDangerousAutomationCommands === "boolean";
    const hasAutoCorrectShowUuid = typeof body.autoCorrectShowUuid === "boolean";
    const hasAllowTemporaryShow = typeof body.allowTemporaryShow === "boolean";
    const hasZyhxKdmAccount = typeof body.zyhxKdmUsername === "string" || typeof body.zyhxKdmPassword === "string";

    if (
      !hasRepositoryPath
      && !hasProjectorAccessHost
      && !hasDangerousFilter
      && !hasAutoCorrectShowUuid
      && !hasAllowTemporaryShow
      && !hasZyhxKdmAccount
    ) {
      sendJson(response, 400, { ok: false, error: "至少需要提供一项系统设置。" });
      return true;
    }

    let repository = await readRepositoryConfig();
    const settingsResult = await activityService.capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "system.settings.update",
      objectType: "system-settings",
      payload: sanitizeActivityPayload(body),
    }, async () => {
      if (hasRepositoryPath || hasProjectorAccessHost) {
        repository = await saveRepositoryConfig({
          path: hasRepositoryPath ? readRequiredString(body, "repositoryPath") : repository.path,
          projectorAccessHost: hasProjectorAccessHost
            ? String(body.projectorAccessHost ?? "")
            : repository.projectorAccessHost,
        });
      }

      if (hasDangerousFilter) {
        await saveAutomationDangerousCommandFilterEnabled(Boolean(body.hideDangerousAutomationCommands));
      }

      if (hasAutoCorrectShowUuid || hasAllowTemporaryShow) {
        await saveFilmSchedulerRecoverySettings({
          autoCorrectShowUuid: hasAutoCorrectShowUuid ? Boolean(body.autoCorrectShowUuid) : undefined,
          allowTemporaryShow: hasAllowTemporaryShow ? Boolean(body.allowTemporaryShow) : undefined,
        });
      }

      if (hasZyhxKdmAccount) {
        await saveZyhxKdmAccountConfig({
          username: typeof body.zyhxKdmUsername === "string" ? body.zyhxKdmUsername : undefined,
          password: typeof body.zyhxKdmPassword === "string" ? body.zyhxKdmPassword : undefined,
        });
      }

      const [hideDangerousCommands, schedulerRecovery, zyhxKdmAccount] = await Promise.all([
        readAutomationDangerousCommandFilterEnabled(),
        readFilmSchedulerRecoverySettings(),
        readZyhxKdmAccountConfig(),
      ]);
      return { hideDangerousCommands, schedulerRecovery, zyhxKdmAccount };
    });

    if (hasRepositoryPath || hasProjectorAccessHost) {
      try {
        await ftpService.reconfigure(repository);
      } catch (error) {
        sendJson(response, 200, {
          ok: true,
          repositoryPath: repository.path,
          projectorAccessHost: repository.projectorAccessHost || "",
          repositoryCapacity: await readRepositoryCapacity(),
          ftp: ftpService.getStatus(),
          automation: {
            hideDangerousCommands: settingsResult.hideDangerousCommands,
          },
          filmScheduler: {
            recovery: settingsResult.schedulerRecovery,
          },
          zyhxKdm: {
            username: settingsResult.zyhxKdmAccount?.username || "",
            hasPassword: Boolean(settingsResult.zyhxKdmAccount?.password),
          },
          warning: error instanceof Error ? error.message : "FTP 服务重载失败。",
        });
        return true;
      }
    }

    sendJson(response, 200, {
      ok: true,
      repositoryPath: repository.path,
      projectorAccessHost: repository.projectorAccessHost || "",
      repositoryCapacity: await readRepositoryCapacity(),
      ftp: ftpService.getStatus(),
      automation: {
        hideDangerousCommands: settingsResult.hideDangerousCommands,
      },
      filmScheduler: {
        recovery: settingsResult.schedulerRecovery,
      },
      zyhxKdm: {
        username: settingsResult.zyhxKdmAccount?.username || "",
        hasPassword: Boolean(settingsResult.zyhxKdmAccount?.password),
      },
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/system/ticketing") {
    const finixx = await readFinixxConfig();
    sendJson(response, 200, { ok: true, finixx: sanitizeFinixxConfig(finixx) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/system/ticketing") {
    const body = await readJsonBody(request);
    const config = resolveFinixxConfig(body, await readFinixxConfig());
    await activityService.capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "system.ticketing.update",
      objectType: "ticketing",
      payload: {
        baseUrl: config.baseUrl,
        serviceUsername: config.serviceUsername,
        hasPassword: true,
        hasApiKey: true,
      },
    }, async () => {
      await saveFinixxConfig(config);
      clearTicketingFinixxClient();
    });
    sendJson(response, 200, { ok: true, finixx: sanitizeFinixxConfig(config) });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/system/halls") {
    const halls = await readConfiguredHalls();
    sendJson(response, 200, { ok: true, halls });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/system/halls") {
    const body = await readJsonBody(request);
    const halls = normalizeHallConfigList(body.halls);
    await activityService.capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "system.halls.replace",
      objectType: "hall",
      payload: { count: halls.length },
    }, async () => {
      await saveConfiguredHalls(halls);
      await getRuntimeService().reloadConfiguredHalls().catch(() => undefined);
    });
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/system/halls/save") {
    const body = await readJsonBody(request);
    const halls = normalizeHallConfigList([body]);
    if (halls.length !== 1) {
      sendJson(response, 400, { ok: false, error: "Invalid hall data" });
      return true;
    }
    await activityService.capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "system.hall.save",
      objectType: "hall",
      objectId: halls[0].id,
      objectName: halls[0].name,
      hallId: halls[0].id,
      payload: {
        finixxHallId: halls[0].finixxHallId,
        host: halls[0].host,
        port: halls[0].port,
      },
    }, async () => {
      await upsertSingleHall(halls[0]);
      await getRuntimeService().reloadConfiguredHalls().catch(() => undefined);
    });
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/system/halls/delete") {
    const body = await readJsonBody(request);
    const finixxHallId = readRequiredString(body, "finixxHallId");
    await activityService.capture({
      actorType: "user",
      actorId: String(session.userId),
      actorName: session.username,
      action: "system.hall.delete",
      objectType: "hall",
      objectId: finixxHallId,
      payload: { finixxHallId },
    }, async () => {
      await deleteSingleHall(finixxHallId);
      await getRuntimeService().reloadConfiguredHalls().catch(() => undefined);
    });
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

async function readSystemVersion(): Promise<{
  readonly name: string;
  readonly version: string;
  readonly channel: string;
  readonly commit?: string;
  readonly buildTime?: string;
}> {
  const packageJson = await readPackageJson().catch(() => ({} as Record<string, unknown>));
  const buildInfo = await readBuildInfo().catch(() => ({} as Record<string, unknown>));
  return {
    name: typeof packageJson.name === "string" ? packageJson.name : "tms",
    version: typeof packageJson.version === "string" ? packageJson.version : "0.0.0",
    channel: readOptionalString(buildInfo.channel) || "dev",
    commit: readOptionalString(buildInfo.commit),
    buildTime: readOptionalString(buildInfo.buildTime),
  };
}

async function readBuildInfo(): Promise<Record<string, unknown>> {
  const raw = await readFile(resolve(process.cwd(), "build-info.json"), "utf8");
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

async function readPackageJson(): Promise<Record<string, unknown>> {
  const raw = await readFile(resolve(process.cwd(), "package.json"), "utf8");
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim() || undefined
    : undefined;
}

interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "directory" | "drive";
}

interface DirectoryListing {
  readonly path: string;
  readonly displayPath: string;
  readonly rootPath: string;
  readonly parentPath: string | null;
  readonly selectable: boolean;
  readonly entries: readonly DirectoryEntry[];
}

async function listServerDirectory(requestedPath: string): Promise<DirectoryListing> {
  if (isWindowsRootPath(requestedPath)) {
    return listWindowsDriveRootDirectory();
  }

  const currentPath = normalizePath(requestedPath) || await readInitialRepositoryPath();

  const info = await stat(currentPath).catch(() => null);
  if (!info?.isDirectory()) {
    return {
      path: currentPath,
      displayPath: currentPath,
      rootPath: getDirectoryRootPath(currentPath),
      parentPath: null,
      selectable: false,
      entries: [],
    };
  }

  const dirents = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
  const entries = dirents
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(currentPath, entry.name),
      type: "directory" as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));

  return {
    path: currentPath,
    displayPath: currentPath,
    rootPath: getDirectoryRootPath(currentPath),
    parentPath: getParentDirectory(currentPath),
    selectable: isSelectableRepositoryPath(currentPath),
    entries,
  };
}

async function listWindowsDriveRootDirectory(): Promise<DirectoryListing> {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const roots = await Promise.all(letters.map(async (letter): Promise<DirectoryEntry | null> => {
    const drivePath = `${letter}:\\`;
    const info = await stat(drivePath).catch(() => null);
    if (!info?.isDirectory()) {
      return null;
    }
    return { name: `${letter}:`, path: drivePath, type: "drive" };
  }));

  return {
    path: windowsRootPath,
    displayPath: "此电脑",
    rootPath: windowsRootPath,
    parentPath: null,
    selectable: false,
    entries: roots.filter((entry): entry is DirectoryEntry => entry !== null),
  };
}

async function readInitialRepositoryPath(): Promise<string> {
  const repository = await readRepositoryConfig().catch(() => ({ path: getDefaultRepositoryPath() }));
  return normalizePath(repository.path) || getDefaultRepositoryPath();
}

async function createServerDirectory(parentPath: string, folderName: string): Promise<string> {
  if (isWindowsRootPath(parentPath)) {
    throw new Error("请先进入某个盘符后再新建文件夹。");
  }

  const parent = normalizePath(parentPath);
  if (!parent) {
    throw new Error("请选择一个父目录。");
  }

  const safeName = normalizeFolderName(folderName);
  const parentInfo = await stat(parent).catch(() => null);
  if (!parentInfo?.isDirectory()) {
    throw new Error("父目录不存在或不可访问。");
  }

  const targetPath = normalize(join(parent, safeName));
  await mkdir(targetPath);
  return targetPath;
}

function normalizeFolderName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new Error("请输入文件夹名称。");
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || parse(name).root) {
    throw new Error("文件夹名称不能包含路径分隔符。");
  }
  return name;
}

function normalizePath(value: string | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return normalize(isAbsolute(raw) ? raw : resolve(raw));
}

function isWindowsRootPath(value: string | undefined): boolean {
  return platform() === "win32" && String(value || "").trim() === windowsRootPath;
}

function getDirectoryRootPath(path: string): string {
  if (platform() === "win32") {
    return windowsRootPath;
  }
  return parse(path).root || path;
}

function isSelectableRepositoryPath(path: string): boolean {
  const root = parse(normalize(path)).root;
  return Boolean(path && normalize(path) !== root);
}

function getParentDirectory(path: string): string | null {
  const normalized = normalize(path);
  const root = parse(normalized).root;
  if (normalized === root) {
    if (platform() === "win32") {
      return windowsRootPath;
    }
    return null;
  }
  return dirname(normalized);
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
