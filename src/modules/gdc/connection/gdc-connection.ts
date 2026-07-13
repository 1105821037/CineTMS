import { EventEmitter } from "node:events";
import net from "node:net";
import { DEFAULT_GDC_PORT } from "../protocol/constants";
import {
  GdcConnectionError,
  GdcTimeoutError,
} from "../protocol/errors";
import type { GdcResponseFrame } from "../protocol/types";
import { GdcResponseParser } from "../protocol/parser";
import { GdcRequestQueue } from "./request-queue";
import type { GdcConnectionState } from "./connection-state";

export interface GdcConnectionOptions {
  readonly host: string;
  readonly port?: number;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly resolve: (frame: GdcResponseFrame) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

export interface GdcConnectionEvents {
  state: (state: GdcConnectionState) => void;
  error: (error: Error) => void;
}

export class GdcConnection extends EventEmitter {
  private readonly parser = new GdcResponseParser();
  private readonly queue = new GdcRequestQueue();
  private socket: net.Socket | null = null;
  private pendingRequest: PendingRequest | null = null;
  private state: GdcConnectionState = "idle";

  constructor(private readonly options: GdcConnectionOptions) {
    super();
  }

  get currentState(): GdcConnectionState {
    return this.state;
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return;
    }

    this.setState(
      this.state === "disconnected" || this.state === "error" || this.state === "reconnecting"
        ? "reconnecting"
        : "connecting",
    );

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({
        host: this.options.host,
        port: this.options.port ?? DEFAULT_GDC_PORT,
      });

      let settled = false;
      const connectTimeoutMs = this.options.connectTimeoutMs ?? 10_000;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        reject(new GdcTimeoutError("GDC connection timed out"));
      }, connectTimeoutMs);

      socket.once("connect", () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        this.bindSocket(socket);
        this.setState("connected");
        resolve();
      });

      socket.once("error", (error) => {
        if (settled) {
          this.emit("error", error);
          return;
        }

        settled = true;
        clearTimeout(timeout);
        reject(new GdcConnectionError(error.message));
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      this.setState("disconnected");
      return;
    }

    this.setState("disconnecting");
    const socket = this.socket;
    this.socket = null;

    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.end();
    });
    this.parser.reset();
    this.rejectPending(new GdcConnectionError("GDC connection closed"));
    this.setState("disconnected");
  }

  async send(payload: Buffer): Promise<GdcResponseFrame> {
    return this.queue.enqueue(async () => {
      await this.connect();
      const socket = this.socket;
      if (!socket) {
        throw new GdcConnectionError("Socket unavailable after connect");
      }

      if (this.pendingRequest) {
        throw new GdcConnectionError("Another GDC request is still pending");
      }

      return new Promise<GdcResponseFrame>((resolve, reject) => {
        const requestTimeoutMs = this.options.requestTimeoutMs ?? 10_000;
        const timer = setTimeout(() => {
          const timeoutError = new GdcTimeoutError();
          this.pendingRequest = null;
          reject(timeoutError);
          if (this.socket && !this.socket.destroyed) {
            this.socket.destroy(timeoutError);
          }
        }, requestTimeoutMs);

        this.pendingRequest = {
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          timer,
        };

        socket.write(payload, (error) => {
          if (!error) {
            return;
          }

          const pending = this.pendingRequest;
          this.pendingRequest = null;
          pending?.reject(new GdcConnectionError(error.message));
        });
      });
    });
  }

  private bindSocket(socket: net.Socket): void {
    this.socket = socket;
    socket.setTimeout(0);

    socket.on("data", (chunk) => {
      try {
        const frames = this.parser.push(chunk);
        for (const frame of frames) {
          const pending = this.pendingRequest;
          this.pendingRequest = null;
          pending?.resolve(frame);
        }
      } catch (error) {
        const protocolError = error instanceof Error
          ? error
          : new GdcConnectionError("Unknown parser error");
        this.emit("error", protocolError);
        this.rejectPending(protocolError);
        socket.destroy(protocolError);
      }
    });

    socket.on("error", (error) => {
      this.setState("error");
      this.emit("error", error);
      this.rejectPending(new GdcConnectionError(error.message));
      if (!socket.destroyed) {
        socket.destroy();
      }
    });

    socket.on("close", () => {
      this.parser.reset();
      this.socket = null;
      if (this.state !== "disconnecting") {
        this.setState("disconnected");
      }
      this.rejectPending(new GdcConnectionError("GDC connection closed"));
    });
  }

  private rejectPending(error: Error): void {
    const pending = this.pendingRequest;
    this.pendingRequest = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private setState(state: GdcConnectionState): void {
    this.state = state;
    this.emit("state", state);
  }
}
