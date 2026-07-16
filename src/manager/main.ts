import { execFile } from "node:child_process";
import { chmod, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { CodexAdapter } from "../worker/codex-adapter.js";
import { loadWorkerConfig } from "../worker/config.js";
import { isolatedCodexEnvironment } from "../worker/skills.js";
import { resolveChatWorkspace } from "../worker/workspace.js";

const runFile = promisify(execFile);
const pollMs = 2_000;
const drainTimeoutMs = 10 * 60_000;

interface ManagerConfig {
  controlPlaneUrl: string;
  deviceToken: string;
  executorId: string;
  codexHome: string;
  activeProfile: string;
}

interface ClaimedCommand {
  id: string;
  type: "status" | "start" | "stop" | "restart" | "logs" | "switch_profile";
  parameters: Record<string, unknown>;
  leaseToken: string;
  migrationId: string | null;
}

interface PreparedContext {
  chatContextId: string;
  botAppId: string;
  workspaceRootAlias: string | null;
  sourceThreadId: string;
  summary: string;
}

class ProfileSwitchExecutionError extends Error {
  constructor(message: string, readonly rollbackSucceeded: boolean) { super(message); }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`device manager environment is missing ${name}`);
  return value;
}

const configFile = requiredEnvironment("WORKER_CONFIG_FILE");
const workerLabel = requiredEnvironment("WORKER_LAUNCHD_LABEL");
const workerPlist = requiredEnvironment("WORKER_PLIST_PATH");
const logDir = requiredEnvironment("WORKER_LOG_DIR");
const managerVersion = process.env.RUNNER_MANAGER_VERSION ?? "development";
const uid = process.getuid?.();
if (uid === undefined) throw new Error("device manager requires a Unix user id");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readManagerConfig(): Promise<ManagerConfig> {
  const raw = parseYaml(await readFile(configFile, "utf8")) as Record<string, Record<string, unknown>>;
  const control = raw.control_plane ?? {};
  const executor = raw.executor ?? {};
  const tokenPath = String(control.device_token_file ?? "");
  if (!tokenPath) throw new Error("device manager requires control_plane.device_token_file");
  return {
    controlPlaneUrl: String(control.url ?? "").replace(/\/$/, ""),
    deviceToken: (await readFile(tokenPath, "utf8")).trim(),
    executorId: String(executor.id ?? ""),
    codexHome: String(executor.codex_home ?? ""),
    activeProfile: String(executor.codex_profile ?? "")
  };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const config = await readManagerConfig();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${config.deviceToken}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${config.controlPlaneUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok && response.status !== 204) {
    const body = await response.text().catch(() => "");
    throw new Error(`control plane ${response.status}: ${body.slice(0, 1_000)}`);
  }
  return response;
}

async function commandApi(command: ClaimedCommand, suffix: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const config = await readManagerConfig();
  const response = await api(`/v1/runner/device-manager/${encodeURIComponent(config.executorId)}/commands/${command.id}${suffix}`, {
    method: "POST",
    body: JSON.stringify({ leaseToken: command.leaseToken, ...body })
  });
  return response.status === 204 ? {} : await response.json() as Record<string, unknown>;
}

async function completeCommand(command: ClaimedCommand, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await commandApi(command, "/complete", body); }
    catch (error) { lastError = error; if (attempt < 3) await sleep(500 * attempt); }
  }
  throw lastError;
}

