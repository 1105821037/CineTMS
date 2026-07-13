import { hostname } from "node:os";
import { FinixxClient } from "../modules/finixx";

interface SharedFinixxClientEntry {
  readonly cacheKey: string;
  readonly client: Promise<FinixxClient>;
}

let ticketingClientEntry: SharedFinixxClientEntry | null = null;

export function getTicketingFinixxClient(config: {
  readonly baseUrl: string;
  readonly serviceUsername: string;
  readonly servicePassword: string;
  readonly serviceApiKey: string;
  readonly requestTimeoutMs?: number;
}): Promise<FinixxClient> {
  const normalizedConfig = {
    deviceId: "ticketing-shared",
    baseUrl: config.baseUrl.trim(),
    serviceUsername: config.serviceUsername,
    servicePassword: config.servicePassword,
    serviceApiKey: config.serviceApiKey,
    defaultWorkStationId: hostname(),
    requestTimeoutMs: config.requestTimeoutMs ?? 15_000,
  };
  const cacheKey = JSON.stringify(normalizedConfig);

  if (ticketingClientEntry?.cacheKey === cacheKey) {
    return ticketingClientEntry.client;
  }

  const client = FinixxClient.create(normalizedConfig).catch((error) => {
    if (ticketingClientEntry?.client === client) {
      ticketingClientEntry = null;
    }
    throw error;
  });
  ticketingClientEntry = { cacheKey, client };
  return client;
}

export function clearTicketingFinixxClient(): void {
  ticketingClientEntry = null;
}
