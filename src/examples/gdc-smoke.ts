import { GdcClientManager } from "../modules/gdc";

async function main(): Promise<void> {
  const manager = new GdcClientManager();
  const client = manager.upsertClient({
    deviceId: "hall-1-gdc",
    auditoriumId: "hall-1",
    host: "172.16.67.241",
    requestTimeoutMs: 10_000,
  });

  const serverInfo = await client.getServerInfo();
  console.log(serverInfo);

  const serverSnapshot = await client.getServerSnapshot();
  console.log(serverSnapshot);

  const commands = await client.getSupportedCommands();
  console.log(`supported command count: ${commands.length}`);

  const shows = await client.getShowList();
  console.log(`show count: ${shows.length}`);

  await manager.disconnectAll();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
