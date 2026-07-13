import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readZyhxKdmAccountConfig } from "./setup-store";
import { listKdmAssets, saveUploadedKdms, type KdmUploadResult } from "./kdm-store";

export interface ZyhxKdmListOptions {
  readonly page?: number;
  readonly pagesize?: number;
  readonly keyword?: string;
  readonly downloaded?: number;
  readonly pid?: string;
  readonly category?: number;
  readonly term?: number;
}

export interface ZyhxKdmDownloadResult {
  readonly downloaded: readonly {
    readonly id: string;
    readonly path: string;
    readonly uploaded: KdmUploadResult["uploaded"];
    readonly rejected: KdmUploadResult["rejected"];
  }[];
  readonly failed: readonly {
    readonly id: string;
    readonly error: string;
  }[];
  readonly assets: Awaited<ReturnType<typeof listKdmAssets>>;
}

const defaultCliProjectPath = resolve(process.cwd(), "scripts", "kdm-auto-download-ts");
let loginInFlight: Promise<void> | null = null;

export class ZyhxKdmLoginRequiredError extends Error {
  constructor(message = "中影华夏登录状态已失效。") {
    super(message);
  }
}

export async function listZyhxKdms(options: ZyhxKdmListOptions = {}): Promise<unknown> {
  const args = options.keyword
    ? ["search", options.keyword, "--raw", "--limit", String(options.pagesize ?? 100)]
    : ["list", "--page", String(options.page ?? 1), "--pagesize", String(options.pagesize ?? 100)];
  appendCommonFilters(args, options);
  return runZyhxKdmCommand(args, 180_000);
}

export async function downloadZyhxKdms(packIds: readonly string[]): Promise<ZyhxKdmDownloadResult> {
  const uniqueIds = [...new Set(packIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    throw new Error("请至少选择一个中影华夏密钥。");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "tms-zyhx-kdm-"));
  const downloaded: Array<ZyhxKdmDownloadResult["downloaded"][number]> = [];
  const failed: Array<ZyhxKdmDownloadResult["failed"][number]> = [];

  try {
    for (const id of uniqueIds) {
      try {
        const result = await runZyhxKdmCommand(["download", id, "--dir", tempDir], 300_000);
        const path = readDownloadedPath(result);
        const buffer = await readFile(path);
        const uploadResult = await saveUploadedKdms([{
          name: basename(path),
          content: buffer.toString("base64"),
          encoding: "base64",
        }]);
        await unlink(path).catch(() => undefined);
        downloaded.push({
          id,
          path,
          uploaded: uploadResult.uploaded,
          rejected: uploadResult.rejected,
        });
      } catch (error) {
        if (error instanceof ZyhxKdmLoginRequiredError) {
          throw error;
        }
        failed.push({
          id,
          error: error instanceof Error ? error.message : "下载失败。",
        });
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    downloaded,
    failed,
    assets: await listKdmAssets(),
  };
}

export async function loginZyhxKdms(): Promise<void> {
  if (loginInFlight) {
    return loginInFlight;
  }

  loginInFlight = loginZyhxKdmsOnce().finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

async function loginZyhxKdmsOnce(): Promise<void> {
  const account = await readZyhxKdmAccountConfig();
  if (!account?.username || !account.password) {
    throw new Error("请先在 设置 > 其它设置 中配置中影华夏账号和密码。");
  }

  const runtime = await resolveZyhxKdmRuntime();
  await loginZyhxKdm(runtime, account.username, account.password);
}

async function runZyhxKdmCommand(commandArgs: readonly string[], timeoutMs: number): Promise<unknown> {
  const { command, projectPath, scriptPath } = await resolveZyhxKdmRuntime();
  const args = [
    scriptPath,
    "--json",
    ...commandArgs,
  ];

  const { stdout, stderr, exitCode } = await runProcess(command, args, projectPath, timeoutMs);
  const payload = parseJsonOutput(stdout, stderr);
  if (exitCode === 0 && isRecord(payload) && payload.success === true) {
    return payload.result;
  }

  const firstError = readCommandError(payload, stderr, exitCode);
  if (looksLikeCookieExpired(firstError)) {
    throw new ZyhxKdmLoginRequiredError(firstError);
  }
  throw new Error(firstError);
}

async function resolveZyhxKdmRuntime(): Promise<{
  readonly command: string;
  readonly projectPath: string;
  readonly scriptPath: string;
}> {
  const projectPath = resolve(process.env.KDM_AUTO_DOWNLOAD_DIR || defaultCliProjectPath);
  const scriptPath = resolve(process.env.KDM_CLI_SCRIPT || join(projectPath, "dist", "cli.js"));
  await access(scriptPath).catch(() => {
    throw new Error(`未找到中影华夏密钥下载程序：${scriptPath}`);
  });

  return {
    command: process.env.KDM_CLI_COMMAND || process.execPath,
    projectPath,
    scriptPath,
  };
}

async function loginZyhxKdm(
  runtime: Awaited<ReturnType<typeof resolveZyhxKdmRuntime>>,
  username: string,
  password: string,
): Promise<void> {
  const { stdout, stderr, exitCode } = await runProcess(
    runtime.command,
    [runtime.scriptPath, "--json", "login", "--username", username, "--password", password],
    runtime.projectPath,
    300_000,
  );
  const payload = parseJsonOutput(stdout, stderr);
  if (exitCode !== 0 || !isRecord(payload) || payload.success !== true) {
    throw new Error(`中影华夏自动登录失败：${readCommandError(payload, stderr, exitCode)}`);
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        KDM_STATE_DIR: process.env.KDM_STATE_DIR || join(process.cwd(), ".tms", "kdm-auto-download"),
      },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("中影华夏密钥下载程序执行超时。"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveProcess({ stdout, stderr, exitCode });
    });
  });
}

function parseJsonOutput(stdout: string, stderr: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(stderr.trim() || "中影华夏下载程序未返回 JSON。");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(stderr.trim() || "中影华夏下载程序返回格式异常。");
  }
}

function readCommandError(payload: unknown, stderr: string, exitCode: number | null): string {
  return isRecord(payload) && typeof payload.error === "string"
    ? payload.error
    : stderr.trim() || `中影华夏下载程序退出：${exitCode}`;
}

function looksLikeCookieExpired(message: string): boolean {
  return /cookie|登录|未授权|unauthorized|401|403|session|凭据/i.test(message);
}

function appendCommonFilters(args: string[], options: ZyhxKdmListOptions): void {
  if (options.downloaded === 0 || options.downloaded === 1 || options.downloaded === 2) {
    args.push("--downloaded", String(options.downloaded));
  }
  if (options.pid) {
    args.push("--pid", options.pid);
  }
  if (options.category === 1 || options.category === 2) {
    args.push("--category", String(options.category));
  }
  if (options.term === 1 || options.term === 2 || options.term === 3) {
    args.push("--term", String(options.term));
  }
}

function readDownloadedPath(result: unknown): string {
  if (!isRecord(result) || typeof result.path !== "string" || !result.path) {
    throw new Error("中影华夏下载程序未返回文件路径。");
  }
  return result.path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
