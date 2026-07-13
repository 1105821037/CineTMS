import type { IncomingMessage, ServerResponse } from "node:http";
import { FinixxApiError, FinixxClient } from "../modules/finixx";
import { GdcConnection, GdcSdk } from "../modules/gdc";
import {
  adoptExistingTmsDatabase,
  hasSystemAccount,
  normalizeDatabaseConfig,
  readLocalDatabaseConfig,
  readSetupCompleted,
  readSetupDraft,
  readFinixxConfig,
  saveSetupConfig,
  saveSetupDraft,
  saveSystemAccount,
  sanitizeDatabaseConfig,
  testDatabaseConnection,
  type HallConfig,
} from "./setup-store";
import {
  ApiError,
  asRecord,
  asRecordOrNull,
  readJsonBody,
  readOptionalString,
  readRequiredString,
  sendJson,
} from "./http";
import { clearTicketingFinixxClient } from "./finixx-client-service";
import { resolveFinixxConfig } from "./finixx-config";
import { getRuntimeService } from "./runtime-service";
import { requireSession, setSessionCookie } from "./session";

export async function handleSetupApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/setup/status") {
    const hasLocalDatabase = await readLocalDatabaseConfig();
    let completed = false;
    let draft = null;
    let hasAccount = false;

    if (hasLocalDatabase) {
      try {
        hasAccount = await hasSystemAccount();
        completed = await readSetupCompleted() && hasAccount;
        draft = await readSetupDraft();
        if (!hasAccount && draft) {
          draft = {
            ...draft,
            step: Math.max(1, Number(draft.step) || 0),
            tests: [true, false, false],
          };
        }
      } catch (error) {
        console.error("Failed to read setup status:", error);
        throw new ApiError(503, "系统初始化状态读取失败，请稍后重试。");
      }
    }

    sendJson(response, 200, {
      ok: true,
      hasDatabaseConfig: Boolean(hasLocalDatabase),
      completed,
      hasAccount,
      draft,
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/setup/database/test") {
    await assertSetupAccess(request, "database");
    const database = normalizeDatabaseConfig(await readJsonBody(request));
    const result = await testDatabaseConnection(database);
    if (result.status === "tms-existing") {
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    await saveSetupDraft(database, {
      step: 1,
      tests: [true, false, false],
      databaseExisted: result.databaseExisted,
      database: sanitizeDatabaseConfig(database),
    });
    sendJson(response, 200, { ok: true, ...result });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/setup/database/adopt") {
    await assertSetupAccess(request, "database");
    const body = await readJsonBody(request);
    const database = normalizeDatabaseConfig(body);
    const username = readRequiredString(body, "adminUsername");
    const password = readRequiredString(body, "adminPassword");
    const session = await adoptExistingTmsDatabase(database, username, password);
    setSessionCookie(response, session.token);
    sendJson(response, 200, {
      ok: true,
      user: { id: session.userId, username: session.username },
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/setup/account") {
    await assertSetupAccess(request, "account");
    const database = await readLocalDatabaseConfig();
    if (!database) {
      throw new Error("请先完成数据库连接测试。");
    }

    const body = await readJsonBody(request);
    const username = readRequiredString(body, "username");
    const session = await saveSystemAccount(database, username, readRequiredString(body, "password"));
    const draft = await readSetupDraft();
    await saveSetupDraft(database, {
      ...draft,
      step: 2,
      tests: [true, true, false],
      account: { username },
    });
    setSessionCookie(response, session.token);
    sendJson(response, 200, {
      ok: true,
      account: { username },
      user: { id: session.userId, username: session.username },
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/setup/finixx/test") {
    await assertSetupAccess(request, "authenticated");
    const body = await readJsonBody(request);
    const connectionConfig = resolveFinixxConfig(body, await readFinixxConfig());
    let client: FinixxClient;
    try {
      client = await FinixxClient.create({
        ...connectionConfig,
        deviceId: "setup-wizard",
        requestTimeoutMs: 8_000,
      });
    } catch (error) {
      if (error instanceof FinixxApiError && error.result === 1000) {
        throw new ApiError(400, "售票系统服务用户名或密码错误。");
      }
      throw error;
    }
    const settings = client.getSystemSettings();
    const halls = normalizeFinixxHalls(settings);
    const database = await readLocalDatabaseConfig();

    if (database) {
      const draft = await readSetupDraft();
      await saveSetupDraft(database, {
        ...draft,
        step: 2,
        tests: [true, true, true, false],
        finixx: {
          baseUrl: connectionConfig.baseUrl,
          cinemaInfo: normalizeFinixxCinemaInfo(settings),
        },
        halls,
        removedHalls: [],
      });
    }

    sendJson(response, 200, {
      ok: true,
      halls,
      hallsWarning: halls.length === 0
        ? "未从凤凰佳影售票系统获取到影厅列表，请检查售票系统配置中是否已维护影厅。"
        : undefined,
      cinemaInfo: normalizeFinixxCinemaInfo(settings),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/setup/gdc/test") {
    await assertSetupAccess(request, "authenticated");
    const body = await readJsonBody(request);
    const host = readRequiredString(body, "host");
    const port = Number(body.port ?? 5000);
    const connection = new GdcConnection({ host, port, connectTimeoutMs: 5_000, requestTimeoutMs: 5_000 });
    const sdk = new GdcSdk(connection);
    try {
      await sdk.heartbeat();
      const serverInfo = await sdk.getServerInfo();
      sendJson(response, 200, {
        ok: true,
        deviceInfo: {
          model: serverInfo.model,
          serial: serverInfo.serial,
          serverTime: serverInfo.serverTime,
          softwareVersion: serverInfo.version?.software,
          firmwareVersion: serverInfo.version?.firmware,
        },
      });
    } finally {
      await connection.disconnect().catch(() => undefined);
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/api/setup/draft") {
    await assertSetupAccess(request, "authenticated");
    const database = await readLocalDatabaseConfig();
    if (!database) {
      throw new Error("请先完成数据库连接测试。");
    }

    const body = await readJsonBody(request);
    await saveSetupDraft(database, {
      step: typeof body.step === "number" ? body.step : 0,
      tests: Array.isArray(body.tests) ? body.tests.map(Boolean) : undefined,
      databaseExisted: Boolean(body.databaseExisted),
      account: asRecordOrNull(body.account) as never,
    });
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/setup/complete") {
    await assertSetupAccess(request, "authenticated");
    const database = await readLocalDatabaseConfig();
    if (!database) {
      throw new Error("请先完成数据库连接测试。");
    }

    await saveSetupConfig(database, {
      completedBy: "setup-wizard",
    });
    clearTicketingFinixxClient();
    await getRuntimeService().reloadConfiguredHalls().catch(() => undefined);

    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

async function assertSetupAccess(
  request: IncomingMessage,
  mode: "database" | "account" | "authenticated",
): Promise<void> {
  const database = await readLocalDatabaseConfig();
  const accountExists = database ? await hasSystemAccount().catch(() => false) : false;

  if (mode === "database") {
    if (!accountExists) {
      return;
    }
    await requireSession(request);
    return;
  }

  if (mode === "account") {
    if (!database || !accountExists) {
      return;
    }
    await requireSession(request);
    return;
  }

  if (!database || !accountExists) {
    throw new ApiError(403, "请先完成数据库连接并创建系统账号。");
  }
  await requireSession(request);
}

function normalizeFinixxCinemaInfo(settings: Record<string, unknown>): Record<string, unknown> {
  const workStationInfo = asRecordOrNull(settings.workStationInfo);
  const allLocationInfo = asRecordOrNull(settings.allLocationInfo);
  const locationList = Array.isArray(allLocationInfo?.locationList) ? allLocationInfo.locationList : [];
  const localLocation = locationList
    .map((item) => asRecordOrNull(item))
    .find((item) => item?.localFlag === true)
    ?? locationList.map((item) => asRecordOrNull(item)).find(Boolean)
    ?? null;

  return {
    locationCode: readOptionalString(workStationInfo ?? {}, "LocationCd")
      ?? readOptionalString(localLocation ?? {}, "id")
      ?? readOptionalString(localLocation ?? {}, "locationCode")
      ?? "",
    locationName: readOptionalString(workStationInfo ?? {}, "LocationName")
      ?? readOptionalString(localLocation ?? {}, "name")
      ?? "",
    workstationId: readOptionalString(workStationInfo ?? {}, "WorkstationId") ?? "",
    workstationName: readOptionalString(workStationInfo ?? {}, "WorkstationDesc") ?? "",
  };
}

function normalizeFinixxHalls(settings: Record<string, unknown>): HallConfig[] {
  const hallsInfo = asRecordOrNull(settings.hallsInfo);
  if (!hallsInfo) {
    return [];
  }

  return normalizeRecordArray(hallsInfo.halls)
    .filter((hall) => readOptionalString(hall, "cinemaCd"))
    .map((hall, index) => {
      const id = readOptionalString(hall, "cinemaCd") ?? `HALL-${index + 1}`;
      return {
        id,
        finixxHallId: id,
        name: readOptionalString(hall, "cinemaName") ?? id,
        port: 5000,
        tested: false,
      };
    });
}

function normalizeRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecordOrNull(item);
    return record ? [record] : [];
  });
}

export function normalizeHallConfigList(value: unknown): HallConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected hall list");
  }

  return value.map((item, index) => {
    const record = asRecord(item);
    const gdcDeviceInfo = asRecordOrNull(record.gdcDeviceInfo);
    return {
      id: readOptionalString(record, "id") ?? `hall-${index + 1}`,
      name: readOptionalString(record, "name") ?? `影厅 ${index + 1}`,
      finixxHallId: readOptionalString(record, "finixxHallId")
        ?? readOptionalString(record, "id")
        ?? `hall-${index + 1}`,
      host: readOptionalString(record, "host"),
      port: readOptionalString(record, "port") ?? 5000,
      tested: Boolean(record.tested),
      gdcDeviceInfo: gdcDeviceInfo ? {
        model: readOptionalString(gdcDeviceInfo, "model"),
        serial: readOptionalString(gdcDeviceInfo, "serial"),
        serverTime: readOptionalString(gdcDeviceInfo, "serverTime"),
        softwareVersion: readOptionalString(gdcDeviceInfo, "softwareVersion"),
        firmwareVersion: readOptionalString(gdcDeviceInfo, "firmwareVersion"),
      } : undefined,
    };
  });
}
