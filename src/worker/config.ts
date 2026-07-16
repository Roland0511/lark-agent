import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { sha256, stableHomeRef } from "../shared/crypto.js";

const workspaceRootSchema = z.object({
  alias: z.string().min(1).max(128),
  path: z.string().min(1)
});

const configSchema = z.object({
  control_plane: z.object({
    url: z.string().url(),
    device_token_env: z.string().min(1).default("LARK_AGENT_DEVICE_TOKEN"),
    device_token_file: z.string().min(1).optional()
  }),
  executor: z.object({
    id: z.string().min(1).max(128),
    display_name: z.string().min(1).max(128),
    codex_home: z.string().min(1),
    codex_profile: z.string().regex(/^[A-Za-z0-9_-]+$/),
    codex_binary: z.string().default("codex"),
    capacity: z.literal(1).default(1),
    app_launcher: z.string().optional(),
    runtime_state_dir: z.string().optional(),
    workspace_roots: z.array(workspaceRootSchema).min(1),
    capabilities: z.array(z.string()).default(["codex", "app_handoff", "chat_context_v1"]),
    runner_version: z.string().min(1).max(128).default("development")
  })
});

export interface ResolvedWorkerConfig {
  controlPlaneUrl: string;
  deviceToken: string;
  deviceTokenEnvironmentName: string | null;
  executorId: string;
  displayName: string;
  codexHome: string;
  homeRef: string;
  codexProfile: string;
  profileOverrides: string[];
  profileModel: string | null;
  profileReasoningEffort: string | null;
  codexBinary: string;
  codexVersion: string;
  configFingerprint: string;
  workspaceMappingFingerprint: string;
  capacity: number;
  appLauncher: string | null;
  runtimeStateDir: string;
  workspaceRoots: Array<{ alias: string; path: string }>;
  capabilities: string[];
  supportsThreadItemsList: boolean;
  runnerVersion: string;
  architecture: "arm64" | "x64";
  attachmentMaxBytes: number;
  attachmentTaskMaxBytes: number;
  attachmentRetentionDays: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function tomlPathPart(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function tomlLiteral(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, nested]) => `${tomlPathPart(key)} = ${tomlLiteral(nested)}`).join(", ")} }`;
  }
  throw new Error("profile contains an unsupported TOML value");
}

function profileOverrides(source: string): string[] {
  const parsed = parseToml(source) as Record<string, unknown>;
  const result: string[] = [];
  const visit = (value: Record<string, unknown>, path: string[]) => {
    for (const [key, nested] of Object.entries(value)) {
      const next = [...path, key];
      // App Server does not consume TUI-only display state, and current Codex
      // versions reject model-availability NUX maps when passed through -c.
      if (next[0] === "tui") continue;
      if (nested && typeof nested === "object" && !Array.isArray(nested) && !(nested instanceof Date) && Object.keys(nested).length > 0) {
        visit(nested as Record<string, unknown>, next);
      } else {
        result.push(`${next.map(tomlPathPart).join(".")}=${tomlLiteral(nested)}`);
      }
    }
  };
  visit(parsed, []);
  return result;
}

function continuationConfigFingerprint(input: {
  codexVersion: string;
  protocolHash: string;
  profileOverrides: string[];
  effectiveModel: unknown;
  effectiveModelProvider: unknown;
  effectiveReasoningEffort: unknown;
}): string {
  return sha256(JSON.stringify({
    version: 1,
    codexVersion: input.codexVersion,
    protocolHash: input.protocolHash,
    model: typeof input.effectiveModel === "string" ? input.effectiveModel : null,
    modelProvider: typeof input.effectiveModelProvider === "string" ? input.effectiveModelProvider : null,
    reasoningEffort: typeof input.effectiveReasoningEffort === "string" ? input.effectiveReasoningEffort : null,
    profileOverrides: [...input.profileOverrides].sort()
  }));
}

export function workspaceMappingFingerprint(workspaceRoots: Array<{ alias: string; path: string }>): string {
  const roots = workspaceRoots
    .map(({ alias, path }) => [alias, path] as const)
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0);
  return sha256(JSON.stringify({ version: 1, roots }));
}

async function commandVersion(command: string, codexHome: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
    delete env.CODEX_SQLITE_HOME;
    const child = spawn(command, ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(`codex --version exited ${code ?? -1}: ${output.trim()}`))));
  });
}

async function protocolFingerprint(command: string, codexHome: string): Promise<{ hash: string; supportsThreadItemsList: boolean }> {
  const outputDir = await mkdtemp(join(tmpdir(), "lark-agent-codex-schema-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  delete env.CODEX_SQLITE_HOME;
  try {
    await new Promise<void>((resolve, reject) => {
      // Schema generation is profile-independent. Current Codex CLI versions reject
      // --profile for this non-runtime app-server utility command.
      const child = spawn(command, ["app-server", "generate-json-schema", "--experimental", "--out", outputDir], {
        env,
        stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`Codex schema generation exited ${code ?? -1}: ${stderr.trim()}`))));
    });
    const clientSchema = await readFile(join(outputDir, "ClientRequest.json"), "utf8");
    const serverSchema = await readFile(join(outputDir, "ServerRequest.json"), "utf8");
    for (const method of ["thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer", "turn/interrupt", "skills/list"]) {
      if (!clientSchema.includes(`\"${method}\"`)) throw new Error(`Codex App Server protocol is missing ${method}`);
    }
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
      if (!serverSchema.includes(`\"${method}\"`)) throw new Error(`Codex App Server protocol is missing ${method}`);
    }
    return {
      hash: sha256(`${clientSchema}\n${serverSchema}`),
      supportsThreadItemsList: clientSchema.includes('"thread/items/list"')
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

export async function loadWorkerConfig(configFile: string, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedWorkerConfig> {
  const raw = configSchema.parse(parseYaml(await readFile(configFile, "utf8")));
  const deviceToken = raw.control_plane.device_token_file
    ? (await readFile(raw.control_plane.device_token_file, "utf8")).trim()
    : env[raw.control_plane.device_token_env];
  if (!deviceToken) throw new Error(raw.control_plane.device_token_file
    ? "device credential file is empty"
    : `device token environment variable ${raw.control_plane.device_token_env} is missing`);
  if (!isAbsolute(raw.executor.codex_home)) throw new Error("executor.codex_home must be an absolute path");
  const codexHome = await realpath(raw.executor.codex_home);
  const homeStat = await stat(codexHome);
  if (!homeStat.isDirectory()) throw new Error("executor.codex_home must be a directory");
  await access(codexHome, constants.R_OK | constants.W_OK);

  const baseConfigPath = join(codexHome, "config.toml");
  const profilePath = join(codexHome, `${raw.executor.codex_profile}.config.toml`);
  const baseConfig = await readFile(baseConfigPath, "utf8").catch(() => "");
  const profileConfig = await readFile(profilePath, "utf8");
  if (/^\s*\[profiles\./m.test(baseConfig) || /^\s*profile\s*=/m.test(baseConfig)) {
    throw new Error("legacy [profiles.*] or profile= configuration is not supported; use a separate profile file");
  }
  if (/^\s*\[profiles\./m.test(profileConfig) || /^\s*profile\s*=/m.test(profileConfig)) {
    throw new Error("profile file must contain top-level overrides, not nested [profiles.*] or profile=");
  }

  const workspaceRoots: Array<{ alias: string; path: string }> = [];
  const aliases = new Set<string>();
  for (const root of raw.executor.workspace_roots) {
    if (aliases.has(root.alias)) throw new Error(`duplicate workspace alias: ${root.alias}`);
    aliases.add(root.alias);
    if (!isAbsolute(root.path)) throw new Error(`workspace root ${root.alias} must be absolute`);
    const canonical = await realpath(root.path);
    if (!(await stat(canonical)).isDirectory()) throw new Error(`workspace root ${root.alias} is not a directory`);
    workspaceRoots.push({ alias: root.alias, path: canonical });
  }

  let appLauncher: string | null = null;
  if (raw.executor.app_launcher) {
    if (!isAbsolute(raw.executor.app_launcher)) throw new Error("executor.app_launcher must be absolute");
    appLauncher = await realpath(raw.executor.app_launcher);
    await access(appLauncher, constants.X_OK);
  }
  const capabilities = [...new Set([
    ...raw.executor.capabilities,
    "chat_context_v1",
    "skillhub_skills_v1",
    "skill_runtime_config_v1",
    "user_skills_inventory_v1",
    "workspace_mapping_v1"
  ])]
    .filter((value) => value !== "app_handoff" || appLauncher !== null);
  const configuredRuntimeStateDir = raw.executor.runtime_state_dir ?? join(dirname(resolve(configFile)), "state");
  if (!isAbsolute(configuredRuntimeStateDir)) throw new Error("executor.runtime_state_dir must be an absolute path");
  for (const workspace of workspaceRoots) {
    if (pathsOverlap(resolve(configuredRuntimeStateDir), workspace.path)) {
      throw new Error(`executor.runtime_state_dir must not overlap workspace root ${workspace.alias}`);
    }
  }
  await mkdir(configuredRuntimeStateDir, { recursive: true, mode: 0o700 });
  const runtimeStateDir = await realpath(configuredRuntimeStateDir);
  if (!(await stat(runtimeStateDir)).isDirectory()) throw new Error("executor.runtime_state_dir must be a directory");
  for (const workspace of workspaceRoots) {
    if (pathsOverlap(runtimeStateDir, workspace.path)) {
      throw new Error(`executor.runtime_state_dir must not overlap workspace root ${workspace.alias}`);
    }
  }
  await chmod(runtimeStateDir, 0o700);
  await access(runtimeStateDir, constants.R_OK | constants.W_OK);
  const codexVersion = await commandVersion(raw.executor.codex_binary, codexHome);
  const protocol = await protocolFingerprint(raw.executor.codex_binary, codexHome);
  if (!capabilities.includes("thread_snapshot_v1")) capabilities.push("thread_snapshot_v1");
  if (!capabilities.includes("thread_turn_summary_v1")) capabilities.push("thread_turn_summary_v1");
  const overrides = profileOverrides(profileConfig);
  const baseValues = baseConfig ? parseToml(baseConfig) as Record<string, unknown> : {};
  const profileValues = parseToml(profileConfig) as Record<string, unknown>;
  const effectiveModel = profileValues.model ?? baseValues.model;
  const effectiveModelProvider = profileValues.model_provider ?? baseValues.model_provider;
  const effectiveReasoningEffort = profileValues.model_reasoning_effort ?? baseValues.model_reasoning_effort;
  // Only pin values that affect App Server continuity. The complete base config
  // also contains desktop preferences, trusted projects and plugin metadata;
  // changing those must not invalidate an otherwise resumable Thread.
  const configFingerprint = continuationConfigFingerprint({
    codexVersion,
    protocolHash: protocol.hash,
    profileOverrides: overrides,
    effectiveModel,
    effectiveModelProvider,
    effectiveReasoningEffort
  });
  const mappingFingerprint = workspaceMappingFingerprint(workspaceRoots);
  return {
    controlPlaneUrl: raw.control_plane.url.replace(/\/$/, ""),
    deviceToken,
    deviceTokenEnvironmentName: raw.control_plane.device_token_file ? null : raw.control_plane.device_token_env,
    executorId: raw.executor.id,
    displayName: raw.executor.display_name,
    codexHome,
    homeRef: stableHomeRef(raw.executor.id, codexHome),
    codexProfile: raw.executor.codex_profile,
    profileOverrides: overrides,
    profileModel: typeof effectiveModel === "string" ? effectiveModel : null,
    profileReasoningEffort: typeof effectiveReasoningEffort === "string" ? effectiveReasoningEffort : null,
    codexBinary: raw.executor.codex_binary,
    codexVersion,
    configFingerprint,
    workspaceMappingFingerprint: mappingFingerprint,
    capacity: raw.executor.capacity,
    appLauncher,
    runtimeStateDir,
    workspaceRoots,
    capabilities,
    supportsThreadItemsList: protocol.supportsThreadItemsList,
    runnerVersion: raw.executor.runner_version,
    architecture: process.arch === "arm64" ? "arm64" : "x64",
    attachmentMaxBytes: positiveInteger(env.ATTACHMENT_MAX_BYTES, 104_857_600, "ATTACHMENT_MAX_BYTES"),
    attachmentTaskMaxBytes: positiveInteger(env.ATTACHMENT_TASK_MAX_BYTES, 209_715_200, "ATTACHMENT_TASK_MAX_BYTES"),
    attachmentRetentionDays: positiveInteger(env.ATTACHMENT_RETENTION_DAYS, 7, "ATTACHMENT_RETENTION_DAYS")
  };
}

function pathsOverlap(first: string, second: string): boolean {
  const isInside = (root: string, target: string) => {
    const child = relative(resolve(root), resolve(target));
    return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
  };
  return isInside(first, second) || isInside(second, first);
}
