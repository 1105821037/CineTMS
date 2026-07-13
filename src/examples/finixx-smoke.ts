import { hostname } from "node:os";
import { FinixxClientManager } from "../modules/finixx";

async function main(): Promise<void> {
  const manager = new FinixxClientManager();
  const client = await manager.upsertClient({
    deviceId: "finixx-bo",
    baseUrl: "http://172.16.67.220:29955",
    serviceUsername: requiredEnv("FINIXX_SERVICE_USERNAME"),
    servicePassword: requiredEnv("FINIXX_SERVICE_PASSWORD"),
    serviceApiKey: requiredEnv("FINIXX_SERVICE_API_KEY"),
    defaultWorkStationId: hostname(),
    requestTimeoutMs: 15_000,
  });

  const response = client.getSystemSettings();

  console.log("Finixx init result:", response.result);
  console.log("Cinema:", response.workStationInfo?.LocationName);
  console.log("Resolved location:", client.initializationContext?.resolvedLocationCd);
  console.log("MQ host:", response.mqConfigInfo?.hostName);
  console.log("Hall count:", response.hallsInfo?.halls?.length ?? 0);

  const schedule = await client.getScheduleWithFilms({
    showDate: new Date().toISOString().slice(0, 10),
  });

  console.log("Schedule film codes:", schedule.filmCds);
  console.log("Resolved film detail count:", Object.keys(schedule.filmsByCode).length);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
