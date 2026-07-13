import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

export const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = process.env.KDM_STATE_DIR || BASE_DIR;
export const COOKIE_FILE = path.join(STATE_DIR, "cookies.json");
export const PASSCODE_FILE = path.join(STATE_DIR, "passcode.json");
export const DEFAULT_DOWNLOAD_DIR = path.join(STATE_DIR, "downloads");
export const CAPTCHA_SAMPLE_DIR = path.join(STATE_DIR, "captcha_samples");
export const WEB_ORIGIN = "https://www.zyhxjh.com";
export const CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export const YOLO_MODEL_FILE =
  process.env.KDM_YOLO_MODEL ||
  path.join(BASE_DIR, "best.onnx");

export const YOLO_CONF_THRESHOLD = Number(process.env.KDM_YOLO_CONF || "0.5");
export const YOLO_X_OFFSET = Number.parseInt(process.env.KDM_YOLO_X_OFFSET || "10", 10);

fs.mkdirSync(STATE_DIR, { recursive: true });

export function getChromeVersion(): string | null {
  const envVersion = process.env.KDM_CHROME_VERSION?.trim();
  if (envVersion) return envVersion;
  if (process.platform !== "win32" || !fs.existsSync(CHROME_EXE)) return null;

  try {
    const output = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${CHROME_EXE}').VersionInfo.ProductVersion`],
      { encoding: "utf8", timeout: 5000 }
    );
    return output.trim() || null;
  } catch {
    return null;
  }
}

export function getRealUserAgent(): string {
  const envUa = process.env.KDM_USER_AGENT?.trim();
  if (envUa) return envUa;
  const version = getChromeVersion();
  if (!version) return DEFAULT_USER_AGENT;
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
  );
}

export function chromeMajorFromUserAgent(userAgent: string): string {
  return userAgent.match(/Chrome\/(\d+)/)?.[1] || "138";
}

export function browserHeaders(
  accept = "application/json, text/plain, */*",
  contentType: string | null = "application/json"
): Record<string, string> {
  const userAgent = getRealUserAgent();
  const chromeMajor = chromeMajorFromUserAgent(userAgent);
  const platform = os.platform() === "win32" ? "Windows" : os.platform();
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: accept,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/console/key_mng2/`,
    "Sec-CH-UA": `"Not)A;Brand";v="8", "Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}"`,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"${platform}"`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site"
  };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

export function headlessEnabled(): boolean {
  return !["0", "false", "no", "off"].includes((process.env.KDM_HEADLESS || "1").trim().toLowerCase());
}
