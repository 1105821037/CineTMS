import type { IncomingMessage, ServerResponse } from "node:http";
import { changeUserPassword, createNewUser, deleteUser, listUsers, resetUserPassword } from "./setup-store";
import { readJsonBody, readRequiredString, sendJson } from "./http";
import { requireSession } from "./session";

export async function handleUserApi(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/users") {
    const session = await requireSession(request);
    const users = await listUsers();
    sendJson(response, 200, { ok: true, users, currentUserId: session.userId });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/users") {
    await requireSession(request);
    const body = await readJsonBody(request);
    const username = readRequiredString(body, "username");
    const password = readRequiredString(body, "password");
    const user = await createNewUser(username, password);
    sendJson(response, 200, { ok: true, user });
    return true;
  }

  const passwordMatch = pathname.match(/^\/api\/users\/(\d+)\/password$/);
  if (request.method === "POST" && passwordMatch) {
    const session = await requireSession(request);
    const targetUserId = Number(passwordMatch[1]);
    const body = await readJsonBody(request);
    const newPassword = readRequiredString(body, "newPassword");

    if (targetUserId === session.userId) {
      const oldPassword = readRequiredString(body, "oldPassword");
      await changeUserPassword(targetUserId, oldPassword, newPassword);
    } else {
      await resetUserPassword(targetUserId, newPassword);
    }

    sendJson(response, 200, { ok: true });
    return true;
  }

  const deleteMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (request.method === "DELETE" && deleteMatch) {
    const session = await requireSession(request);
    const targetUserId = Number(deleteMatch[1]);
    await deleteUser(targetUserId, session.userId);
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}
