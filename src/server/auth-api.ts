import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateUser, deleteSession } from "./setup-store";
import { getActivityService } from "./activity-service";
import { readJsonBody, readRequiredString, sendJson } from "./http";
import { clearSessionCookie, readRequestSession, readSessionToken, setSessionCookie } from "./session";

export async function handleAuthApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/auth/me") {
    const session = await readRequestSession(request, true);
    if (!session) {
      sendJson(response, 200, { ok: true, authenticated: false });
      return true;
    }

    setSessionCookie(response, session.token);
    sendJson(response, 200, {
      ok: true,
      authenticated: true,
      user: { id: session.userId, username: session.username },
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJsonBody(request);
    const username = readRequiredString(body, "username");
    let session;
    try {
      session = await authenticateUser(username, readRequiredString(body, "password"));
      await getActivityService().create({
        actorType: "user",
        actorId: String(session.userId),
        actorName: session.username,
        action: "auth.login",
        objectType: "session",
        status: "success",
      }).catch(() => undefined);
    } catch (error) {
      await getActivityService().create({
        actorType: "user",
        actorName: username,
        action: "auth.login",
        objectType: "session",
        status: "error",
        resultMessage: error instanceof Error ? error.message : "登录失败。",
      }).catch(() => undefined);
      throw error;
    }
    setSessionCookie(response, session.token);
    sendJson(response, 200, {
      ok: true,
      user: { id: session.userId, username: session.username },
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const session = await readRequestSession(request, false);
    const token = readSessionToken(request);
    if (token) {
      await deleteSession(token);
    }
    if (session) {
      await getActivityService().create({
        actorType: "user",
        actorId: String(session.userId),
        actorName: session.username,
        action: "auth.logout",
        objectType: "session",
        status: "success",
      }).catch(() => undefined);
    }
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}
