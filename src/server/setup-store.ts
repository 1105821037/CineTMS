import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import mysql from "mysql2/promise";

type SqlExecutor = Pick<mysql.Connection, "execute"> | Pick<mysql.Pool, "execute">;

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
}

export interface FinixxConfig {
  readonly baseUrl: string;
  readonly serviceUsername?: string;
  readonly servicePassword?: string;
  readonly serviceApiKey?: string;
  readonly cinemaInfo?: unknown;
}

export type FinixxSetupDraft = Pick<FinixxConfig, "baseUrl" | "cinemaInfo">;

export interface HallConfig {
  /** Logical hall id used by TMS runtime and GDC-related flows. */
  readonly id: string;
  readonly name: string;
  /** Unique hall id from Finixx hallsInfo.cinemaCd. */
  readonly finixxHallId: string;
  readonly host?: string;
  readonly port?: string | number;
  readonly tested?: boolean;
  readonly gdcDeviceInfo?: {
    readonly model?: string;
    readonly serial?: string;
    readonly serverTime?: string;
    readonly softwareVersion?: string;
    readonly firmwareVersion?: string;
  };
}

export interface SetupConfig {
  readonly completedBy?: string;
}

export interface RepositoryConfig {
  readonly path: string;
  readonly projectorAccessHost?: string;
}

export interface ZyhxKdmAccountConfig {
  readonly username: string;
  readonly password?: string;
}

export interface AccountDraft {
  readonly username: string;
}

export interface DatabaseCheckResult {
  readonly databaseExisted: boolean;
  readonly status: DatabaseProbeStatus;
  readonly message?: string;
  readonly summary?: ExistingTmsDatabaseSummary;
}

export type DatabaseProbeStatus = "missing" | "empty" | "foreign-existing" | "tms-existing";

export interface ExistingTmsDatabaseSummary {
  readonly userCount: number;
  readonly completed: boolean;
  readonly identity?: unknown;
  readonly configKeys: readonly string[];
}

export interface SetupDraft {
  readonly step?: number;
  readonly tests?: readonly boolean[];
  readonly databaseExisted?: boolean;
  readonly database?: Omit<DatabaseConfig, "password"> & { readonly hasPassword?: boolean };
  readonly account?: AccountDraft;
  readonly finixx?: FinixxSetupDraft;
  readonly halls?: readonly HallConfig[];
  readonly removedHalls?: readonly HallConfig[];
}

export interface AuthSession {
  readonly token: string;
  readonly userId: number;
  readonly username: string;
  readonly expiresAt: Date;
}

const localConfigPath = join(process.cwd(), ".tms", "database.json");
const defaultRepositoryPath = join(process.cwd(), ".tms", "repository");
const systemIdentityConfigKey = "system.identity";
const systemIdentity = {
  app: "TMS",
  schemaVersion: 1,
};
let databasePoolPromise: Promise<mysql.Pool> | null = null;
let defaultSetupSchemaReadyPromise: Promise<void> | null = null;

