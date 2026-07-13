import fs from "node:fs";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { MessageChannel } from "node:worker_threads";
import {
  browserHeaders,
  COOKIE_FILE,
  DEFAULT_DOWNLOAD_DIR,
  PASSCODE_FILE,
  WEB_ORIGIN
} from "./config.js";
import { KdmApiError, KdmItem, SavedCookie } from "./types.js";
import { login } from "./login.js";
import { sleep } from "./utils.js";

type JsonValue = Record<string, any>;

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function loadCookies(cookieFile = COOKIE_FILE): SavedCookie[] {
  if (!fs.existsSync(cookieFile)) return [];
  return JSON.parse(fs.readFileSync(cookieFile, "utf8"));
}

export function clearCookies(cookieFile = COOKIE_FILE): boolean {
  if (!fs.existsSync(cookieFile)) return false;
  fs.rmSync(cookieFile);
  return true;
}

export function loadCachedPasscode(apiBase?: string): string | null {
  if (!fs.existsSync(PASSCODE_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(PASSCODE_FILE, "utf8"));
    if (apiBase && data.api_base !== apiBase) return null;
    return data.passcode || null;
  } catch {
    return null;
  }
}

export function saveCachedPasscode(passcode: string, apiBase?: string): void {
  fs.writeFileSync(
    PASSCODE_FILE,
    JSON.stringify(
      {
        api_base: apiBase,
        passcode,
        saved_at: new Date().toISOString().slice(0, 19)
      },
      null,
      2
    ),
    "utf8"
  );
}

export function clearCachedPasscode(): boolean {
  if (!fs.existsSync(PASSCODE_FILE)) return false;
  fs.rmSync(PASSCODE_FILE);
  return true;
}

export class KdmSession {
  cookies: SavedCookie[];
  headers: Record<string, string>;

  constructor(cookies: SavedCookie[]) {
    if (!cookies.length) throw new KdmApiError(`未找到可用Cookie，请先登录: ${COOKIE_FILE}`);
    this.cookies = cookies;
    this.headers = browserHeaders();
  }

