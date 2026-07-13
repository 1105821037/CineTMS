import { mkdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { resolve as resolvePath } from "node:path";
import FtpSrv, { type FtpServer, type FtpServerOptions } from "ftp-srv";
import { TmsRepositoryFtpFileSystem } from "./ftp-filesystem";
import { getDefaultRepositoryPath, readRepositoryConfig, type RepositoryConfig } from "./setup-store";

const ftpHost = process.env.FTP_HOST?.trim() || "0.0.0.0";
const preferredFtpPort = readPort(process.env.FTP_PORT, 2121);
const ftpPassivePortMin = readPort(process.env.FTP_PASV_MIN, 41000);
const ftpPassivePortMax = readPort(process.env.FTP_PASV_MAX, 41100);
const ftpReadonlyBlacklist = ["APPE", "DELE", "MKD", "RMD", "RNFR", "RNTO", "SITE", "STOR", "STOU"];
const maxPortAttempts = 20;

export interface RepositoryFtpStatus {
  readonly state: "stopped" | "starting" | "running" | "error";
  readonly rootPath: string;
  readonly host: string;
  readonly port: number;
  readonly anonymous: boolean;
  readonly passiveHost?: string;
  readonly passivePortRange: {
    readonly min: number;
    readonly max: number;
  };
  readonly message?: string;
}

export class RepositoryFtpService {
  private server: FtpServer | null = null;
  private state: RepositoryFtpStatus["state"] = "stopped";
  private rootPath = resolvePath(getDefaultRepositoryPath());
  private passiveHost = resolvePassiveHost();
  private port = preferredFtpPort;
  private message = "";

  async start(): Promise<void> {
    if (this.state === "starting" || this.state === "running") {
      return;
    }

    await this.reloadFromConfig();
  }

  async reloadFromConfig(): Promise<void> {
    const config = await readRepositoryConfig().catch(() => ({ path: getDefaultRepositoryPath() }));
    await this.applyConfiguration(config);
  }

  async reconfigure(config: RepositoryConfig): Promise<void> {
    await this.applyConfiguration(config);
  }

  async stop(): Promise<void> {
    const currentServer = this.server;
    this.server = null;
    this.state = "stopped";
    this.message = "";

    if (!currentServer) {
      return;
    }

    await currentServer.close().catch(() => undefined);
  }

  getStatus(): RepositoryFtpStatus {
    return {
      state: this.state,
      rootPath: this.rootPath,
      host: ftpHost,
      port: this.port,
      anonymous: true,
      passiveHost: this.passiveHost || undefined,
      passivePortRange: {
        min: ftpPassivePortMin,
        max: ftpPassivePortMax,
      },
      message: this.message || undefined,
    };
  }

  private async applyConfiguration(config: RepositoryConfig): Promise<void> {
    const normalizedRootPath = resolvePath(config.path);
    const passiveHost = resolvePassiveHost(config.projectorAccessHost);
    if (
      this.server
      && this.rootPath === normalizedRootPath
      && this.passiveHost === passiveHost
      && this.state === "running"
    ) {
      return;
    }

    this.state = "starting";
    this.message = "";

    await mkdir(normalizedRootPath, { recursive: true });

    const previousServer = this.server;
    this.server = null;
    if (previousServer) {
      await previousServer.close().catch(() => undefined);
    }

    try {
      const { server, port } = await this.listenOnAvailablePort(
        normalizedRootPath,
        passiveHost,
        preferredFtpPort,
        process.env.FTP_PORT ? 0 : maxPortAttempts,
      );
      this.server = server;
      this.rootPath = normalizedRootPath;
      this.passiveHost = passiveHost;
      this.port = port;
      this.state = "running";
      this.message = buildPassiveModeMessage(passiveHost);
    } catch (error) {
      this.state = "error";
      this.message = error instanceof Error ? error.message : "FTP 服务启动失败。";
      throw error;
    }
  }

  private createServer(rootPath: string, passiveHost: string | undefined, port: number): FtpServer {
    const options: FtpServerOptions = {
      url: `ftp://${ftpHost}:${port}`,
      anonymous: true,
      greeting: ["TMS Repository FTP", "Anonymous read-only access"],
      blacklist: ftpReadonlyBlacklist,
      pasv_min: ftpPassivePortMin,
      pasv_max: ftpPassivePortMax,
      timeout: 0,
    };

    if (passiveHost) {
      options.pasv_url = passiveHost;
    }

    const server = new FtpSrv(options);

    server.on("login", ({ connection, username }, resolve, reject) => {
      if (username !== "anonymous") {
        reject(new Error("Only anonymous FTP access is allowed."));
        return;
      }

      resolve({
        root: rootPath,
        fs: new TmsRepositoryFtpFileSystem(connection, rootPath),
      });
    });

    server.on("client-error", ({ context, error }) => {
      console.error(`FTP client error (${context}):`, error);
    });

    server.on("disconnect", ({ id }) => {
      console.log(`FTP client disconnected: ${id}`);
    });

    return server;
  }

  private async listenOnAvailablePort(
    rootPath: string,
    passiveHost: string | undefined,
    port: number,
    attemptsLeft: number,
  ): Promise<{ server: FtpServer; port: number }> {
    const server = this.createServer(rootPath, passiveHost, port);

    try {
      await server.listen();
      return { server, port };
    } catch (error) {
      if (
        !process.env.FTP_PORT
        && error instanceof Error
        && "code" in error
        && error.code === "EADDRINUSE"
        && attemptsLeft > 0
      ) {
        return this.listenOnAvailablePort(rootPath, passiveHost, port + 1, attemptsLeft - 1);
      }

      throw error;
    }
  }
}

let repositoryFtpServiceSingleton: RepositoryFtpService | null = null;

export function getRepositoryFtpService(): RepositoryFtpService {
  repositoryFtpServiceSingleton ??= new RepositoryFtpService();
  return repositoryFtpServiceSingleton;
}

function readPort(value: string | undefined, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) {
    return fallback;
  }
  return numeric;
}

function detectLanIpv4(): string | undefined {
  const networks = networkInterfaces();
  const candidates: string[] = [];

  for (const entries of Object.values(networks)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      candidates.push(entry.address);
    }
  }

  return candidates.find((address) =>
    address.startsWith("10.")
    || address.startsWith("172.")
    || address.startsWith("192.168."),
  ) || candidates[0];
}

function resolvePassiveHost(projectorAccessHost?: string): string | undefined {
  return projectorAccessHost?.trim() || process.env.FTP_PASV_HOST?.trim() || detectLanIpv4();
}

function buildPassiveModeMessage(passiveHost?: string): string {
  if (passiveHost) {
    return "";
  }

  return "未检测到可用于 PASV 的局域网地址，请在系统设置中填写放映机访问地址，或设置 FTP_PASV_HOST。";
}