export async function readLocalDatabaseConfig(): Promise<DatabaseConfig | null> {
  try {
    const raw = await readFile(localConfigPath, "utf8");
    return normalizeDatabaseConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function getDefaultRepositoryPath(): string {
  return defaultRepositoryPath;
}

export async function saveLocalDatabaseConfig(config: DatabaseConfig): Promise<void> {
  const previousPool = databasePoolPromise;
  databasePoolPromise = null;
  defaultSetupSchemaReadyPromise = null;
  await mkdir(dirname(localConfigPath), { recursive: true });
  await writeFile(localConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (previousPool) {
    void previousPool.then((pool) => pool.end()).catch(() => undefined);
  }
}

export function sanitizeDatabaseConfig(config: DatabaseConfig): SetupDraft["database"] {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    hasPassword: Boolean(config.password),
  };
}

export function normalizeDatabaseConfig(value: unknown): DatabaseConfig {
  const record = asRecord(value);
  const host = readRequiredString(record, "host");
  const database = readRequiredString(record, "database");
  const user = readRequiredString(record, "user");
  const port = Number(record.port ?? 3306);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Invalid MySQL port");
  }

  return {
    host,
    port,
    database,
    user,
    password: typeof record.password === "string" ? record.password : "",
  };
}

export async function testDatabaseConnection(config: DatabaseConfig): Promise<DatabaseCheckResult> {
  const probe = await probeDatabase(config);

  if (probe.status === "foreign-existing") {
    throw new Error(probe.message || "该数据库已存在，但未识别为 TMS 数据库。为避免覆盖其它系统数据，请更换数据库名或使用空库。");
  }
  if (probe.status === "tms-existing") {
    return probe;
  }

  await createDatabaseIfMissing(config);
  const connection = await createDatabaseConnection(config);

  try {
    await connection.ping();
    await ensureSetupSchema(connection);
    await ensureSystemIdentity(connection);
  } finally {
    await connection.end();
  }

  return {
    databaseExisted: probe.databaseExisted,
    status: probe.status,
    message: probe.status === "missing" ? "数据库不存在，已创建新的 TMS 数据库。" : "空数据库已确认可用于 TMS 初始化。",
  };
}

export async function ensureDatabaseExists(config: DatabaseConfig): Promise<DatabaseCheckResult> {
  const probe = await probeDatabase(config);
  if (probe.status === "foreign-existing") {
    throw new Error(probe.message || "该数据库已存在，但未识别为 TMS 数据库。");
  }

  if (probe.status === "missing") {
    await createDatabaseIfMissing(config);
  }

  return probe;
}

export async function probeDatabase(config: DatabaseConfig): Promise<DatabaseCheckResult> {
  validateDatabaseName(config.database);

  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectTimeout: 5_000,
    multipleStatements: false,
  });

  try {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?",
      [config.database],
    );
    const databaseExisted = rows.length > 0;

    if (!databaseExisted) {
      return {
        databaseExisted: false,
        status: "missing",
      };
    }

    const summary = await inspectExistingDatabase(connection, config.database);
    if (summary.tableCount === 0) {
      return {
        databaseExisted: true,
        status: "empty",
      };
    }

    if (summary.isTmsDatabase) {
      return {
        databaseExisted: true,
        status: "tms-existing",
        summary: {
          userCount: summary.userCount,
          completed: summary.completed,
          identity: summary.identity,
          configKeys: summary.configKeys,
        },
        message: "检测到已有 TMS 数据库。请使用该库中的管理员账号验证后继续。",
      };
    }

    return {
      databaseExisted: true,
      status: "foreign-existing",
      message: "该数据库已存在，但未识别为 TMS 数据库。为避免覆盖其它系统数据，请更换数据库名或使用空库。",
    };
  } finally {
    await connection.end();
  }
}

