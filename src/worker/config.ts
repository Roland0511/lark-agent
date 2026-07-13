import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
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
    workspace_roots: z.array(workspaceRootSchema).min(1),
    capabilities: z.array(z.string()).default(["codex", "app_handoff"]),
    runner_version: z.string().min(1).max(128).default("development")
  })
});

export interface ResolvedWorkerConfig {
  controlPlaneUrl: string;
  deviceToken: string;
  executorId: string;
  displayName: string;
  codexHome: string;
  homeRef: string;
  codexProfile: string;
  profileOverrides: string[];
  codexBinary: string;
  codexVersion: string;
  configFingerprint: string;
  capacity: number;
  appLauncher: string | null;
  workspaceRoots: Array<{ alias: string; path: string }>;
  capabilities: string[];
  runnerVersion: string;
  architecture: "arm64" | "x64";
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

async function protocolFingerprint(command: string, codexHome: string): Promise<string> {
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
    for (const method of ["thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer", "turn/interrupt"]) {
      if (!clientSchema.includes(`\"${method}\"`)) throw new Error(`Codex App Server protocol is missing ${method}`);
    }
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
      if (!serverSchema.includes(`\"${method}\"`)) throw new Error(`Codex App Server protocol is missing ${method}`);
    }
    return sha256(`${clientSchema}\n${serverSchema}`);
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
  const capabilities = raw.executor.capabilities.filter((value) => value !== "app_handoff" || appLauncher !== null);
  const codexVersion = await commandVersion(raw.executor.codex_binary, codexHome);
  const protocolHash = await protocolFingerprint(raw.executor.codex_binary, codexHome);
  const overrides = profileOverrides(profileConfig);
  const configFingerprint = sha256([baseConfig, profileConfig, codexVersion, protocolHash].join("\n---\n"));
  return {
    controlPlaneUrl: raw.control_plane.url.replace(/\/$/, ""),
    deviceToken,
    executorId: raw.executor.id,
    displayName: raw.executor.display_name,
    codexHome,
    homeRef: stableHomeRef(raw.executor.id, codexHome),
    codexProfile: raw.executor.codex_profile,
    profileOverrides: overrides,
    codexBinary: raw.executor.codex_binary,
    codexVersion,
    configFingerprint,
    capacity: raw.executor.capacity,
    appLauncher,
    workspaceRoots,
    capabilities,
    runnerVersion: raw.executor.runner_version,
    architecture: process.arch === "arm64" ? "arm64" : "x64"
  };
}
