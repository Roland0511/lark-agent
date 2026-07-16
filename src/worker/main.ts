import { loadWorkerConfig } from "./config.js";
import { ControlPlaneClient } from "./control-plane-client.js";
import { TaskProcessor } from "./processor.js";
import { errorMessage } from "../shared/errors.js";

const enrollmentJson = process.argv.includes("--enrollment-json");

function startupLog(message: string): void {
  if (!enrollmentJson) process.stdout.write(`[startup] ${message}\n`);
}

const configFile = process.env.WORKER_CONFIG_FILE ?? "config/worker.local.yaml";
startupLog("configuration: loading");
const config = await loadWorkerConfig(configFile);
startupLog("configuration: ready");

if (enrollmentJson) {
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
      workspaceMappingFingerprint: config.workspaceMappingFingerprint,
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

startupLog("control-plane session: connecting");
await client.createSession();
startupLog("control-plane session: ready");
await processor.start();
startupLog("model catalog: loading");
const catalog = await processor.modelCatalog().catch((error) => {
  process.stderr.write(`worker model catalog unavailable: ${errorMessage(error)}\n`);
  return [];
});
await client.reportModelCatalog(catalog);
startupLog("model catalog: reported");
process.stdout.write(`worker ${config.executorId} ready home_ref=${config.homeRef} profile=${config.codexProfile}\n`);

const configTimer = setInterval(() => {
  void loadWorkerConfig(configFile).then((fresh) => {
    if (
      fresh.configFingerprint !== config.configFingerprint ||
      fresh.workspaceMappingFingerprint !== config.workspaceMappingFingerprint
    ) {
      configChanged = true;
      process.stderr.write("worker configuration fingerprint changed; draining current task before restart\n");
    }
  }).catch((error) => process.stderr.write(`worker configuration recheck failed: ${errorMessage(error)}\n`));
}, 30_000);
configTimer.unref();

while (!stopping) {
  if (configChanged && !processor.isBusy()) break;
  try {
    const workspaceSync = await client.claimWorkspaceRuntimeSync();
    if (workspaceSync) {
      await processor.processWorkspaceRuntimeSync(workspaceSync);
      continue;
    }
    const threadSnapshot = await client.claimThreadSnapshot();
    if (threadSnapshot) {
      await processor.processThreadSnapshot(threadSnapshot);
      continue;
    }
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