async function createDatabaseIfMissing(config: DatabaseConfig): Promise<void> {
  validateDatabaseName(config.database);
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectTimeout: 5_000,
    multipleStatements: false,
  });

  try {
    await connection.execute(
      `CREATE DATABASE IF NOT EXISTS \`${escapeIdentifier(config.database)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await connection.end();
  }
}

export async function createDatabaseConnection(config?: DatabaseConfig): Promise<mysql.Connection> {
  if (!config) {
    const pool = await getDatabasePool();
    const connection = await pool.getConnection();
    let released = false;
    (connection as unknown as { end: () => Promise<void> }).end = async () => {
      if (!released) {
        released = true;
        connection.release();
      }
    };
    return connection as unknown as mysql.Connection;
  }

  const resolved = config;
  if (!resolved) {
    throw new Error("Database connection is not configured");
  }

  return mysql.createConnection({
    host: resolved.host,
    port: resolved.port,
    user: resolved.user,
    password: resolved.password,
    database: resolved.database,
    connectTimeout: 5_000,
  });
}

async function getDatabasePool(): Promise<mysql.Pool> {
  databasePoolPromise ??= (async () => {
    const resolved = await readLocalDatabaseConfig();
    if (!resolved) {
      throw new Error("Database connection is not configured");
    }

    return mysql.createPool({
      host: resolved.host,
      port: resolved.port,
      user: resolved.user,
      password: resolved.password,
      database: resolved.database,
      connectTimeout: 5_000,
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 10,
      idleTimeout: 60_000,
      queueLimit: 0,
      enableKeepAlive: true,
    });
  })();

  return databasePoolPromise;
}

async function ensureDefaultSetupSchemaReady(): Promise<void> {
  defaultSetupSchemaReadyPromise ??= getDatabasePool().then((pool) => ensureSetupSchema(pool));
  return defaultSetupSchemaReadyPromise;
}

export async function ensureSetupSchema(connection: SqlExecutor): Promise<void> {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_config (
      config_key VARCHAR(128) NOT NULL PRIMARY KEY,
      config_value JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_hall_config (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      gdc_server_serial VARCHAR(255) NULL,
      hall_name VARCHAR(255) NOT NULL,
      gdc_host VARCHAR(255) NULL,
      gdc_port INT NULL,
      gdc_server_model VARCHAR(255) NULL,
      setup_status ENUM('configured', 'pending') NOT NULL DEFAULT 'pending',
      raw_config JSON NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tms_hall_config_gdc_server_serial (gdc_server_serial)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_hall_gdc_mapping (
      finixx_hall_id VARCHAR(128) NOT NULL PRIMARY KEY,
      gdc_server_serial VARCHAR(255) NULL,
      hall_name VARCHAR(255) NOT NULL,
      setup_status ENUM('configured', 'pending') NOT NULL DEFAULT 'pending',
      raw_mapping JSON NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tms_hall_gdc_mapping_gdc_server_serial (gdc_server_serial)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_user (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(128) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      password_salt VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_session (
      token CHAR(64) NOT NULL PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_tms_session_user_id (user_id),
      CONSTRAINT fk_tms_session_user_id FOREIGN KEY (user_id) REFERENCES tms_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureSystemIdentity(connection);
}

export async function saveSetupConfig(database: DatabaseConfig, setup: SetupConfig): Promise<void> {
  await ensureDatabaseExists(database);
  await saveLocalDatabaseConfig(database);
  const connection = await createDatabaseConnection(database);

  try {
    await ensureSetupSchema(connection);
    await connection.beginTransaction();
    await upsertConfig(connection, "setup.completed", {
      completed: true,
      completedAt: new Date().toISOString(),
      completedBy: setup.completedBy,
    });
    await upsertConfig(connection, "setup.draft", {});
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

export async function saveSetupDraft(database: DatabaseConfig, draft: SetupDraft): Promise<void> {
  await ensureDatabaseExists(database);
  await saveLocalDatabaseConfig(database);
  const connection = await createDatabaseConnection(database);

  try {
    await ensureSetupSchema(connection);
    await upsertConfig(connection, "setup.draft", {
      ...draft,
      database: draft.database ?? sanitizeDatabaseConfig(database),
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await connection.end();
  }
}

export async function saveSystemAccount(
  database: DatabaseConfig,
  username: string,
  password: string,
): Promise<AuthSession> {
  const normalizedUsername = normalizeUsername(username);
  validatePassword(password);
  await ensureDatabaseExists(database);
  await saveLocalDatabaseConfig(database);
  const connection = await createDatabaseConnection(database);

  try {
    await ensureSetupSchema(connection);
    await connection.execute("DELETE FROM tms_user WHERE username <> ?", [normalizedUsername]);
    const salt = randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    await connection.execute(
      `
        INSERT INTO tms_user (username, password_hash, password_salt)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
          password_hash = VALUES(password_hash),
          password_salt = VALUES(password_salt)
      `,
        [normalizedUsername, hash, salt],
    );
    await upsertConfig(connection, "setup.account", { username: normalizedUsername });
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT id, username FROM tms_user WHERE username = ? LIMIT 1",
      [normalizedUsername],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("系统账号创建失败。");
    }
    await connection.execute("DELETE FROM tms_session WHERE user_id = ?", [Number(row.id)]);
    return createSession(connection, Number(row.id), String(row.username));
  } finally {
    await connection.end();
  }
}

export async function adoptExistingTmsDatabase(
  database: DatabaseConfig,
  username: string,
  password: string,
): Promise<AuthSession> {
  const probe = await probeDatabase(database);
  if (probe.status !== "tms-existing") {
    throw new Error("只有已识别的 TMS 数据库可以通过管理员验证后继续使用。");
  }

  await saveLocalDatabaseConfig(database);
  const connection = await createDatabaseConnection(database);
  try {
    await ensureSetupSchema(connection);
    const session = await authenticateUserWithConnection(connection, username, password);
    await upsertConfig(connection, "setup.completed", {
      completed: true,
      completedAt: new Date().toISOString(),
      completedBy: session.username,
      adoptedExistingDatabase: true,
    });
    await upsertConfig(connection, "setup.draft", {});
    return session;
  } finally {
    await connection.end();
  }
}

export async function authenticateUser(username: string, password: string): Promise<AuthSession> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    return authenticateUserWithConnection(connection, username, password);
  } finally {
    await connection.end();
  }
}

async function authenticateUserWithConnection(
  connection: mysql.Connection,
  username: string,
  password: string,
): Promise<AuthSession> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    "SELECT id, username, password_hash, password_salt FROM tms_user WHERE username = ? LIMIT 1",
    [normalizeUsername(username)],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("用户名或密码错误。");
  }

  const expectedHash = String(row.password_hash);
  const actualHash = hashPassword(password, String(row.password_salt));
  if (!safeCompare(expectedHash, actualHash)) {
    throw new Error("用户名或密码错误。");
  }

  await connection.execute("DELETE FROM tms_session WHERE user_id = ?", [Number(row.id)]);
  return createSession(connection, Number(row.id), String(row.username));
}

export async function readSession(token: string, renew: boolean): Promise<AuthSession | null> {
  const pool = await getDatabasePool();
  await ensureDefaultSetupSchemaReady();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT s.token, s.user_id, s.expires_at, u.username
      FROM tms_session s
      JOIN tms_user u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > NOW()
      LIMIT 1
    `,
    [token],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }

  if (renew) {
    await pool.execute(
      "UPDATE tms_session SET expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE token = ?",
      [token],
    );
  }

  return {
    token: String(row.token),
    userId: Number(row.user_id),
    username: String(row.username),
    expiresAt: new Date(row.expires_at),
  };
}