  cookieHeader(): string {
    return this.cookies
      .filter((cookie) => cookie.name && cookie.value !== undefined)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  async request(url: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers({
      ...this.headers,
      Cookie: this.cookieHeader(),
      ...(options.headers as Record<string, string> | undefined)
    });
    return fetch(url, { ...options, headers });
  }

  async getJson(url: string, timeoutMs = 20000): Promise<any> {
    const response = await this.requestWithTimeout(url, { method: "GET" }, timeoutMs);
    return response.json();
  }

  async postJson(url: string, body: unknown, timeoutMs = 20000): Promise<any> {
    const response = await this.requestWithTimeout(
      url,
      { method: "POST", body: JSON.stringify(body) },
      timeoutMs
    );
    return response.json();
  }

  async requestWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.request(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new KdmApiError(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      return response;
    } catch (error) {
      if (error instanceof KdmApiError) throw error;
      throw new KdmApiError(`请求中影华夏接口失败：${url}；${describeFetchFailure(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function describeFetchFailure(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "请求超时";
  }
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    const parts = [
      typeof record.code === "string" ? `code=${record.code}` : "",
      typeof record.errno === "number" ? `errno=${record.errno}` : "",
      typeof record.syscall === "string" ? `syscall=${record.syscall}` : "",
      typeof record.hostname === "string" ? `hostname=${record.hostname}` : "",
      typeof record.address === "string" ? `address=${record.address}` : "",
      typeof record.port === "number" ? `port=${record.port}` : "",
    ].filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return error instanceof Error ? error.message : String(error);
}

export function createSession(cookieFile = COOKIE_FILE): KdmSession {
  return new KdmSession(loadCookies(cookieFile));
}

export function parseApiResult(data: JsonValue): any {
  if (data.status !== 200) throw new KdmApiError(`接口返回异常: ${JSON.stringify(data)}`);
  return data.result;
}

export async function getApiBase(session: KdmSession): Promise<string> {
  const siteinfo = await session.getJson(`${WEB_ORIGIN}/siteinfo`);
  if (!siteinfo.api) throw new KdmApiError(`siteinfo缺少api字段: ${JSON.stringify(siteinfo)}`);
  return `https://${siteinfo.api}`;
}

export async function doBrowserLogin(
  username?: string,
  password?: string,
  quiet = false,
  useSavedCookies = false
): Promise<boolean> {
  if (!username || !password) throw new KdmApiError("登录需要传入 --username 和 --password");
  const browser = await login({ username, password, useSavedCookies, quiet });
  if (!browser) return false;
  const closed = await Promise.race([
    browser.quit(),
    sleep(8000).then(() => false)
  ]);
  if (closed === false) {
    console.error("浏览器登录已成功，但关闭浏览器超时，继续返回登录成功。");
  }
  return true;
}

export async function getSession(options: {
  autoLogin?: boolean;
  username?: string;
  password?: string;
  quiet?: boolean;
}): Promise<{ session: KdmSession; apiBase: string; user: any }> {
  const quiet = Boolean(options.quiet);
  if (!fs.existsSync(COOKIE_FILE)) {
    if (!options.autoLogin || !(await doBrowserLogin(options.username, options.password, quiet))) {
      throw new KdmApiError("无Cookie且自动登录失败");
    }
  }

  const session = createSession();
  const apiBase = await getApiBase(session);
  return { session, apiBase, user: null };
}

export async function getCurrentUser(session: KdmSession, apiBase?: string): Promise<any> {
  const base = apiBase || (await getApiBase(session));
  return parseApiResult(await session.getJson(`${base}/user/info_my_account`));
}

export async function getHeadform(session: KdmSession, apiBase?: string, filters?: JsonValue): Promise<any> {
  const base = apiBase || (await getApiBase(session));
  return parseApiResult(await session.postJson(`${base}/kdm/search_cinema_cert_headform`, filters || {}));
}

export async function getHeadformOptions(session: KdmSession, apiBase?: string): Promise<Record<string, any[]>> {
  const result = await getHeadform(session, apiBase);
  return Object.fromEntries((result.form || []).map((item: any) => [item.key, item.items || []]));
}

export function buildListPayload(options: {
  page?: number;
  pagesize?: number;
  downloaded?: number;
  pid?: string;
  category?: number;
  term?: number;
  extraFilters?: JsonValue;
}): JsonValue {
  const payload: JsonValue = {
    page: Number(options.page || 1),
    pagesize: Number(options.pagesize || 20)
  };
  if (options.downloaded !== undefined) payload.downloaded = Number(options.downloaded);
  if (options.pid) payload.pid = options.pid;
  if (options.category !== undefined) payload.category = Number(options.category);
  if (options.term !== undefined) payload.term = Number(options.term);
  if (options.extraFilters) Object.assign(payload, options.extraFilters);
  return payload;
}

export async function listKdm(
  session: KdmSession,
  apiBase: string,
  options: Parameters<typeof buildListPayload>[0]
): Promise<any> {
  return parseApiResult(
    await session.postJson(`${apiBase}/kdm/search_cinema_cert_download`, buildListPayload(options), 30000)
  );
}

export function kdmItemMatches(item: KdmItem, keyword: string): boolean {
  const key = String(keyword).toLowerCase();
  const mainPid = item.main_pid || {};
  const fields = [
    item.id,
    item.batch_name,
    item.task_name,
    item.issue_pid,
    mainPid.pid,
    mainPid.name,
    mainPid.movie_name
  ];
  return fields.map((value) => String(value || "").toLowerCase()).join(" ").includes(key);
}

export async function getAllKdm(
  session: KdmSession,
  apiBase: string,
  options: {
    downloaded?: number;
    pid?: string;
    category?: number;
    term?: number;
    keyword?: string;
    pagesize?: number;
    maxPages?: number;
  }
): Promise<KdmItem[]> {
  const items: KdmItem[] = [];
  let page = 1;
  const pagesize = Number(options.pagesize || 100);
  while (true) {
    const result = await listKdm(session, apiBase, { ...options, page, pagesize });
    for (const row of result.data || []) {
      if (!options.keyword || kdmItemMatches(row, options.keyword)) items.push(row);
    }
    const pageinfo = result.pageinfo || {};
    const lastPage = Number(pageinfo.last || pageinfo.pages || page);
    if (page >= lastPage) break;
    if (options.maxPages && page >= options.maxPages) break;
    page += 1;
  }
  return items;
}

export async function searchKdm(
  session: KdmSession,
  apiBase: string,
  keyword?: string,
  filters: Record<string, any> = {}
): Promise<KdmItem[]> {
  return getAllKdm(session, apiBase, { ...filters, keyword });
}

export async function getPasscode(
  session: KdmSession,
  apiBase: string,
  options: { wyCaptcha?: string; passcode?: string; useCache?: boolean } = {}
): Promise<string> {
  if ((options.useCache ?? true) && !options.wyCaptcha && !options.passcode) {
    const cached = loadCachedPasscode(apiBase);
    if (cached) return cached;
  }

  const payload: JsonValue = {};
  if (options.wyCaptcha) payload.wy_captcha = options.wyCaptcha;
  if (options.passcode) payload.passcode = options.passcode;
  const result = parseApiResult(await session.postJson(`${apiBase}/riskcc/get_pass`, payload));

  if (result.result && result.passcode) {
    saveCachedPasscode(result.passcode, apiBase);
    return result.passcode;
  }

  if (result.showdialog === 30 && result.passcode && !options.passcode) {
    return getPasscode(session, apiBase, { passcode: result.passcode, useCache: false });
  }

  throw new KdmApiError(`风控未通过或需要人工处理: ${JSON.stringify(result)}`);
}

export async function getDownloadLink(
  session: KdmSession,
  packId: string,
  apiBase: string,
  options: { passcode?: string; includeAuth?: boolean } = {}
): Promise<JsonValue> {
  const passcode = options.passcode || (await getPasscode(session, apiBase));
  const url = `${apiBase}/play/kdmstorage_download?packid=${packId}&passcode=${passcode}`;
  const result: JsonValue = { url, passcode };
  if (options.includeAuth ?? true) {
    result.headers = browserHeaders("*/*", null);
    result.cookies = session.cookieHeader();
  }
  return result;
}

export function filenameFromContentDisposition(contentDisposition: string | null, fallback: string): string {
  if (!contentDisposition) return fallback;
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1]);
  const quotedMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (quotedMatch) {
    try {
      return decodeURIComponent(quotedMatch[1]);
    } catch {
      return quotedMatch[1];
    }
  }
  return fallback;
}

export function safeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]+/g, "_").trim() || "kdm.zip";
}