async function recordProfileContext(command: ClaimedCommand, body: Record<string, unknown>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await commandApi(command, "/profile-context", body);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

async function serviceLoaded(): Promise<boolean> {
  try {
    await runFile("/bin/launchctl", ["print", `gui/${uid}/${workerLabel}`]);
    return true;
  } catch { return false; }
}

async function serviceDisabled(): Promise<boolean> {
  try {
    const { stdout } = await runFile("/bin/launchctl", ["print-disabled", `gui/${uid}`]);
    return new RegExp(`"${workerLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=>\\s*(?:true|disabled)`).test(stdout);
  } catch { return false; }
}

async function localState(): Promise<"running" | "stopped" | "not_loaded"> {
  if (await serviceLoaded()) return "running";
  return await serviceDisabled() ? "stopped" : "not_loaded";
}

async function startWorker(): Promise<void> {
  await runFile("/bin/launchctl", ["enable", `gui/${uid}/${workerLabel}`]);
  if (!await serviceLoaded()) await runFile("/bin/launchctl", ["bootstrap", `gui/${uid}`, workerPlist]);
  await runFile("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${workerLabel}`]);
}

async function bootoutWorker(persistentlyDisable: boolean): Promise<void> {
  if (persistentlyDisable) await runFile("/bin/launchctl", ["disable", `gui/${uid}/${workerLabel}`]);
  if (await serviceLoaded()) await runFile("/bin/launchctl", ["bootout", `gui/${uid}`, workerPlist]).catch(() => undefined);
}

async function restartWorker(): Promise<void> {
  await bootoutWorker(false);
  await startWorker();
}

async function scanProfiles(config: ManagerConfig) {
  const baseText = await readFile(join(config.codexHome, "config.toml"), "utf8").catch(() => "");
  const base = baseText ? parseToml(baseText) as Record<string, unknown> : {};
  const names = (await readdir(config.codexHome)).filter((name) => /^[A-Za-z0-9_-]+\.config\.toml$/.test(name));
  const profiles = await Promise.all(names.map(async (file) => {
    const path = join(config.codexHome, file);
    const profile = parseToml(await readFile(path, "utf8")) as Record<string, unknown>;
    return {
      name: file.slice(0, -".config.toml".length),
      model: typeof profile.model === "string" ? profile.model : typeof base.model === "string" ? base.model : null,
      modelProvider: typeof profile.model_provider === "string" ? profile.model_provider : typeof base.model_provider === "string" ? base.model_provider : null,
      modifiedAt: (await stat(path)).mtime.toISOString()
    };
  }));
  return profiles.sort((left, right) => left.name.localeCompare(right.name));
}

async function heartbeatManager(): Promise<void> {
  const config = await readManagerConfig();
  await api(`/v1/runner/device-manager/${encodeURIComponent(config.executorId)}/heartbeat`, {
    method: "PUT",
    body: JSON.stringify({
      version: managerVersion,
      profiles: await scanProfiles(config),
      localState: await localState(),
      activeProfile: config.activeProfile
    })
  });
}

async function claim(): Promise<ClaimedCommand | null> {
  const config = await readManagerConfig();
  const response = await api(`/v1/runner/device-manager/${encodeURIComponent(config.executorId)}/commands/claim`, { method: "POST" });
  if (response.status === 204) return null;
  return await response.json() as ClaimedCommand;
}

async function runnerStatus(): Promise<Record<string, unknown>> {
  const config = await readManagerConfig();
  const response = await api(`/v1/runner/status/${encodeURIComponent(config.executorId)}`);
  return await response.json() as Record<string, unknown>;
}

async function waitDrained(): Promise<void> {
  const deadline = Date.now() + drainTimeoutMs;
  while (Date.now() < deadline) {
    const status = await runnerStatus();
    if (Number(status.activeTasks ?? 0) === 0 && Number(status.activeRuntimeSyncJobs ?? 0) === 0
      && Number(status.activeThreadSnapshotJobs ?? 0) === 0) return;
    await sleep(pollMs);
  }
  throw new Error("等待活跃任务、技能同步和 Thread 快照排空超过 10 分钟");
}

async function waitOnline(profile?: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await runnerStatus().catch(() => null);
    if (status?.online === true && (!profile || status.codexProfile === profile)) return;
    await sleep(1_000);
  }
  throw new Error(profile ? `Worker 未在 60 秒内以 Profile ${profile} 上线` : "Worker 未在 60 秒内上线");
}

function redactLogs(value: string, token: string): string {
  return value
    .split(token).join("[REDACTED DEVICE CREDENTIAL]")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]");
}

async function readLogs(lines: number): Promise<{ lines: number; content: string }> {
  const config = await readManagerConfig();
  const files = ["worker.log", "worker.err.log", "manager.log", "manager.err.log"];
  const output: string[] = [];
  for (const file of files) {
    const content = await readFile(join(logDir, file), "utf8").catch(() => "");
    if (!content) continue;
    output.push(`== ${file} ==`, ...content.split(/\r?\n/).slice(-lines));
  }
  return { lines, content: redactLogs(output.join("\n").slice(-200_000), config.deviceToken) };
}