export async function deleteSession(token: string): Promise<void> {
  const connection = await createDatabaseConnection();
  try {
    await connection.execute("DELETE FROM tms_session WHERE token = ?", [token]);
  } finally {
    await connection.end();
  }
}

export async function hasSystemAccount(): Promise<boolean> {
  const pool = await getDatabasePool();
  await ensureDefaultSetupSchemaReady();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id FROM tms_user LIMIT 1",
  );
  return rows.length > 0;
}

export async function readSetupDraft(): Promise<SetupDraft | null> {
  const localDatabase = await readLocalDatabaseConfig();
  if (!localDatabase) {
    return null;
  }

  const pool = await getDatabasePool();
  await ensureDefaultSetupSchemaReady();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT config_value FROM tms_config WHERE config_key = ?",
    ["setup.draft"],
  );
  const value = rows[0]?.config_value;
  if (!value) {
    return {
      database: sanitizeDatabaseConfig(localDatabase),
      step: 1,
      tests: [true, false, false, false],
    };
  }

  const draft = typeof value === "string" ? JSON.parse(value) : value;
  return {
    ...draft,
    database: draft.database ?? sanitizeDatabaseConfig(localDatabase),
  } as SetupDraft;
}

export async function readSetupCompleted(): Promise<boolean> {
  const pool = await getDatabasePool();
  await ensureDefaultSetupSchemaReady();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT config_value FROM tms_config WHERE config_key = ?",
    ["setup.completed"],
  );
  return rows.length > 0;
}

export async function readRepositoryConfig(): Promise<RepositoryConfig> {
  const database = await readLocalDatabaseConfig();
  if (!database) {
    return { path: defaultRepositoryPath };
  }

  try {
    const value = await readConfigValue("storage.repository");
    if (typeof value === "string") {
      return { path: normalizeRepositoryPath(value) };
    }

    if (value && typeof value === "object" && !Array.isArray(value) && "path" in value) {
      const record = value as { path?: unknown; projectorAccessHost?: unknown };
      return {
        path: normalizeRepositoryPath(record.path),
        projectorAccessHost: normalizeOptionalHost(record.projectorAccessHost),
      };
    }
  } catch {
    return { path: defaultRepositoryPath };
  }

  return { path: defaultRepositoryPath };
}

