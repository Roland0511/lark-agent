import { loadWorkerConfig } from "./config.js";
import { ControlPlaneClient } from "./control-plane-client.js";
import { TaskProcessor } from "./processor.js";
import { errorMessage } from "../shared/errors.js";

const configFile = process.env.WORKER_CONFIG_FILE ?? "config/worker.local.yaml";
const config = await loadWorkerConfig(configFile);

if (process.argv.includes("--enrollment-json")) {
  const token = process.env.LARK_AGENT_ENROLLMENT_TOKEN;
  if (!token) throw new Error("LARK_AGENT_ENROLLMENT_TOKEN is required for enrollment payload generation");
  process.stdout.write(JSON.stringify({
    token,
    registration: {
      executorId: config.executorId,
      displayName: config.displayName,
      homeRef: config.homeRef,
      codexProfile: config.codexProfile,
      configFingerprint: config.configFingerprint,
      codexVersion: config.codexVersion,
      capacity: config.capacity,
      workspaceAliases: config.workspaceRoots.map((root) => root.alias),
      capabilities: config.capabilities,
      runnerVersion: config.runnerVersion,
      architecture: config.architecture,
      registrationSource: "quick_install"
    }
  }));
  process.exit(0);
}

const client = new ControlPlaneClient(config);
const processor = new TaskProcessor(config, client);
let stopping = false;
let configChanged = false;

await client.createSession();
await processor.start();
process.stdout.write(`worker ${config.executorId} ready home_ref=${config.homeRef} profile=${config.codexProfile}\n`);

const configTimer = setInterval(() => {
  void loadWorkerConfig(configFile).then((fresh) => {
    if (fresh.configFingerprint !== config.configFingerprint) {
      configChanged = true;
      process.stderr.write("worker configuration fingerprint changed; draining current task before restart\n");
    }
  }).catch((error) => process.stderr.write(`worker configuration recheck failed: ${errorMessage(error)}\n`));
}, 30_000);
configTimer.unref();

while (!stopping) {
  if (configChanged && !processor.isBusy()) break;
  try {
    const task = await client.claim();
    if (!task) continue;
    await processor.process(task);
  } catch (error) {
    process.stderr.write(`worker loop error: ${errorMessage(error)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(configTimer);
  await processor.stop();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

if (configChanged) {
  await shutdown();
  process.exitCode = 75;
}
