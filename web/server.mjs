import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const preferredPort = Number(process.env.PORT || 4173);
const maxPortAttempts = 20;

const contentTypes = {
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

function resolvePath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://localhost:${preferredPort}`).pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const normalized = normalize(join(root, requested));

  if (!normalized.startsWith(root)) {
    return null;
  }

  return normalized;
}

const server = createServer(async (request, response) => {
  const filePath = resolvePath(request.url || "/");

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
});

function listen(port, attemptsLeft = maxPortAttempts) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0 && !process.env.PORT) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }

    console.error(`Unable to start TMS web UI on port ${port}: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, () => {
    console.log(`TMS web UI running at http://localhost:${port}`);
  });
}

listen(preferredPort);