export async function saveRepositoryConfig(input: {
  readonly path: string;
  readonly projectorAccessHost?: string;
}): Promise<RepositoryConfig> {
  const database = await readLocalDatabaseConfig();
  if (!database) {
    throw new Error("请先完成系统初始化后再配置存储库路径。");
  }

  const normalizedPath = normalizeRepositoryPath(input.path);
  const normalizedProjectorAccessHost = normalizeOptionalHost(input.projectorAccessHost);
  await ensureDatabaseExists(database);
  const connection = await createDatabaseConnection(database);

  try {
    await ensureSetupSchema(connection);
    await upsertConfig(connection, "storage.repository", {
      path: normalizedPath,
      projectorAccessHost: normalizedProjectorAccessHost,
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await connection.end();
  }

  return {
    path: normalizedPath,
    projectorAccessHost: normalizedProjectorAccessHost,
  };
}

export async function readZyhxKdmAccountConfig(): Promise<ZyhxKdmAccountConfig | null> {
  try {
    const value = await readConfigValue("zyhx.kdm.account");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const username = typeof record.username === "string" ? record.username.trim() : "";
    if (!username) {
      return null;
    }

    return {
      username,
      password: typeof record.password === "string" ? record.password : "",
    };
  } catch {
    return null;
  }
}

export async function saveZyhxKdmAccountConfig(input: {
  readonly username?: string;
  readonly password?: string;
}): Promise<ZyhxKdmAccountConfig> {
  const current = await readZyhxKdmAccountConfig();
  const username = typeof input.username === "string" ? input.username.trim() : current?.username ?? "";
  const password = typeof input.password === "string" ? input.password : current?.password ?? "";

  if (!username) {
    throw new Error("中影华夏账号不能为空。");
  }
  if (!password) {
    throw new Error("中影华夏密码不能为空。");
  }

  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    await upsertConfig(connection, "zyhx.kdm.account", {
      username,
      password,
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await connection.end();
  }

  return { username, password };
}

export async function readFinixxConfig(): Promise<FinixxConfig | null> {
  try {
    const value = await readConfigValue("finixx");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl : "";
      if (!baseUrl) return null;
      return {
        baseUrl,
        serviceUsername: typeof record.serviceUsername === "string" ? record.serviceUsername : undefined,
        servicePassword: typeof record.servicePassword === "string" ? record.servicePassword : undefined,
        serviceApiKey: typeof record.serviceApiKey === "string" ? record.serviceApiKey : undefined,
        cinemaInfo: record.cinemaInfo,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function saveFinixxConfig(config: FinixxConfig): Promise<void> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    await upsertConfig(connection, "finixx", {
      baseUrl: config.baseUrl,
      serviceUsername: config.serviceUsername,
      servicePassword: config.servicePassword,
      serviceApiKey: config.serviceApiKey,
      cinemaInfo: config.cinemaInfo,
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await connection.end();
  }
}

export async function saveConfiguredHalls(halls: readonly HallConfig[]): Promise<void> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    await connection.beginTransaction();
    for (const hall of halls) {
      await upsertHall(connection, hall, "configured");
    }
    await deleteUnconfiguredHalls(connection, halls);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

export async function upsertSingleHall(hall: HallConfig): Promise<void> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    await connection.beginTransaction();
    await upsertHall(connection, hall, "configured");
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

export async function deleteSingleHall(finixxHallId: string): Promise<void> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    await connection.beginTransaction();

    const [mappings] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT gdc_server_serial FROM tms_hall_gdc_mapping WHERE finixx_hall_id = ?",
      [finixxHallId],
    );
    await connection.execute(
      "DELETE FROM tms_hall_gdc_mapping WHERE finixx_hall_id = ?",
      [finixxHallId],
    );

    for (const row of mappings) {
      const serial = row.gdc_server_serial;
      if (serial) {
        const [refs] = await connection.execute<mysql.RowDataPacket[]>(
          "SELECT 1 FROM tms_hall_gdc_mapping WHERE gdc_server_serial = ? LIMIT 1",
          [serial],
        );
        if (refs.length === 0) {
          await connection.execute(
            "DELETE FROM tms_hall_config WHERE gdc_server_serial = ?",
            [serial],
          );
        }
      }
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

export async function readAutomationDangerousCommandFilterEnabled(): Promise<boolean> {
  const value = await readConfigValue("automation.hideDangerousCommands");
  if (typeof value === "boolean") {
    return value;
  }

  if (value && typeof value === "object" && !Array.isArray(value) && "enabled" in value) {
    return Boolean((value as { enabled?: unknown }).enabled);
  }

  await saveAutomationDangerousCommandFilterEnabled(true);
  return true;
}

export async function saveAutomationDangerousCommandFilterEnabled(enabled: boolean): Promise<void> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    await upsertConfig(connection, "automation.hideDangerousCommands", { enabled });
  } finally {
    await connection.end();
  }
}

export interface FilmSchedulerRecoverySettings {
  readonly autoCorrectShowUuid: boolean;
  readonly allowTemporaryShow: boolean;
}

export async function readFilmSchedulerRecoverySettings(): Promise<FilmSchedulerRecoverySettings> {
  const value = await readConfigValue("film-scheduler.recovery").catch(() => undefined);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      autoCorrectShowUuid: Boolean(record.autoCorrectShowUuid),
      allowTemporaryShow: Boolean(record.allowTemporaryShow),
    };
  }

  return {
    autoCorrectShowUuid: false,
    allowTemporaryShow: false,
  };
}

export async function saveFilmSchedulerRecoverySettings(
  input: Partial<FilmSchedulerRecoverySettings>,
): Promise<FilmSchedulerRecoverySettings> {
  const current = await readFilmSchedulerRecoverySettings();
  const next: FilmSchedulerRecoverySettings = {
    autoCorrectShowUuid: typeof input.autoCorrectShowUuid === "boolean"
      ? input.autoCorrectShowUuid
      : current.autoCorrectShowUuid,
    allowTemporaryShow: typeof input.allowTemporaryShow === "boolean"
      ? input.allowTemporaryShow
      : current.allowTemporaryShow,
  };

  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    await upsertConfig(connection, "film-scheduler.recovery", {
      ...next,
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await connection.end();
  }

  return next;
}

export async function readConfiguredHalls(): Promise<HallConfig[]> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(`
      SELECT
        mapping.finixx_hall_id,
        mapping.gdc_server_serial,
        mapping.hall_name AS mapping_hall_name,
        mapping.raw_mapping,
        config.hall_name AS config_hall_name,
        config.gdc_host,
        config.gdc_port,
        config.gdc_server_model,
        config.gdc_server_serial,
        config.raw_config
      FROM tms_hall_gdc_mapping mapping
      JOIN tms_hall_config config ON config.gdc_server_serial = mapping.gdc_server_serial
      WHERE mapping.setup_status = 'configured' AND config.setup_status = 'configured'
      ORDER BY config.hall_name ASC, mapping.finixx_hall_id ASC
    `);

    return rows.map((row) => {
      const rawConfig = typeof row.raw_config === "string"
        ? JSON.parse(row.raw_config)
        : row.raw_config;
      const rawMapping = typeof row.raw_mapping === "string"
        ? JSON.parse(row.raw_mapping)
        : row.raw_mapping;

      const hall = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
        ? rawConfig as HallConfig
        : undefined;
      const mapping = rawMapping && typeof rawMapping === "object" && !Array.isArray(rawMapping)
        ? rawMapping as Partial<HallConfig>
        : undefined;

      return {
        id: hall?.id ?? mapping?.id ?? String(row.finixx_hall_id),
        name: hall?.name ?? String(row.config_hall_name ?? row.mapping_hall_name),
        finixxHallId: mapping?.finixxHallId ?? String(row.finixx_hall_id),
        host: row.gdc_host ? String(row.gdc_host) : undefined,
        port: row.gdc_port === null || row.gdc_port === undefined ? undefined : Number(row.gdc_port),
        tested: hall?.tested ?? Boolean(row.gdc_host),
        gdcDeviceInfo: {
          ...hall?.gdcDeviceInfo,
          model: typeof row.gdc_server_model === "string" && row.gdc_server_model
            ? row.gdc_server_model
            : hall?.gdcDeviceInfo?.model,
          serial: typeof row.gdc_server_serial === "string" && row.gdc_server_serial
            ? row.gdc_server_serial
            : hall?.gdcDeviceInfo?.serial,
        },
      };
    });
  } finally {
    await connection.end();
  }
}

async function readConfigValue(key: string): Promise<unknown> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT config_value FROM tms_config WHERE config_key = ?",
      [key],
    );
    const value = rows[0]?.config_value;
    return typeof value === "string" ? JSON.parse(value) : value;
  } finally {
    await connection.end();
  }
}

