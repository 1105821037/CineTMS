import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { handleAuthApi } from "./auth-api";
import { handleDcpApi } from "./dcp-api";
import { handleExternalNotificationApi } from "./external-notification-api";
import { handleFilmPlaybackApi } from "./film-playback-api";
import { handleFilmSchedulerApi } from "./film-scheduler-api";
import { handleFilmScheduleApi } from "./film-schedule-api";
import { getRepositoryFtpService } from "./ftp-service";
import { ApiError, sendJson } from "./http";
import { handleKdmApi } from "./kdm-api";
import { handleNotificationApi } from "./notification-api";
import { handleRuntimeApi } from "./runtime-api";
import { handleSetupApi } from "./setup-api";
import { handleSystemApi } from "./system-api";
import { handleUserApi } from "./user-api";
import { getRuntimeService } from "./runtime-service";
import { getRealtimeHub } from "./realtime-hub";
import { getFilmSchedulerEngine } from "./film-scheduler-engine";
import { getFilmScheduleAutoScheduler } from "./film-schedule-auto-scheduler";

const webRoot = join(process.cwd(), "web");
const preferredPort = Number(process.env.PORT || 4173);
const maxPortAttempts = 20;

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
};

const server = createServer(async (request, response) => {
  try {
    if (request.url?.startsWith("/api/")) {
      await handleApi(request, response);
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    const statusCode = error instanceof ApiError ? error.statusCode : 500;
    sendJson(response, statusCode, {
      ok: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

server.on("upgrade", (request, socket) => {
  void getRealtimeHub().handleUpgrade(request, socket).then((handled) => {
    if (!handled) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }).catch(() => {
    socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
});

async function handleApi(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://localhost:${preferredPort}`);
  const handled = await handleRuntimeApi(request, response, url.pathname)
    || await handleFilmSchedulerApi(request, response, url.pathname, url.searchParams)
    || await handleFilmScheduleApi(request, response, url.pathname, url.searchParams)
    || await handleFilmPlaybackApi(request, response, url.pathname, url.searchParams)
    || await handleExternalNotificationApi(request, response, url.pathname)
    || await handleNotificationApi(request, response, url.pathname, url.searchParams)
    || await handleDcpApi(request, response, url.pathname, url.searchParams)
    || await handleKdmApi(request, response, url.pathname)
    || await handleSetupApi(request, response, url.pathname)
    || await handleSystemApi(request, response, url.pathname)
    || await handleUserApi(request, response, url.pathname)
    || await handleAuthApi(request, response, url.pathname);

  if (!handled) {
    sendJson(response, 404, { ok: false, error: "API route not found" });
  }
}

async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const filePath = resolveStaticPath(request.url || "/");

  if (!filePath) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function resolveStaticPath(url: string): string | null {
  const pathname = decodeURIComponent(new URL(url, `http://localhost:${preferredPort}`).pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const normalized = normalize(join(webRoot, requested));

  if (!normalized.startsWith(webRoot)) {
    return null;
  }

  return normalized;
}

function listen(port: number, attemptsLeft = maxPortAttempts): void {
  const onError = (error: NodeJS.ErrnoException) => {
    server.off("listening", onListening);
    if (error.code === "EADDRINUSE" && attemptsLeft > 0 && !process.env.PORT) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }

    console.error(`Unable to start TMS web UI on port ${port}: ${error.message}`);
    process.exitCode = 1;
  };

  const onListening = () => {
    server.off("error", onError);
    console.log(`TMS web UI running at http://localhost:${port}`);
    void getRuntimeService().start().then(() => {
      getFilmSchedulerEngine().start();
      getFilmScheduleAutoScheduler().start();
      console.log("TMS film scheduler engine started");
      console.log("TMS film schedule auto scheduler started");
    }).catch((error) => {
      console.error("Failed to start runtime service:", error);
    });
    void getRepositoryFtpService().start().then(() => {
      const status = getRepositoryFtpService().getStatus();
      const endpointHost = status.passiveHost || "127.0.0.1";
      console.log(`TMS repository FTP running at ftp://${endpointHost}:${status.port} -> ${status.rootPath}`);
      if (status.message) {
        console.warn(`TMS repository FTP note: ${status.message}`);
      }
    }).catch((error) => {
      console.error("Failed to start repository FTP service:", error);
    });
  };

  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port);
}

function registerShutdownSignals(): void {
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down TMS services...`);
    server.close(() => {
      process.exit(0);
    });
    getRealtimeHub().close();
    getFilmSchedulerEngine().stop();
    getFilmScheduleAutoScheduler().stop();
    void Promise.allSettled([
      getRuntimeService().stop(),
      getRepositoryFtpService().stop(),
    ]).finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

registerShutdownSignals();
listen(preferredPort);
