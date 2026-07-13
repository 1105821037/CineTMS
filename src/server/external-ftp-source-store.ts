import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { ensureSetupSchema, readLocalDatabaseConfig } from "./setup-store";
import { normalizeExternalFtpSource, type ExternalFtpSource } from "./external-dcp-ftp";

type SqlExecutor = Pick<mysql.Connection, "execute"> | Pick<mysql.Pool, "execute">;

export interface ExternalFtpSourceSummary {
  readonly id: string;
  readonly label: string;
  readonly kind: "custom";
  readonly rootPath?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

type StoredExternalFtpSource = ExternalFtpSource & {
  readonly id: string;
};

let externalFtpSourcePoolPromise: Promise<mysql.Pool | null> | null = null;
let externalFtpSourceSchemaReadyPromise: Promise<void> | null = null;

export async function ensureExternalFtpSourceSchema(connection: SqlExecutor): Promise<void> {
  await ensureSetupSchema(connection);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tms_external_ftp_source (
      source_id VARCHAR(128) NOT NULL PRIMARY KEY,
      source_label VARCHAR(255) NOT NULL,
      ftp_host VARCHAR(255) NOT NULL,
      ftp_port INT NOT NULL,
      ftp_username VARCHAR(255) NULL,
      ftp_password TEXT NULL,
      root_path VARCHAR(512) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_tms_external_ftp_source_endpoint (ftp_host, ftp_port)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function listExternalFtpSourceSummaries(): Promise<ExternalFtpSourceSummary[]> {
  const pool = await getExternalFtpSourcePool();
  if (!pool) {
    return [];
  }

  await ensureExternalFtpSourceSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(`
    SELECT source_id, source_label, root_path, created_at, updated_at
    FROM tms_external_ftp_source
    ORDER BY updated_at DESC
  `);
  return rows.map(mapSourceSummaryRow);
}

export async function createExternalFtpSource(value: unknown): Promise<ExternalFtpSourceSummary> {
  const pool = await getExternalFtpSourcePool();
  if (!pool) {
    throw new Error("数据库未配置，无法保存外部 FTP 来源。");
  }

  await ensureExternalFtpSourceSchemaReady(pool);
  const source = normalizeExternalFtpSource(value);
  const id = `external-ftp:${randomUUID()}`;
  const label = source.label || source.host;
  const rootPath = source.rootPath || "";

  await pool.execute(
    `
      DELETE FROM tms_external_ftp_source
      WHERE ftp_host = ? AND ftp_port = ? AND root_path = ?
    `,
    [source.host, source.port, rootPath],
  );

  await pool.execute(
    `
      INSERT INTO tms_external_ftp_source
        (source_id, source_label, ftp_host, ftp_port, ftp_username, ftp_password, root_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      label,
      source.host,
      source.port,
      source.username || null,
      source.password ?? null,
      rootPath,
    ],
  );

  const created = await readExternalFtpSourceSummaryById(id);
  if (!created) {
    throw new Error("保存外部 FTP 来源失败。");
  }
  return created;
}

export async function deleteExternalFtpSource(id: string): Promise<boolean> {
  const pool = await getExternalFtpSourcePool();
  if (!pool) {
    return false;
  }

  await ensureExternalFtpSourceSchemaReady(pool);
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    "DELETE FROM tms_external_ftp_source WHERE source_id = ?",
    [id],
  );
  return result.affectedRows > 0;
}

export async function readExternalFtpSourceById(id: string): Promise<ExternalFtpSource | null> {
  const pool = await getExternalFtpSourcePool();
  if (!pool) {
    return null;
  }

  await ensureExternalFtpSourceSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM tms_external_ftp_source WHERE source_id = ? LIMIT 1",
    [id],
  );
  return rows[0] ? mapStoredSourceRow(rows[0]) : null;
}

async function readExternalFtpSourceSummaryById(id: string): Promise<ExternalFtpSourceSummary | null> {
  const pool = await getExternalFtpSourcePool();
  if (!pool) {
    return null;
  }

  await ensureExternalFtpSourceSchemaReady(pool);
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `
      SELECT source_id, source_label, root_path, created_at, updated_at
      FROM tms_external_ftp_source
      WHERE source_id = ?
      LIMIT 1
    `,
    [id],
  );
  return rows[0] ? mapSourceSummaryRow(rows[0]) : null;
}

async function getExternalFtpSourcePool(): Promise<mysql.Pool | null> {
  externalFtpSourcePoolPromise ??= (async () => {
    const database = await readLocalDatabaseConfig();
    if (!database) {
      return null;
    }

    return mysql.createPool({
      host: database.host,
      port: database.port,
      user: database.user,
      password: database.password,
      database: database.database,
      waitForConnections: true,
      connectionLimit: 4,
      connectTimeout: 5_000,
    });
  })();
  return externalFtpSourcePoolPromise;
}

async function ensureExternalFtpSourceSchemaReady(pool: mysql.Pool): Promise<void> {
  externalFtpSourceSchemaReadyPromise ??= ensureExternalFtpSourceSchema(pool);
  return externalFtpSourceSchemaReadyPromise;
}

function mapSourceSummaryRow(row: mysql.RowDataPacket): ExternalFtpSourceSummary {
  return {
    id: String(row.source_id || ""),
    label: String(row.source_label || ""),
    rootPath: String(row.root_path || "") || undefined,
    kind: "custom",
    createdAt: toIsoDate(row.created_at),
    updatedAt: toIsoDate(row.updated_at),
  };
}

function mapStoredSourceRow(row: mysql.RowDataPacket): StoredExternalFtpSource {
  return {
    id: String(row.source_id || ""),
    label: String(row.source_label || ""),
    host: String(row.ftp_host || ""),
    port: Number(row.ftp_port || 21),
    username: typeof row.ftp_username === "string" && row.ftp_username ? row.ftp_username : undefined,
    password: typeof row.ftp_password === "string" ? row.ftp_password : undefined,
    rootPath: String(row.root_path || "") || undefined,
  };
}

function toIsoDate(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value) {
    return new Date(value).toISOString();
  }
  return undefined;
}
