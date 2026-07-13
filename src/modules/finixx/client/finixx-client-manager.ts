import { FinixxClient, type FinixxClientConfig } from "./finixx-client";

export class FinixxClientManager {
  private readonly clients = new Map<string, FinixxClient>();

  async upsertClient(config: FinixxClientConfig): Promise<FinixxClient> {
    const existing = this.clients.get(config.deviceId);
    if (existing) {
      return existing;
    }

    const client = await FinixxClient.create(config);
    this.clients.set(config.deviceId, client);
    return client;
  }

  getClient(deviceId: string): FinixxClient | undefined {
    return this.clients.get(deviceId);
  }

  getOrThrow(deviceId: string): FinixxClient {
    const client = this.clients.get(deviceId);
    if (!client) {
      throw new Error(`Unknown Finixx client: ${deviceId}`);
    }

    return client;
  }

  listClients(): FinixxClient[] {
    return [...this.clients.values()];
  }

  removeClient(deviceId: string): void {
    this.clients.delete(deviceId);
  }

  clear(): void {
    this.clients.clear();
  }
}
