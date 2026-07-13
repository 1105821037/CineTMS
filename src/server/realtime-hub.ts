import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { readRequestSession } from "./session";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface RealtimeMessage<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  readonly occurredAt: string;
}

interface RealtimeClient {
  readonly socket: Duplex;
  alive: boolean;
}

class RealtimeHub {
  private readonly clients = new Set<RealtimeClient>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  async handleUpgrade(request: IncomingMessage, socket: Duplex): Promise<boolean> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/api/realtime/ws") {
      return false;
    }

    const session = await readRequestSession(request, false);
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || !key.trim()) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }

    const accept = createHash("sha1")
      .update(`${key}${websocketGuid}`)
      .digest("base64");

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));

    const client: RealtimeClient = { socket, alive: true };
    this.clients.add(client);
    this.ensureHeartbeat();
    this.send(client, {
      type: "connected",
      payload: { ok: true, user: { id: session.userId, username: session.username } },
      occurredAt: new Date().toISOString(),
    });

    socket.on("data", (chunk) => this.handleClientFrame(client, Buffer.from(chunk)));
    socket.on("close", () => this.removeClient(client));
    socket.on("error", () => this.removeClient(client));
    socket.on("end", () => this.removeClient(client));
    return true;
  }

  broadcast<TPayload>(type: string, payload: TPayload): void {
    const message = {
      type,
      payload,
      occurredAt: new Date().toISOString(),
    };

    for (const client of this.clients) {
      this.send(client, message);
    }
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
  }

  private send(client: RealtimeClient, message: RealtimeMessage): void {
    if (!client.socket.writable) {
      this.removeClient(client);
      return;
    }

    try {
      client.socket.write(encodeTextFrame(JSON.stringify(message)));
    } catch {
      this.removeClient(client);
    }
  }

  private handleClientFrame(client: RealtimeClient, chunk: Buffer): void {
    const opcode = chunk[0] & 0x0f;
    if (opcode === 0x8) {
      this.removeClient(client);
      client.socket.end();
      return;
    }

    if (opcode === 0x9) {
      client.alive = true;
      client.socket.write(encodeControlFrame(0xA, Buffer.alloc(0)));
      return;
    }

    if (opcode === 0xA) {
      client.alive = true;
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          this.removeClient(client);
          client.socket.destroy();
          continue;
        }

        client.alive = false;
        client.socket.write(encodeControlFrame(0x9, Buffer.alloc(0)));
      }

      if (this.clients.size === 0 && this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  private removeClient(client: RealtimeClient): void {
    this.clients.delete(client);
  }
}

function encodeTextFrame(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text, "utf8"));
}

function encodeControlFrame(opcode: number, payload: Buffer): Buffer {
  return encodeFrame(opcode, payload);
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }

  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

let realtimeHubSingleton: RealtimeHub | null = null;

export function getRealtimeHub(): RealtimeHub {
  realtimeHubSingleton ??= new RealtimeHub();
  return realtimeHubSingleton;
}
