import { GdcClient, type GdcClientConfig } from "./gdc-client";

export class GdcClientManager {
  private readonly clients = new Map<string, GdcClient>();

  upsertClient(config: GdcClientConfig): GdcClient {
    const existing = this.clients.get(config.deviceId);
    if (existing) {
      if (this.hasSameConfig(existing.config, config)) {
        return existing;
      }

      this.clients.delete(config.deviceId);
      void existing.disconnect().catch((error) => {
        console.warn(`[GDC] failed to disconnect stale client ${config.deviceId}:`, error);
      });
    }

    const client = new GdcClient(config);
    client.on("error", (error) => {
      console.warn(
        `[GDC] client ${config.deviceId} (${config.host}:${config.port ?? 43728}) error:`,
        error,
      );
    });
    this.clients.set(config.deviceId, client);
    return client;
  }

  private hasSameConfig(current: GdcClientConfig, next: GdcClientConfig): boolean {
    return (
      current.deviceId === next.deviceId
      && current.auditoriumId === next.auditoriumId
      && current.host === next.host
      && (current.port ?? 43728) === (next.port ?? 43728)
      && (current.connectTimeoutMs ?? 10_000) === (next.connectTimeoutMs ?? 10_000)
      && (current.requestTimeoutMs ?? 10_000) === (next.requestTimeoutMs ?? 10_000)
    );
  }

  getClient(deviceId: string): GdcClient | undefined {
    return this.clients.get(deviceId);
  }

  getOrThrow(deviceId: string): GdcClient {
    const client = this.clients.get(deviceId);
    if (!client) {
      throw new Error(`Unknown GDC client: ${deviceId}`);
    }

    return client;
  }

  listClients(): GdcClient[] {
    return [...this.clients.values()];
  }

  async removeClient(deviceId: string): Promise<void> {
    const client = this.clients.get(deviceId);
    if (!client) {
      return;
    }

    await client.disconnect();
    this.clients.delete(deviceId);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(this.listClients().map((client) => client.disconnect()));
  }

  async heartbeatAll(): Promise<Array<{ deviceId: string; ok: boolean; error?: string }>> {
    return Promise.all(
      this.listClients().map(async (client) => {
        try {
          await client.heartbeat();
          return { deviceId: client.deviceId, ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { deviceId: client.deviceId, ok: false, error: message };
        }
      }),
    );
  }
}