async function ensureSystemIdentity(connection: SqlExecutor): Promise<void> {
  await upsertConfig(connection, systemIdentityConfigKey, {
    ...systemIdentity,
    updatedAt: new Date().toISOString(),
  });
}

async function upsertConfig(connection: SqlExecutor, key: string, value: unknown): Promise<void> {
  await connection.execute(
    `
      INSERT INTO tms_config (config_key, config_value)
      VALUES (?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)
    `,
    [key, JSON.stringify(value)],
  );
}

async function inspectExistingDatabase(
  connection: mysql.Connection,
  databaseName: string,
): Promise<{
  readonly tableCount: number;
  readonly isTmsDatabase: boolean;
  readonly userCount: number;
  readonly completed: boolean;
  readonly identity?: unknown;
  readonly configKeys: readonly string[];
}> {
  const [tables] = await connection.execute<mysql.RowDataPacket[]>(
    `
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ?
    `,
    [databaseName],
  );
  const tableNames = new Set(tables.map((row) => String(row.TABLE_NAME)));
  const tableCount = tableNames.size;
  const hasConfigTable = tableNames.has("tms_config");
  const hasUserTable = tableNames.has("tms_user");

  if (!hasConfigTable) {
    return {
      tableCount,
      isTmsDatabase: false,
      userCount: 0,
      completed: false,
      configKeys: [],
    };
  }

  const configColumns = await readTableColumns(connection, databaseName, "tms_config");
  if (!configColumns.has("config_key") || !configColumns.has("config_value")) {
    return {
      tableCount,
      isTmsDatabase: false,
      userCount: 0,
      completed: false,
      configKeys: [],
    };
  }

  const db = `\`${escapeIdentifier(databaseName)}\``;
  let identity: unknown;
  let configKeys: string[] = [];
  let completed = false;
  let userCount = 0;
  let hasUsableUserTable = false;

  const [configs] = await connection.execute<mysql.RowDataPacket[]>(
    `SELECT config_key, config_value FROM ${db}.tms_config WHERE config_key IN (?, ?, ?, ?)`,
    [systemIdentityConfigKey, "setup.completed", "setup.account", "finixx"],
  );

  configKeys = configs.map((row) => String(row.config_key));
  const identityRow = configs.find((row) => row.config_key === systemIdentityConfigKey);
  const completedRow = configs.find((row) => row.config_key === "setup.completed");
  identity = identityRow ? parseJsonValue(identityRow.config_value) : undefined;
  completed = Boolean(completedRow);

  if (hasUserTable) {
    const userColumns = await readTableColumns(connection, databaseName, "tms_user");
    if (userColumns.has("username") && userColumns.has("password_hash") && userColumns.has("password_salt")) {
      hasUsableUserTable = true;
      const [users] = await connection.execute<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS user_count FROM ${db}.tms_user`,
      );
      userCount = Number(users[0]?.user_count ?? 0);
    }
  }

  const identityRecord = identity && typeof identity === "object" && !Array.isArray(identity)
    ? identity as Record<string, unknown>
    : null;
  const hasIdentity = identityRecord?.app === systemIdentity.app;
  const hasLegacyTmsShape = hasConfigTable && hasUsableUserTable && (
    tableNames.has("tms_session")
    || tableNames.has("tms_hall_config")
    || tableNames.has("tms_hall_gdc_mapping")
    || configKeys.includes("setup.completed")
    || configKeys.includes("setup.account")
    || configKeys.includes("finixx")
  );

  return {
    tableCount,
    isTmsDatabase: (hasIdentity || hasLegacyTmsShape) && hasUsableUserTable,
    userCount,
    completed,
    identity,
    configKeys,
  };
}

async function readTableColumns(
  connection: mysql.Connection,
  databaseName: string,
  tableName: string,
): Promise<Set<string>> {
  const [columns] = await connection.execute<mysql.RowDataPacket[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `,
    [databaseName, tableName],
  );
  return new Set(columns.map((row) => String(row.COLUMN_NAME)));
}

function parseJsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function upsertHall(
  connection: mysql.Connection,
  hall: HallConfig,
  status: "configured" | "pending",
): Promise<void> {
  const port = hall.port === undefined || hall.port === "" ? null : Number(hall.port);
  await connection.execute(
    `
      INSERT INTO tms_hall_config
        (
          gdc_server_serial,
          hall_name,
          gdc_host,
          gdc_port,
          gdc_server_model,
          setup_status,
          raw_config
        )
      VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE
        gdc_server_serial = VALUES(gdc_server_serial),
        hall_name = VALUES(hall_name),
        gdc_host = VALUES(gdc_host),
        gdc_port = VALUES(gdc_port),
        gdc_server_model = VALUES(gdc_server_model),
        gdc_server_serial = VALUES(gdc_server_serial),
        setup_status = VALUES(setup_status),
        raw_config = VALUES(raw_config)
    `,
    [
      hall.gdcDeviceInfo?.serial || null,
      hall.name,
      hall.host || null,
      Number.isFinite(port) ? port : null,
      hall.gdcDeviceInfo?.model || null,
      status,
      JSON.stringify(hall),
    ],
  );

  await connection.execute(
    `
      INSERT INTO tms_hall_gdc_mapping
        (finixx_hall_id, gdc_server_serial, hall_name, setup_status, raw_mapping)
      VALUES (?, ?, ?, ?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE
        gdc_server_serial = VALUES(gdc_server_serial),
        hall_name = VALUES(hall_name),
        setup_status = VALUES(setup_status),
        raw_mapping = VALUES(raw_mapping)
    `,
    [
      hall.finixxHallId || hall.id,
      hall.gdcDeviceInfo?.serial || null,
      hall.name,
      status,
      JSON.stringify({
        id: hall.id,
        name: hall.name,
        finixxHallId: hall.finixxHallId || hall.id,
      }),
    ],
  );
}

async function deleteUnconfiguredHalls(
  connection: mysql.Connection,
  configuredHalls: readonly HallConfig[],
): Promise<void> {
  const finixxHallIds = configuredHalls
    .map((hall) => hall.finixxHallId || hall.id)
    .filter((value, index, array) => value && array.indexOf(value) === index);

  if (finixxHallIds.length > 0) {
    const placeholders = finixxHallIds.map(() => "?").join(", ");
    await connection.execute(
      `DELETE FROM tms_hall_gdc_mapping WHERE finixx_hall_id NOT IN (${placeholders})`,
      finixxHallIds,
    );
  } else {
    await connection.execute("DELETE FROM tms_hall_gdc_mapping");
  }

  await connection.execute(`
    DELETE config
    FROM tms_hall_config config
    LEFT JOIN tms_hall_gdc_mapping mapping
      ON mapping.gdc_server_serial <=> config.gdc_server_serial
    WHERE mapping.finixx_hall_id IS NULL
  `);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object");
  }

  return value as Record<string, unknown>;
}