export async function downloadKdm(
  session: KdmSession,
  packId: string,
  apiBase: string,
  options: { passcode?: string; saveDir?: string; filename?: string } = {}
): Promise<string> {
  const explicitPasscode = options.passcode !== undefined;
  let passcode = options.passcode;
  let response: Response | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const link = await getDownloadLink(session, packId, apiBase, { passcode, includeAuth: false });
    response = await session.requestWithTimeout(link.url, { method: "GET" }, 60000);
    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) break;

    const data = await response.json();
    if (explicitPasscode || attempt === 1) throw new KdmApiError(`下载接口返回JSON异常: ${JSON.stringify(data)}`);
    clearCachedPasscode();
    passcode = undefined;
  }

  if (!response || !response.body) throw new KdmApiError("下载响应为空");
  const saveDir =
    options.saveDir || path.join(DEFAULT_DOWNLOAD_DIR, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(saveDir, { recursive: true });
  const filename =
    options.filename ||
    filenameFromContentDisposition(response.headers.get("Content-Disposition"), `${packId}.zip`);
  const filepath = path.join(saveDir, safeFilename(filename));
  await pipeline(response.body as any, createWriteStream(filepath));
  return filepath;
}

export async function downloadMany(
  session: KdmSession,
  apiBase: string,
  options: {
    saveDir?: string;
    downloaded?: number;
    pid?: string;
    category?: number;
    term?: number;
    keyword?: string;
    limit?: number;
  }
): Promise<any[]> {
  const passcode = await getPasscode(session, apiBase);
  let items = await getAllKdm(session, apiBase, {
    downloaded: options.downloaded ?? 0,
    pid: options.pid,
    category: options.category,
    term: options.term,
    keyword: options.keyword
  });
  if (options.limit) items = items.slice(0, Number(options.limit));

  const files = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const filepath = await downloadKdm(session, String(item.id), apiBase, {
      passcode,
      saveDir: options.saveDir
    });
    files.push({ index: index + 1, id: item.id, path: filepath, item: compactItem(item) });
    await sleep(300);
  }
  return files;
}

export function downloadedLabel(value: any): string {
  if (value === 0) return "未下载";
  if (Number.isInteger(value) && value > 0) return "已下载";
  return String(value);
}

export function compactItem(item: KdmItem): JsonValue {
  const mainPid = item.main_pid || {};
  return {
    id: item.id,
    downloaded: item.downloaded,
    downloaded_label: downloadedLabel(item.downloaded),
    pid: mainPid.pid,
    movie_name: mainPid.movie_name || mainPid.name,
    batch_name: item.batch_name,
    task_name: item.task_name,
    not_valid_before: item.not_valid_before,
    not_valid_after: item.not_valid_after
  };
}

// Keeps TS from downleveling Response.body types oddly on older lib combinations.
void MessageChannel;
