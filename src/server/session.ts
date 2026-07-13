import type { IncomingMessage, ServerResponse } from "node:http";
import { readSession, type AuthSession } from "./setup-store";
import { ApiError } from "./http";

export async function readRequestSession(request: IncomingMessage, renew: boolean) {
  const token = readSessionToken(request);
  if (!token) {
    return null;
  }
  try {
    return await readSession(token, renew);
  } catch (error) {
    console.error("Failed to read auth session:", error);
    throw new ApiError(503, "登录状态读取失败，请稍后重试。");
  }
}

export async function requireSession(request: IncomingMessage): Promise<AuthSession> {
  const session = await readRequestSession(request, true);
  if (!session) {
    throw new ApiError(401, "请先登录系统账号。");
  }
  return session;
}

export function readSessionToken(request: IncomingMessage): string | null {
  const cookie = request.headers.cookie;
  if (!cookie) {
    return null;
  }
  const cookies = Object.fromEntries(
    cookie.split(";").map((part) => {
      const [key, ...value] = part.trim().split("=");
      return [key, decodeURIComponent(value.join("="))];
    }),
  );
  return cookies.tms_session || null;
}

export function setSessionCookie(response: ServerResponse, token: string): void {
  response.setHeader(
    "Set-Cookie",
    `tms_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`,
  );
}

export function clearSessionCookie(response: ServerResponse): void {
  response.setHeader("Set-Cookie", "tms_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}