function normalizeRepositoryPath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("存储库路径不能为空。");
  }

  return resolve(value.trim());
}

function normalizeOptionalHost(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!isValidIpv4Address(trimmed) && !isValidDomainName(trimmed)) {
    throw new Error("放映机访问地址需为 IPv4 地址或域名。");
  }
  return trimmed;
}

function isValidIpv4Address(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    if (part.length > 1 && part.startsWith("0")) {
      return false;
    }
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255;
  });
}

function isValidDomainName(value: string): boolean {
  if (value.length > 253 || value.includes("..")) {
    return false;
  }

  const normalized = value.endsWith(".") ? value.slice(0, -1) : value;
  if (!normalized.includes(".")) {
    return false;
  }

  return normalized.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required field: ${key}`);
  }

  return value.trim();
}

async function createSession(
  connection: mysql.Connection,
  userId: number,
  username: string,
): Promise<AuthSession> {
  const token = randomBytes(32).toString("hex");
  await connection.execute(
    "INSERT INTO tms_session (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))",
    [token, userId],
  );
  return {
    token,
    userId,
    username,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}

function normalizeUsername(username: string): string {
  const normalized = username.trim();
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(normalized)) {
    throw new Error("用户名需为 3-64 位，可包含字母、数字、下划线、点和短横线。");
  }
  return normalized;
}

function validatePassword(password: string): void {
  if (password.length < 4 || password.length > 128) {
    throw new Error("密码长度需为 4-128 位。");
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

function safeCompare(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function validateDatabaseName(database: string): void {
  if (!/^[A-Za-z0-9_$]+$/.test(database)) {
    throw new Error("数据库名只能包含字母、数字、下划线和 $。");
  }
}

function escapeIdentifier(identifier: string): string {
  return identifier.replace(/`/g, "``");
}

