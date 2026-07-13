import { GdcClientManager } from "../modules/gdc";
import {
  GdcHallCommandGateway,
  HallCommandService,
  HallRuntimePoller,
  HallRuntimeRegistry,
} from "../runtime";

async function main(): Promise<void> {
  const registry = new HallRuntimeRegistry();
  const clientManager = new GdcClientManager();
  const poller = new HallRuntimePoller(registry, clientManager);
  const gateway = new GdcHallCommandGateway(registry, clientManager);
  const commandService = new HallCommandService(registry, gateway);

  registry.upsertRuntime({
    hallId: "laser-1",
    deviceId: "laser-1-gdc",
    auditoriumId: "laser-1",
    host: "172.16.67.241",
    port: 49153,
    profile: "gdc",
  });

  const snapshot = await poller.pollHall("laser-1");
  console.log("RUNTIME_SNAPSHOT");
  console.log(JSON.stringify(snapshot, null, 2));

  console.log("RUNTIME_EVENTS");
  console.log(JSON.stringify(registry.listEvents({ hallIds: ["laser-1"] }), null, 2));

  console.log("COMMAND_SERVICE_READY");
  console.log(JSON.stringify({
    methods: [
      "ingestFile",
      "putSchedule",
      "playShow",
      "stopPlayback",
      "triggerAutomation",
    ],
    note: "Smoke test only verified poller and command wiring, no mutating command executed.",
  }, null, 2));

  void commandService;
  await clientManager.disconnectAll();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