async function replaceProfile(targetProfile: string): Promise<string> {
  const original = await readFile(configFile, "utf8");
  const targetPath = join((await readManagerConfig()).codexHome, `${targetProfile}.config.toml`);
  await stat(targetPath);
  const replacement = original.replace(/^(\s*codex_profile:\s*)(['"]?)[A-Za-z0-9_-]+\2\s*$/mu, `$1'${targetProfile}'`);
  if (replacement === original) throw new Error("config.yaml 中没有可替换的 executor.codex_profile");
  const temporary = join(dirname(configFile), `.${basename(configFile)}.${process.pid}.tmp`);
  await writeFile(temporary, replacement, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, configFile);
  return original;
}

async function restoreConfig(original: string): Promise<void> {
  const temporary = join(dirname(configFile), `.${basename(configFile)}.${process.pid}.rollback.tmp`);
  await writeFile(temporary, original, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, configFile);
}

async function prepareContexts(command: ClaimedCommand): Promise<PreparedContext[]> {
  const deadline = Date.now() + drainTimeoutMs;
  while (Date.now() < deadline) {
    const response = await commandApi(command, "/profile-prepare");
    if (response.state === "ready") return Array.isArray(response.contexts) ? response.contexts as PreparedContext[] : [];
    await sleep(pollMs);
  }
  throw new Error("等待 Profile 迁移快照超过 10 分钟");
}

async function switchProfile(command: ClaimedCommand): Promise<Record<string, unknown>> {
  const targetProfile = String(command.parameters.targetProfile ?? "");
  if (!/^[A-Za-z0-9_-]+$/.test(targetProfile)) throw new Error("目标 Profile 无效");
  await waitDrained();
  const contexts = await prepareContexts(command);
  await waitDrained();
  const source = await readManagerConfig();
  const original = await replaceProfile(targetProfile);
  let mutated = true;
  let adapter: CodexAdapter | null = null;
  try {
    await bootoutWorker(false);
    const target = await loadWorkerConfig(configFile);
    const isolated = isolatedCodexEnvironment({}, [], target.deviceTokenEnvironmentName ? [target.deviceTokenEnvironmentName] : []);
    adapter = new CodexAdapter(target, async () => "decline", undefined, undefined, undefined, {
      environment: isolated.environment,
      shellEnvironmentAllowlist: isolated.allowlist
    });
    await adapter.start();
    const mappings: Array<{ chatContextId: string; targetThreadId: string; migrationSummary: string }> = [];
    for (const context of contexts) {
      const workspace = await resolveChatWorkspace(
        target.workspaceRoots,
        context.workspaceRootAlias,
        context.botAppId,
        context.chatContextId,
        context.chatContextId
      );
      const summary = await adapter.summarizeMigrationContext(workspace.path, context.summary, {
        model: target.profileModel,
        effort: target.profileReasoningEffort
      });
      const importedContext = [
        "# 自动导入的旧会话上下文",
        `来源 Thread：${context.sourceThreadId}`,
        `迁移时间：${new Date().toISOString()}`,
        "",
        summary
      ].join("\n");
      const targetThreadId = await adapter.startImportedThread(workspace.path, importedContext, target.profileModel);
      await recordProfileContext(command, {
        chatContextId: context.chatContextId,
        targetThreadId,
        migrationSummary: summary
      });
      mappings.push({ chatContextId: context.chatContextId, targetThreadId, migrationSummary: summary });
    }
    await adapter.stop();
    adapter = null;
    await startWorker();
    await waitOnline(targetProfile);
    await completeCommand(command, {
      result: { profile: targetProfile, migratedContexts: mappings.length },
      targetProfile,
      targetConfigFingerprint: target.configFingerprint,
      targetCodexVersion: target.codexVersion,
      targetHomeRef: target.homeRef,
      targetWorkspaceMappingFingerprint: target.workspaceMappingFingerprint,
      contexts: mappings
    });
    mutated = false;
    return { profile: targetProfile, migratedContexts: mappings.length };
  } catch (error) {
    await adapter?.stop().catch(() => undefined);
    let rollbackSucceeded = true;
    if (mutated) {
      try {
        await bootoutWorker(false).catch(() => undefined);
        await restoreConfig(original);
        await startWorker();
        await waitOnline(source.activeProfile);
      } catch (rollbackError) {
        rollbackSucceeded = false;
        process.stderr.write(`profile rollback failed: ${errorMessage(rollbackError)}\n`);
      }
    }
    throw new ProfileSwitchExecutionError(errorMessage(error), rollbackSucceeded);
  }
}

async function execute(command: ClaimedCommand): Promise<void> {
  const heartbeat = setInterval(() => {
    void commandApi(command, "/heartbeat").catch((error) => process.stderr.write(`command heartbeat failed: ${errorMessage(error)}\n`));
  }, 20_000);
  heartbeat.unref();
  try {
    let result: Record<string, unknown>;
    switch (command.type) {
      case "status":
        result = { localState: await localState(), ...(await runnerStatus()) };
        break;
      case "start":
        await startWorker();
        await waitOnline();
        result = { localState: await localState() };
        break;
      case "stop":
        await waitDrained();
        await bootoutWorker(true);
        result = { localState: await localState() };
        break;
      case "restart":
        await waitDrained();
        await restartWorker();
        await waitOnline();
        result = { localState: await localState() };
        break;
      case "logs":
        result = await readLogs(Math.min(Math.max(Number(command.parameters.lines ?? 200), 1), 500));
        break;
      case "switch_profile":
        result = await switchProfile(command);
        return;
    }
    await completeCommand(command, { result });
  } catch (error) {
    const message = errorMessage(error).slice(0, 2_000);
    const rollbackSucceeded = error instanceof ProfileSwitchExecutionError ? error.rollbackSucceeded : true;
    await commandApi(command, "/fail", { error: message, rollbackSucceeded }).catch((reportError) => {
      process.stderr.write(`command failure report failed: ${errorMessage(reportError)}\n`);
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function main(): Promise<void> {
  let lastHeartbeat = 0;
  for (;;) {
    try {
      if (Date.now() - lastHeartbeat >= 15_000) {
        await heartbeatManager();
        lastHeartbeat = Date.now();
      }
      const command = await claim();
      if (command) {
        process.stdout.write(`device command ${command.id} (${command.type}) started\n`);
        await execute(command);
        process.stdout.write(`device command ${command.id} (${command.type}) completed\n`);
        lastHeartbeat = 0;
      }
    } catch (error) {
      process.stderr.write(`device manager loop failed: ${errorMessage(error)}\n`);
    }
    await sleep(pollMs);
  }
}

void main();