export interface UserRecord {
  readonly id: number;
  readonly username: string;
  readonly createdAt: string;
}

export async function listUsers(): Promise<UserRecord[]> {
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT id, username, created_at FROM tms_user ORDER BY id ASC",
    );
    return rows.map((row) => ({
      id: Number(row.id),
      username: String(row.username),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  } finally {
    await connection.end();
  }
}

export async function createNewUser(username: string, password: string): Promise<UserRecord> {
  const normalizedUsername = normalizeUsername(username);
  validatePassword(password);
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    const [existing] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM tms_user WHERE username = ? LIMIT 1",
      [normalizedUsername],
    );
    if (existing.length > 0) {
      throw new Error("用户名已存在。");
    }
    const salt = randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    const [result] = await connection.execute<mysql.ResultSetHeader>(
      "INSERT INTO tms_user (username, password_hash, password_salt) VALUES (?, ?, ?)",
      [normalizedUsername, hash, salt],
    );
    return {
      id: result.insertId,
      username: normalizedUsername,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await connection.end();
  }
}

export async function changeUserPassword(
  userId: number,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  validatePassword(newPassword);
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT password_hash, password_salt FROM tms_user WHERE id = ? LIMIT 1",
      [userId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("用户不存在。");
    }
    const actualHash = hashPassword(oldPassword, String(row.password_salt));
    if (!safeCompare(String(row.password_hash), actualHash)) {
      throw new Error("旧密码错误。");
    }
    const salt = randomBytes(16).toString("hex");
    const hash = hashPassword(newPassword, salt);
    await connection.execute(
      "UPDATE tms_user SET password_hash = ?, password_salt = ? WHERE id = ?",
      [hash, salt, userId],
    );
  } finally {
    await connection.end();
  }
}

export async function resetUserPassword(userId: number, newPassword: string): Promise<void> {
  validatePassword(newPassword);
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    const salt = randomBytes(16).toString("hex");
    const hash = hashPassword(newPassword, salt);
    const [result] = await connection.execute<mysql.ResultSetHeader>(
      "UPDATE tms_user SET password_hash = ?, password_salt = ? WHERE id = ?",
      [hash, salt, userId],
    );
    if (result.affectedRows === 0) {
      throw new Error("用户不存在。");
    }
  } finally {
    await connection.end();
  }
}

export async function deleteUser(userId: number, currentUserId: number): Promise<void> {
  if (userId === currentUserId) {
    throw new Error("不能删除当前登录用户。");
  }
  const connection = await createDatabaseConnection();
  try {
    await ensureSetupSchema(connection);
    const [result] = await connection.execute<mysql.ResultSetHeader>(
      "DELETE FROM tms_user WHERE id = ?",
      [userId],
    );
    if (result.affectedRows === 0) {
      throw new Error("用户不存在。");
    }
  } finally {
    await connection.end();
  }
}
