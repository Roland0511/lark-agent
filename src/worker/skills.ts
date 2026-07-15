import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import {
  taskRuntimeEnvironmentResponseSchema,
  workerUserSkillsReportSchema,
  type ClaimedTask,
  type TaskRuntimeFile,
  type TaskRuntimeSnapshot,
  type TaskSkillPackage,
  type WorkerUserSkill,
  type WorkerUserSkillsReport,
  type WorkspaceRuntimeSyncJob,
  type WorkspaceRuntimeSyncResult
} from "../shared/contracts.js";
import { sha256 } from "../shared/crypto.js";
import { workerUserSkillsFingerprint } from "../shared/user-skills.js";
import type { ResolvedWorkerConfig } from "./config.js";
import type { ControlPlaneClient } from "./control-plane-client.js";
import type { CodexAdapter, CodexSkillsListEntry } from "./codex-adapter.js";

const MAX_SKILL_ARCHIVE_BYTES = 104_857_600;
const MAX_SKILL_ENTRIES = 2_000;
const MAX_SKILL_FILE_BYTES = 10_485_760;
const MAX_SKILL_EXPANDED_BYTES = 209_715_200;
const MAX_RUNTIME_FILE_TOTAL_BYTES = 5_242_880;
const MANAGED_SKILL_MARKER = ".lark-agent-managed.json";
const RUNTIME_MANIFEST_VERSION = 1;
const SAFE_SHELL_ENVIRONMENT = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM"
] as const;
const RESERVED_ENVIRONMENT = /^(?:HOME|PATH|CODEX_HOME|CODEX_SQLITE_HOME|NODE_OPTIONS|BASH_ENV|ENV|CDPATH|GLOBIGNORE|ZDOTDIR|SHELLOPTS|PS4|PYTHONPATH|RUBYOPT|GIT_CONFIG(?:_.*)?|GIT_ASKPASS|SSH_ASKPASS|LARK_AGENT_.*|SKILL_RUNTIME_.*|LD_.*|DYLD_.*)$/i;
const RUNNER_CONTROL_ENVIRONMENT = /^(?:WORKER_CONFIG_FILE|LARK_AGENT_(?:DEVICE_TOKEN|ENROLLMENT_TOKEN)|SKILLHUB_API_TOKEN)$/i;
const LIKELY_SECRET_ENVIRONMENT = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|AUTH)/i;
const RESERVED_RUNTIME_PATH_PARTS = new Set([".git", ".codex", ".agents", ".lark-agent"]);

interface CachedSkill {
  skill: TaskSkillPackage;
  contentPath: string;
  directoryName: string;
}

interface RuntimeManifestEntry {
  id: string;
  targetPath: string;
  revision: number;
  sha256: string;
}

interface RuntimeManifest {
  version: 1;
  runtimeConfigFingerprint: string;
  files: RuntimeManifestEntry[];
}

export interface RuntimeFileApplyResult {
  fingerprint: string;
  files: WorkspaceRuntimeSyncResult["files"];
  redactionValues: string[];
}

export class SkillRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly conflict = false,
    readonly targetPath: string | null = null
  ) {
    super(message);
  }
}

export class SkillRuntimeManager {
  constructor(
    private readonly config: ResolvedWorkerConfig,
    private readonly client: ControlPlaneClient
  ) {}

  async prepareTaskFilesystem(task: ClaimedTask, workspacePath: string): Promise<RuntimeFileApplyResult> {
    try {
      const skills = effectiveTaskSkills(task.skills);
      const cached: CachedSkill[] = [];
      for (const skill of skills) cached.push(await this.ensureCachedSkill(skill, (target) => this.client.downloadSkillPackage(task, skill, target)));
      await reconcileManagedSkills(workspacePath, cached);
      return await applyRuntimeFiles(
        workspacePath,
        task.runtimeConfig.fingerprint,
        task.runtimeConfig.files,
        (file, target) => this.client.downloadRuntimeFile(task, file, target)
      );
    } catch (error) {
      if (error instanceof SkillRuntimeError) throw error;
      throw new SkillRuntimeError("skill_runtime_prepare_failed", "任务技能或配置文件同步失败，已暂停。");
    }
  }

  async environmentForTask(task: ClaimedTask): Promise<{ environment: NodeJS.ProcessEnv; allowlist: string[]; names: string[]; redactionValues: string[] }> {
    const expectedNames = task.runtimeConfig.environment.map((item) => item.name);
    validateEnvironmentNames(expectedNames);
    if (!expectedNames.length) {
      const isolated = isolatedCodexEnvironment({}, [], runnerControlEnvironmentNames(this.config));
      return {
        environment: isolated.environment,
        allowlist: isolated.allowlist,
        names: [],
        redactionValues: []
      };
    }
    let response;
    try {
      response = taskRuntimeEnvironmentResponseSchema.parse(await this.client.runtimeEnvironment(task));
    } catch (error) {
      if (error instanceof SkillRuntimeError) throw error;
      throw new SkillRuntimeError("runtime_environment_unavailable", "任务凭证无法安全取得，已暂停。");
    }
    if (response.fingerprint !== task.runtimeConfig.fingerprint) {
      throw new SkillRuntimeError("runtime_environment_revision_mismatch", "任务凭证修订已变化，已在正式执行前暂停。", true);
    }
    const values = new Map<string, string>();
    for (const variable of response.variables) {
      if (values.has(variable.name)) throw new SkillRuntimeError("duplicate_runtime_environment", "任务凭证包含重复变量，已暂停。", true);
      values.set(variable.name, variable.value);
    }
    if (expectedNames.some((name) => !values.has(name)) || [...values.keys()].some((name) => !expectedNames.includes(name))) {
      throw new SkillRuntimeError("runtime_environment_set_mismatch", "任务凭证集合与领取快照不一致，已暂停。", true);
    }
    const isolated = isolatedCodexEnvironment(Object.fromEntries(values), expectedNames, runnerControlEnvironmentNames(this.config));
    return {
      // App Server may still need device-level model provider variables. Command
      // execution receives only the explicit allowlist below.
      environment: isolated.environment,
      allowlist: isolated.allowlist,
      names: [...expectedNames].sort(),
      redactionValues: [...new Set([...values.values()].filter((value) => value.length >= 4))]
    };
  }

  async verifyTaskRuntime(
    task: ClaimedTask,
    workspacePath: string,
    adapter: CodexAdapter,
    environmentNames: string[],
    runtimeFiles: RuntimeFileApplyResult["files"]
  ): Promise<TaskRuntimeSnapshot> {
    let entries: CodexSkillsListEntry[];
    try {
      entries = await adapter.listSkills([workspacePath], true);
    } catch {
      throw new SkillRuntimeError("skill_discovery_failed", "Codex 技能发现校验失败，已暂停。");
    }
    const userSkills = (await collectUserSkills(entries)).slice(0, 512);
    assertManagedSkillsDiscovered(task.skills, workspacePath, entries);
    const snapshot: TaskRuntimeSnapshot = {
      skillSetFingerprint: task.skillSetFingerprint,
      runtimeConfigFingerprint: task.runtimeConfig.fingerprint,
      managedSkills: effectiveTaskSkills(task.skills),
      userSkills,
      environmentNames: [...environmentNames].sort(),
      files: runtimeFiles.map((file) => {
        if (file.status === "conflict" || file.status === "failed") throw new SkillRuntimeError("runtime_file_snapshot_invalid", "配置文件同步状态无效，已暂停。");
        return {
          id: file.id,
          targetPath: file.targetPath,
          revision: file.revision,
          actualSha256: file.actualSha256,
          status: file.status,
          error: null
        };
      }),
      appliedAt: new Date().toISOString()
    };
    try {
      await this.client.reportRuntimeSnapshot(task, snapshot);
    } catch {
      throw new SkillRuntimeError("runtime_snapshot_report_failed", "任务运行配置快照无法确认，已暂停。");
    }
    return snapshot;
  }

  async applyWorkspaceSync(
    job: WorkspaceRuntimeSyncJob,
    workspacePath: string,
    adapter?: CodexAdapter,
    assertLease: () => void = () => undefined
  ): Promise<WorkspaceRuntimeSyncResult> {
    try {
      assertLease();
      const skills = effectiveTaskSkills(job.skills);
      const cached: CachedSkill[] = [];
      for (const skill of skills) {
        assertLease();
        cached.push(await this.ensureCachedSkill(skill, (target) => this.client.downloadWorkspaceSkillPackage(job, skill, target), assertLease));
      }
      assertLease();
      await reconcileManagedSkills(workspacePath, cached);
      assertLease();
      const result = await applyRuntimeFiles(
        workspacePath,
        job.runtimeConfig.fingerprint,
        job.runtimeConfig.files,
        async (file, target) => {
          assertLease();
          const downloaded = await this.client.downloadWorkspaceRuntimeFile(job, file, target);
          assertLease();
          return downloaded;
        },
        assertLease
      );
      if (adapter) {
        assertLease();
        const entries = await adapter.listSkills([workspacePath], true);
        assertLease();
        assertManagedSkillsDiscovered(job.skills, workspacePath, entries);
      }
      return {
        status: "applied",
        summary: "工作区配置文件已同步。",
        desiredFingerprint: job.desiredFingerprint,
        skillSetFingerprint: job.skillSetFingerprint,
        runtimeConfigFingerprint: result.fingerprint,
        files: result.files
      };
    } catch (error) {
      const runtimeError = error instanceof SkillRuntimeError ? error : new SkillRuntimeError("runtime_file_sync_failed", "工作区配置文件同步失败。");
      const affectedFiles = runtimeError.targetPath
        ? job.runtimeConfig.files.filter((file) => portablePathCollisionKey(file.targetPath) === portablePathCollisionKey(runtimeError.targetPath!))
        : [];
      return {
        status: runtimeError.conflict ? "conflict" : "failed",
        summary: runtimeError.message,
        desiredFingerprint: job.desiredFingerprint,
        skillSetFingerprint: job.skillSetFingerprint,
        runtimeConfigFingerprint: job.runtimeConfig.fingerprint,
        files: affectedFiles.map((file) => ({
          id: file.id,
          targetPath: file.targetPath,
          revision: file.revision,
          status: runtimeError.conflict ? "conflict" : "failed",
          actualSha256: null,
          errorCode: runtimeError.code
        }))
      };
    }
  }

  private async ensureCachedSkill(
    skill: TaskSkillPackage,
    download: (target: string) => Promise<{ path: string; size: number; sha256: string }>,
    assertLease: () => void = () => undefined
  ): Promise<CachedSkill> {
    const packagesRoot = join(this.config.runtimeStateDir, "skill-packages");
    await mkdir(packagesRoot, { recursive: true, mode: 0o700 });
    const cacheDirectory = join(packagesRoot, skill.archiveSha256);
    const contentPath = join(cacheDirectory, "content");
    const cacheMarker = join(cacheDirectory, "package.json");
    if (await validCachedSkill(contentPath, cacheMarker, skill)) {
      return { skill, contentPath, directoryName: managedSkillDirectory(skill.coordinate) };
    }
    await rm(cacheDirectory, { recursive: true, force: true });
    const stagingRoot = await mkdtemp(join(packagesRoot, ".staging-"));
    const archivePath = join(stagingRoot, "package.zip");
    const extractedPath = join(stagingRoot, "content");
    try {
      assertLease();
      const downloaded = await download(archivePath);
      assertLease();
      if (downloaded.size > MAX_SKILL_ARCHIVE_BYTES) throw new SkillRuntimeError("skill_archive_too_large", "技能包超过 Runner 安全限制。");
      const archive = await readFile(archivePath);
      await extractSafeSkillArchive(archive, extractedPath, skill);
      assertLease();
      const contentFingerprint = await skillContentFingerprint(extractedPath);
      await writeFile(join(stagingRoot, "package.json"), JSON.stringify({
        coordinate: skill.coordinate,
        name: skill.name,
        version: skill.version,
        registryFingerprint: skill.registryFingerprint,
        archiveSha256: skill.archiveSha256,
        contentFingerprint
      }), { mode: 0o600 });
      assertLease();
      await rename(stagingRoot, cacheDirectory);
      return { skill, contentPath, directoryName: managedSkillDirectory(skill.coordinate) };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error instanceof SkillRuntimeError
        ? error
        : new SkillRuntimeError("skill_package_prepare_failed", `技能 ${skill.coordinate} 下载或校验失败。`);
    }
  }
}

function assertManagedSkillsDiscovered(skills: TaskSkillPackage[], workspacePath: string, entries: CodexSkillsListEntry[]): void {
  const allSkills = entries.flatMap((entry) => entry.skills);
  for (const skill of effectiveTaskSkills(skills)) {
    const expectedDirectory = join(workspacePath, ".agents", "skills", managedSkillDirectory(skill.coordinate));
    const discovered = allSkills.find((item) => item.scope === "repo" && item.enabled && item.name === skill.name && isPathInside(expectedDirectory, item.path));
    if (!discovered) throw new SkillRuntimeError("managed_skill_not_discovered", `技能 ${skill.coordinate} 未被 Codex 识别，已暂停。`);
    const userCollision = allSkills.find((item) => item.scope === "user" && item.enabled && item.name === skill.name);
    if (userCollision) throw new SkillRuntimeError("user_skill_name_conflict", `技能 ${skill.coordinate} 与 Runner 用户级技能同名，已暂停。`, true);
    const repoCollision = allSkills.find((item) => item.scope === "repo" && item.enabled && item.name === skill.name && !isPathInside(expectedDirectory, item.path));
    if (repoCollision) throw new SkillRuntimeError("repo_skill_name_conflict", `技能 ${skill.coordinate} 与工作区已有技能同名，已暂停。`, true);
    const platformCollision = allSkills.find((item) => (item.scope === "system" || item.scope === "admin") && item.enabled && item.name === skill.name);
    if (platformCollision) throw new SkillRuntimeError("platform_skill_name_conflict", `技能 ${skill.coordinate} 与 Codex 内置或管理员技能同名，已暂停。`, true);
  }
}

export async function buildUserSkillsReport(
  entries: CodexSkillsListEntry[],
  status: WorkerUserSkillsReport["status"] = "ready"
): Promise<WorkerUserSkillsReport> {
  const allUserSkills = await collectUserSkills(entries);
  const total = allUserSkills.length;
  const skills = allUserSkills.slice(0, 512);
  const errors = entries.flatMap((entry) => entry.errors.map((error) => sanitizeSkillError(error.message))).slice(0, 50);
  const fingerprint = workerUserSkillsFingerprint(skills);
  return workerUserSkillsReportSchema.parse({
    skills,
    fingerprint,
    scannedAt: new Date().toISOString(),
    status: errors.length && status === "ready" ? "stale" : status,
    truncated: total > skills.length,
    total,
    errors
  });
}

export async function collectUserSkills(entries: CodexSkillsListEntry[]): Promise<WorkerUserSkill[]> {
  const result = new Map<string, WorkerUserSkill>();
  for (const skill of entries.flatMap((entry) => entry.skills)) {
    if (skill.scope !== "user" || !skill.enabled || !skill.name) continue;
    const metadata = await readSkillHubMetadata(skill.path);
    const item: WorkerUserSkill = {
      name: skill.name.slice(0, 128),
      description: skill.description.slice(0, 2_000),
      displayName: (skill.interface?.displayName ?? null)?.slice(0, 256) ?? null,
      shortDescription: (skill.interface?.shortDescription ?? skill.shortDescription ?? null)?.slice(0, 500) ?? null,
      relativePath: redactUserSkillPath(skill.path),
      dependencies: skill.dependencies.slice(0, 128).map((dependency) => ({
        type: dependency.type.slice(0, 64),
        value: dependency.value.slice(0, 512),
        description: dependency.description?.slice(0, 500) ?? null
      })),
      skillhub: metadata
    };
    result.set(`${item.name}:${item.relativePath}`, item);
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name) || a.relativePath.localeCompare(b.relativePath));
}

export function effectiveTaskSkills(skills: TaskSkillPackage[]): TaskSkillPackage[] {
  const byCoordinate = new Map<string, TaskSkillPackage>();
  for (const skill of skills) {
    const existing = byCoordinate.get(skill.coordinate);
    if (!existing || skill.sourceScope === "chat_context") byCoordinate.set(skill.coordinate, skill);
  }
  const effective = [...byCoordinate.values()].sort((a, b) => a.coordinate.localeCompare(b.coordinate));
  const names = new Map<string, string>();
  for (const skill of effective) {
    const existing = names.get(skill.name);
    if (existing && existing !== skill.coordinate) {
      throw new SkillRuntimeError("managed_skill_name_conflict", `技能 ${existing} 与 ${skill.coordinate} 同名，已暂停。`, true);
    }
    names.set(skill.name, skill.coordinate);
  }
  return effective;
}

export function managedSkillDirectory(coordinate: string): string {
  const match = /^@([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9_-]{0,127})$/.exec(coordinate);
  if (!match) throw new SkillRuntimeError("invalid_skill_coordinate", "技能坐标格式无效。");
  return `skillhub--${match[1]}--${match[2]}`;
}

async function validCachedSkill(contentPath: string, markerPath: string, skill: TaskSkillPackage): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    if (marker.archiveSha256 !== skill.archiveSha256 || marker.name !== skill.name || typeof marker.contentFingerprint !== "string") return false;
    if (await skillNameFromFile(join(contentPath, "SKILL.md")) !== skill.name) return false;
    return await skillContentFingerprint(contentPath) === marker.contentFingerprint;
  } catch {
    return false;
  }
}

async function skillContentFingerprint(root: string): Promise<string> {
  const files: Array<{ path: string; digest: string }> = [];
  const collisionKeys = new Set<string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const collisionKey = portablePathCollisionKey(relativePath);
      if (collisionKeys.has(collisionKey)) throw new SkillRuntimeError("skill_cache_path_collision", "技能缓存包含跨平台冲突路径。");
      collisionKeys.add(collisionKey);
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new SkillRuntimeError("skill_cache_symlink", "技能缓存包含符号链接。");
      if (entry.isDirectory()) await visit(absolute, relativePath);
      else if (entry.isFile()) files.push({ path: relativePath, digest: sha256(await readFile(absolute)) });
      else throw new SkillRuntimeError("skill_cache_file_type", "技能缓存包含不支持的文件类型。");
    }
  };
  await visit(root, "");
  return sha256(files.sort((left, right) => left.path.localeCompare(right.path)).map((file) => `${file.path}:${file.digest}\n`).join(""));
}

interface ZipEntry {
  name: string;
  size: number;
  mode: number;
  directory: boolean;
}

async function extractSafeSkillArchive(archive: Buffer, target: string, skill: TaskSkillPackage): Promise<void> {
  if (archive.length > MAX_SKILL_ARCHIVE_BYTES) throw new SkillRuntimeError("skill_archive_too_large", "技能包超过 Runner 安全限制。");
  const entries = inspectZipCentralDirectory(archive);
  if (!entries.some((entry) => entry.name === "SKILL.md" && !entry.directory)) {
    throw new SkillRuntimeError("skill_manifest_missing", `技能 ${skill.coordinate} 缺少根目录 SKILL.md。`);
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(new Uint8Array(archive));
  } catch {
    throw new SkillRuntimeError("skill_archive_invalid", `技能 ${skill.coordinate} 的归档无法解压。`);
  }
  const metadata = new Map(entries.map((entry) => [entry.name, entry]));
  let total = 0;
  for (const [rawName, bytes] of Object.entries(extracted)) {
    const name = safeArchivePath(rawName);
    const entry = metadata.get(name);
    if (!entry) throw new SkillRuntimeError("skill_archive_index_mismatch", "技能包目录索引不一致。");
    if (entry.directory) {
      if (bytes.byteLength !== 0) throw new SkillRuntimeError("skill_archive_index_mismatch", "技能包目录索引不一致。");
      continue;
    }
    if (bytes.byteLength !== entry.size || bytes.byteLength > MAX_SKILL_FILE_BYTES) throw new SkillRuntimeError("skill_file_size_mismatch", "技能包文件大小校验失败。");
    total += bytes.byteLength;
    if (total > MAX_SKILL_EXPANDED_BYTES) throw new SkillRuntimeError("skill_archive_expanded_too_large", "技能包解压后超过安全限制。");
    const destination = join(target, ...name.split("/"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: entry.mode & 0o111 ? 0o700 : 0o600, flag: "wx" });
  }
  const manifestName = await skillNameFromFile(join(target, "SKILL.md"));
  if (manifestName !== skill.name) throw new SkillRuntimeError("skill_name_mismatch", `技能 ${skill.coordinate} 的声明名称与控制面不一致。`, true);
}

function inspectZipCentralDirectory(archive: Buffer): ZipEntry[] {
  const minimum = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new SkillRuntimeError("skill_archive_invalid", "技能包缺少 ZIP 目录。");
  const count = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (count > MAX_SKILL_ENTRIES || centralOffset + centralSize > eocd) throw new SkillRuntimeError("skill_archive_limit", "技能包目录超过安全限制。");
  const entries: ZipEntry[] = [];
  let total = 0;
  let offset = centralOffset;
  const names = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new SkillRuntimeError("skill_archive_invalid", "技能包 ZIP 目录损坏。");
    const flags = archive.readUInt16LE(offset + 8);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    if ((flags & 0x1) !== 0 || size === 0xffffffff) throw new SkillRuntimeError("skill_archive_unsupported", "技能包使用了不受支持的 ZIP 特性。");
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > archive.length) throw new SkillRuntimeError("skill_archive_invalid", "技能包 ZIP 文件名损坏。");
    const rawName = archive.subarray(offset + 46, nameEnd).toString((flags & 0x800) !== 0 ? "utf8" : "utf8");
    const name = safeArchivePath(rawName);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) throw new SkillRuntimeError("skill_archive_symlink", "技能包不得包含符号链接。");
    const directory = rawName.endsWith("/") || (unixMode & 0xf000) === 0x4000;
    const collisionKey = portablePathCollisionKey(name);
    if (names.has(collisionKey)) throw new SkillRuntimeError("skill_archive_duplicate_path", "技能包包含跨平台冲突路径。");
    names.add(collisionKey);
    if (!directory) {
      if (size > MAX_SKILL_FILE_BYTES) throw new SkillRuntimeError("skill_file_too_large", "技能包内单个文件超过安全限制。");
      total += size;
      if (total > MAX_SKILL_EXPANDED_BYTES) throw new SkillRuntimeError("skill_archive_expanded_too_large", "技能包解压后超过安全限制。");
    }
    entries.push({ name, size, mode: unixMode & 0o777, directory });
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) throw new SkillRuntimeError("skill_archive_invalid", "技能包 ZIP 目录长度不一致。");
  return entries;
}

function safeArchivePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new SkillRuntimeError("skill_archive_path_invalid", "技能包包含不安全路径。");
  }
  const withoutSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  if (withoutSlash !== withoutSlash.normalize("NFC")) {
    throw new SkillRuntimeError("skill_archive_path_invalid", "技能包路径必须使用 Unicode NFC 规范形式。");
  }
  const parts = withoutSlash.split("/");
  if (!withoutSlash || parts.some((part) => !part || part === "." || part === "..")) {
    throw new SkillRuntimeError("skill_archive_path_invalid", "技能包包含目录穿越路径。");
  }
  return parts.join("/");
}

async function skillNameFromFile(path: string): Promise<string> {
  const source = await readFile(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new SkillRuntimeError("skill_manifest_invalid", "SKILL.md 缺少合法 frontmatter。");
  const frontmatter = parseYaml(match[1]!) as Record<string, unknown> | null;
  const name = typeof frontmatter?.name === "string" ? frontmatter.name.trim() : "";
  if (!name || name.length > 128) throw new SkillRuntimeError("skill_manifest_invalid", "SKILL.md 缺少合法 name。");
  return name;
}

async function reconcileManagedSkills(workspacePath: string, cached: CachedSkill[]): Promise<void> {
  const agentsDirectory = join(workspacePath, ".agents");
  const skillsDirectory = join(agentsDirectory, "skills");
  await ensureDirectoryWithoutSymlink(workspacePath, agentsDirectory);
  await ensureDirectoryWithoutSymlink(workspacePath, skillsDirectory);
  const expected = new Map(cached.map((item) => [item.directoryName, item]));
  const currentEntries = await readdir(skillsDirectory, { withFileTypes: true });
  const managed = new Map<string, string>();
  for (const entry of currentEntries) {
    if (!entry.isDirectory() || entry.name.startsWith(".lark-agent-")) continue;
    const path = join(skillsDirectory, entry.name);
    if (await isManagedSkillDirectory(path)) managed.set(entry.name, path);
  }
  for (const directoryName of expected.keys()) {
    const destination = join(skillsDirectory, directoryName);
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existing && !managed.has(directoryName)) {
      throw new SkillRuntimeError("managed_skill_path_conflict", `工作区已有同名技能目录 ${directoryName}，未执行覆盖。`, true);
    }
  }
  const gitExcludePath = await prepareGitExclude(workspacePath);
  for (const directoryName of expected.keys()) {
    await addGitExclude(gitExcludePath, `.agents/skills/${directoryName}`);
  }
  const staging = await mkdtemp(join(agentsDirectory, ".lark-agent-skill-stage-"));
  const backup = await mkdtemp(join(agentsDirectory, ".lark-agent-skill-backup-"));
  const installed: string[] = [];
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const [directoryName, item] of expected) {
      const staged = join(staging, directoryName);
      await cp(item.contentPath, staged, { recursive: true, force: false, errorOnExist: true, dereference: false });
      await writeFile(join(staged, MANAGED_SKILL_MARKER), JSON.stringify({
        version: 1,
        coordinate: item.skill.coordinate,
        packageId: item.skill.packageId,
        archiveSha256: item.skill.archiveSha256
      }), { mode: 0o600 });
    }
    for (const [directoryName, path] of managed) {
      const backupPath = join(backup, directoryName);
      await rename(path, backupPath);
      moved.push({ from: backupPath, to: path });
    }
    for (const directoryName of expected.keys()) {
      const destination = join(skillsDirectory, directoryName);
      await rename(join(staging, directoryName), destination);
      installed.push(destination);
    }
  } catch (error) {
    for (const path of installed.reverse()) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    for (const item of moved.reverse()) await rename(item.from, item.to).catch(() => undefined);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}

async function isManagedSkillDirectory(path: string): Promise<boolean> {
  try {
    const markerPath = join(path, MANAGED_SKILL_MARKER);
    if ((await lstat(markerPath)).isSymbolicLink()) return false;
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    return marker.version === 1 && typeof marker.coordinate === "string" && managedSkillDirectory(marker.coordinate) === basename(path);
  } catch {
    return false;
  }
}

async function applyRuntimeFiles(
  workspacePath: string,
  fingerprint: string,
  files: TaskRuntimeFile[],
  download: (file: TaskRuntimeFile, target: string) => Promise<{ path: string; size: number; sha256: string }>,
  assertLease: () => void = () => undefined
): Promise<RuntimeFileApplyResult> {
  validateRuntimeFiles(files);
  const stateDirectory = join(workspacePath, ".lark-agent");
  await ensureDirectoryWithoutSymlink(workspacePath, stateDirectory);
  const manifestPath = join(stateDirectory, "runtime-files.json");
  const previous = await readRuntimeManifest(manifestPath);
  const previousByPath = new Map(previous.files.map((file) => [runtimePathCollisionKey(file.targetPath), file]));
  const desiredPresent = files.filter((file) => file.desiredState === "present");
  const explicitAbsent = new Map(files.filter((file) => file.desiredState === "absent").map((file) => [runtimePathCollisionKey(file.targetPath), file]));
  const desiredPaths = new Set(desiredPresent.map((file) => runtimePathCollisionKey(file.targetPath)));
  const gitExcludePath = await prepareGitExclude(workspacePath);
  const staging = await mkdtemp(join(stateDirectory, ".runtime-stage-"));
  const backup = await mkdtemp(join(stateDirectory, ".runtime-backup-"));
  const operations: Array<{ file: TaskRuntimeFile | RuntimeManifestEntry; target: string; stage: string | null; action: "write" | "delete" | "unchanged" }> = [];
  try {
    for (const file of desiredPresent) {
      const target = runtimeTarget(workspacePath, file.targetPath);
      await assertNoSymlinkComponents(workspacePath, target, file.targetPath);
      const prior = previousByPath.get(runtimePathCollisionKey(file.targetPath));
      const actual = await fileDigest(target, file.targetPath);
      if (prior) {
        if (actual !== prior.sha256 && !file.force) throw runtimeConflict("runtime_file_drift", prior.targetPath);
      } else if (actual !== null && !file.force) {
        throw runtimeConflict("runtime_file_exists", file.targetPath);
      }
      if (actual === file.sha256 && prior?.revision === file.revision && prior.targetPath === file.targetPath) {
        operations.push({ file, target, stage: null, action: "unchanged" });
        continue;
      }
      const staged = join(staging, file.id);
      operations.push({ file, target, stage: staged, action: "write" });
    }
    for (const prior of previous.files) {
      const priorKey = runtimePathCollisionKey(prior.targetPath);
      if (desiredPaths.has(priorKey)) continue;
      const tombstone = explicitAbsent.get(priorKey);
      const target = runtimeTarget(workspacePath, prior.targetPath);
      await assertNoSymlinkComponents(workspacePath, target, prior.targetPath);
      const actual = await fileDigest(target, prior.targetPath);
      if (actual !== null && actual !== prior.sha256 && !tombstone?.force) throw runtimeConflict("runtime_file_drift", prior.targetPath);
      operations.push({ file: tombstone ?? prior, target, stage: null, action: actual === null ? "unchanged" : "delete" });
    }
    for (const tombstone of explicitAbsent.values()) {
      if (previousByPath.has(runtimePathCollisionKey(tombstone.targetPath))) continue;
      const target = runtimeTarget(workspacePath, tombstone.targetPath);
      await assertNoSymlinkComponents(workspacePath, target, tombstone.targetPath);
      const actual = await fileDigest(target, tombstone.targetPath);
      if (actual !== null && !tombstone.force) throw runtimeConflict("runtime_file_unmanaged_delete", tombstone.targetPath);
      operations.push({ file: tombstone, target, stage: null, action: actual === null ? "unchanged" : "delete" });
    }
    await addGitExclude(gitExcludePath, ".lark-agent/");
    for (const file of desiredPresent) await addGitExclude(gitExcludePath, file.targetPath);
    for (const operation of operations) {
      if (operation.action !== "write" || !operation.stage || !("size" in operation.file)) continue;
      const fetched = await download(operation.file, operation.stage);
      if (fetched.size !== operation.file.size || fetched.sha256 !== operation.file.sha256) {
        throw new SkillRuntimeError("runtime_file_digest_mismatch", `配置文件 ${operation.file.targetPath} 校验失败。`, false, operation.file.targetPath);
      }
    }
    assertLease();
    const moved: Array<{ backup: string; target: string }> = [];
    const installed: string[] = [];
    try {
      for (const operation of operations.filter((item) => item.action !== "unchanged")) {
        await mkdir(dirname(operation.target), { recursive: true, mode: 0o700 });
        const existing = await lstat(operation.target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (existing) {
          const backupPath = join(backup, String(moved.length));
          await rename(operation.target, backupPath);
          moved.push({ backup: backupPath, target: operation.target });
        }
        if (operation.action === "write" && operation.stage) {
          await rename(operation.stage, operation.target);
          installed.push(operation.target);
          await chmod(operation.target, 0o600);
        }
      }
      const next: RuntimeManifest = {
        version: RUNTIME_MANIFEST_VERSION,
        runtimeConfigFingerprint: fingerprint,
        files: desiredPresent.map((file) => ({ id: file.id, targetPath: file.targetPath, revision: file.revision, sha256: file.sha256 }))
      };
      await atomicWrite(manifestPath, JSON.stringify(next, null, 2));
    } catch (error) {
      for (const target of installed.reverse()) await rm(target, { force: true }).catch(() => undefined);
      for (const item of moved.reverse()) await rename(item.backup, item.target).catch(() => undefined);
      throw error;
    }
    const statuses: WorkspaceRuntimeSyncResult["files"] = files.map((file) => {
      const fileKey = runtimePathCollisionKey(file.targetPath);
      const operation = operations.find((item) => runtimePathCollisionKey(item.file.targetPath) === fileKey);
      return {
        id: file.id,
        targetPath: file.targetPath,
        revision: file.revision,
        status: file.desiredState === "absent" ? (operation?.action === "delete" ? "deleted" : "unchanged") : (operation?.action === "write" ? "applied" : "unchanged"),
        actualSha256: file.desiredState === "present" ? file.sha256 : null,
        errorCode: null
      };
    });
    const redactionValues = new Set<string>();
    for (const file of desiredPresent) {
      const content = await readFile(runtimeTarget(workspacePath, file.targetPath), "utf8");
      for (const value of sensitiveConfigValues(content)) redactionValues.add(value);
    }
    return { fingerprint, files: statuses, redactionValues: [...redactionValues] };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}

function validateRuntimeFiles(files: TaskRuntimeFile[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    safeRuntimePath(file.targetPath);
    if (ids.has(file.id)) throw new SkillRuntimeError("duplicate_runtime_file", "运行配置包含重复文件 ID。", true);
    ids.add(file.id);
    const pathKey = runtimePathCollisionKey(file.targetPath);
    if (paths.has(pathKey)) throw new SkillRuntimeError("duplicate_runtime_path", `运行配置包含跨平台冲突路径 ${file.targetPath}。`, true);
    paths.add(pathKey);
    if (file.desiredState === "present") total += file.size;
  }
  if (total > MAX_RUNTIME_FILE_TOTAL_BYTES) throw new SkillRuntimeError("runtime_files_too_large", "运行配置文件总量超过 5 MiB。", true);
}

function validateEnvironmentNames(names: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED_ENVIRONMENT.test(name)) {
      throw new SkillRuntimeError("runtime_environment_name_forbidden", `运行凭证变量 ${name} 不允许注入。`, true);
    }
    if (seen.has(name)) throw new SkillRuntimeError("duplicate_runtime_environment", "运行配置包含重复环境变量。", true);
    seen.add(name);
  }
}

function sanitizedTaskEnvironment(runtimeValues: Record<string, string>, controlNames: string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !isRunnerControlEnvironment(name, controlNames)) environment[name] = value;
  }
  for (const [name, value] of Object.entries(runtimeValues)) environment[name] = value;
  return environment;
}

export function isolatedCodexEnvironment(
  runtimeValues: Record<string, string> = {},
  runtimeNames: string[] = Object.keys(runtimeValues),
  controlNames: string[] = []
): { environment: NodeJS.ProcessEnv; allowlist: string[] } {
  const environment = sanitizedTaskEnvironment(runtimeValues, controlNames);
  return { environment, allowlist: commandEnvironmentAllowlist(environment, runtimeNames, controlNames) };
}

function commandEnvironmentAllowlist(environment: NodeJS.ProcessEnv, runtimeNames: string[], controlNames: string[]): string[] {
  const runtime = new Set(runtimeNames);
  return [...new Set([
    ...SAFE_SHELL_ENVIRONMENT,
    ...Object.keys(environment).filter((name) => !isRunnerControlEnvironment(name, controlNames) && (!LIKELY_SECRET_ENVIRONMENT.test(name) || runtime.has(name))),
    ...runtimeNames
  ])].filter((name) => environment[name] !== undefined || runtime.has(name)).sort();
}

function runnerControlEnvironmentNames(config: ResolvedWorkerConfig): string[] {
  return config.deviceTokenEnvironmentName ? [config.deviceTokenEnvironmentName] : [];
}

function isRunnerControlEnvironment(name: string, controlNames: string[]): boolean {
  return RUNNER_CONTROL_ENVIRONMENT.test(name) || controlNames.some((item) => item.toUpperCase() === name.toUpperCase());
}

function sensitiveConfigValues(content: string): string[] {
  const values = new Set<string>();
  const sensitiveKey = /(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|auth)/i;
  const add = (value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    const normalized = String(value).trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
    if (normalized.length >= 4) values.add(normalized);
  };
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const nested of value) walk(nested); return; }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (sensitiveKey.test(key)) add(nested);
      walk(nested);
    }
  };
  try { walk(parseYaml(content)); } catch { /* dotenv and arbitrary text are handled below */ }
  for (const match of content.matchAll(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g)) add(match[0]);
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.*?)\s*$/.exec(line);
    if (match && sensitiveKey.test(match[1]!)) add(match[2]);
  }
  return [...values];
}

function safeRuntimePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) throw runtimeConflict("runtime_file_path_invalid", value);
  if (value !== value.normalize("NFC")) throw runtimeConflict("runtime_file_path_invalid", value);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || RESERVED_RUNTIME_PATH_PARTS.has(part.toLowerCase()))) {
    throw runtimeConflict("runtime_file_path_invalid", value);
  }
  return parts.join("/");
}

function portablePathCollisionKey(value: string): string {
  return value.normalize("NFC").split("/").map((part) => part.toLowerCase()).join("/");
}

function runtimePathCollisionKey(value: string): string {
  return portablePathCollisionKey(safeRuntimePath(value));
}

function runtimeTarget(workspacePath: string, targetPath: string): string {
  const safePath = safeRuntimePath(targetPath);
  const target = resolve(workspacePath, ...safePath.split("/"));
  if (!isPathInside(workspacePath, target)) throw runtimeConflict("runtime_file_path_invalid", targetPath);
  return target;
}

async function readRuntimeManifest(path: string): Promise<RuntimeManifest> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RuntimeManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.files) || typeof parsed.runtimeConfigFingerprint !== "string") throw new Error("invalid manifest");
    const paths = new Set<string>();
    for (const file of parsed.files) {
      const key = runtimePathCollisionKey(file.targetPath);
      if (paths.has(key)) throw new Error("duplicate manifest path");
      paths.add(key);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, runtimeConfigFingerprint: "0".repeat(64), files: [] };
    throw new SkillRuntimeError("runtime_manifest_invalid", "工作区运行配置清单损坏，已暂停。", true);
  }
}

async function fileDigest(path: string, targetPath: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new SkillRuntimeError("runtime_file_type_conflict", "配置文件目标不是普通文件。", true, targetPath);
    const digest = createHash("sha256");
    digest.update(await readFile(path));
    return digest.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function prepareGitExclude(workspacePath: string): Promise<string | null> {
  const gitEntry = join(workspacePath, ".git");
  const entryInfo = await lstat(gitEntry).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!entryInfo) return null;
  if (entryInfo.isSymbolicLink()) throw new SkillRuntimeError("git_exclude_unsafe", "Git 元数据路径为符号链接，未写入托管内容。", true);
  let gitDirectory = gitEntry;
  const linkedWorktree = entryInfo.isFile();
  if (linkedWorktree) {
    const pointer = (await readSmallRegularFileNoFollow(gitEntry)).trim();
    const match = /^gitdir: ([^\r\n]+)$/.exec(pointer);
    if (!match || match[1]!.includes("\0")) throw new SkillRuntimeError("git_exclude_unsafe", "Git worktree 元数据无效，未写入托管内容。", true);
    gitDirectory = resolve(workspacePath, match[1]!);
  } else if (!entryInfo.isDirectory()) {
    throw new SkillRuntimeError("git_exclude_unsafe", "Git 元数据类型无效，未写入托管内容。", true);
  }
  const gitInfo = await lstat(gitDirectory).catch(() => null);
  if (!gitInfo?.isDirectory() || gitInfo.isSymbolicLink()) throw new SkillRuntimeError("git_exclude_unsafe", "Git 元数据目录不可安全访问，未写入托管内容。", true);
  const commonPointer = join(gitDirectory, "commondir");
  const commonInfo = await lstat(commonPointer).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  let commonDirectory = gitDirectory;
  if (linkedWorktree) {
    if (!commonInfo) throw new SkillRuntimeError("git_exclude_unsafe", "Git worktree 缺少公共目录指针，未写入托管内容。", true);
    if (!commonInfo.isFile() || commonInfo.isSymbolicLink()) throw new SkillRuntimeError("git_exclude_unsafe", "Git 公共目录指针无效，未写入托管内容。", true);
    const pointer = (await readSmallRegularFileNoFollow(commonPointer)).trim();
    if (!pointer || pointer.includes("\0") || /[\r\n]/.test(pointer)) throw new SkillRuntimeError("git_exclude_unsafe", "Git 公共目录指针无效，未写入托管内容。", true);
    commonDirectory = resolve(gitDirectory, pointer);
  }
  const commonDirectoryInfo = await lstat(commonDirectory).catch(() => null);
  if (!commonDirectoryInfo?.isDirectory() || commonDirectoryInfo.isSymbolicLink()) throw new SkillRuntimeError("git_exclude_unsafe", "Git 公共目录不可安全访问，未写入托管内容。", true);
  if (linkedWorktree) {
    const reversePointer = join(gitDirectory, "gitdir");
    const reverseInfo = await lstat(reversePointer).catch(() => null);
    if (!reverseInfo?.isFile() || reverseInfo.isSymbolicLink()) throw new SkillRuntimeError("git_exclude_unsafe", "Git worktree 缺少反向指针，未写入托管内容。", true);
    const reverse = (await readSmallRegularFileNoFollow(reversePointer)).trim();
    if (!reverse || /[\0\r\n]/.test(reverse) || resolve(gitDirectory, reverse) !== resolve(gitEntry)) {
      throw new SkillRuntimeError("git_exclude_unsafe", "Git worktree 反向指针不匹配，未写入托管内容。", true);
    }
    const worktreesRoot = join(commonDirectory, "worktrees");
    if (!isPathInside(worktreesRoot, gitDirectory) || resolve(worktreesRoot) === resolve(gitDirectory)) {
      throw new SkillRuntimeError("git_exclude_unsafe", "Git worktree 元数据不属于公共仓库，未写入托管内容。", true);
    }
    const headInfo = await lstat(join(commonDirectory, "HEAD")).catch(() => null);
    const objectsInfo = await lstat(join(commonDirectory, "objects")).catch(() => null);
    if (!headInfo?.isFile() || headInfo.isSymbolicLink() || !objectsInfo?.isDirectory() || objectsInfo.isSymbolicLink()) {
      throw new SkillRuntimeError("git_exclude_unsafe", "Git worktree 公共仓库结构无效，未写入托管内容。", true);
    }
  }
  const infoDirectory = join(commonDirectory, "info");
  const currentInfo = await lstat(infoDirectory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (currentInfo?.isSymbolicLink() || (currentInfo && !currentInfo.isDirectory())) throw new SkillRuntimeError("git_exclude_unsafe", "Git 排除目录不可安全写入，未写入托管内容。", true);
  if (!currentInfo) await mkdir(infoDirectory, { mode: 0o700 });
  const excludePath = join(infoDirectory, "exclude");
  const excludeInfo = await lstat(excludePath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (excludeInfo?.isSymbolicLink() || (excludeInfo && !excludeInfo.isFile())) throw new SkillRuntimeError("git_exclude_unsafe", "Git 排除文件不可安全写入，未写入托管内容。", true);
  return excludePath;
}

async function addGitExclude(excludePath: string | null, targetPath: string): Promise<void> {
  if (!excludePath) return;
  const rule = `/${escapeGitIgnore(targetPath)}\n`;
  const existing = await readFile(excludePath, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (existing.split(/\r?\n/).includes(rule.trimEnd())) return;
  const handle = await open(excludePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600)
    .catch(() => { throw new SkillRuntimeError("git_exclude_unsafe", "Git 排除文件不可安全写入，未写入托管内容。", true); });
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new SkillRuntimeError("git_exclude_unsafe", "Git 排除文件类型无效，未写入托管内容。", true);
    await handle.writeFile(rule, "utf8");
    await handle.sync();
    const current = await lstat(excludePath).catch(() => null);
    if (!current?.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new SkillRuntimeError("git_exclude_unsafe", "Git 排除文件在写入时发生变化，未写入托管内容。", true);
    }
  } finally {
    await handle.close();
  }
  const verified = await readSmallRegularFileNoFollow(excludePath);
  if (!verified.split(/\r?\n/).includes(rule.trimEnd())) throw new SkillRuntimeError("git_exclude_unsafe", "Git 排除规则未能安全持久化，未写入托管内容。", true);
}

async function readSmallRegularFileNoFollow(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4_096) throw new SkillRuntimeError("git_exclude_unsafe", "Git 元数据文件无效，未写入托管内容。", true);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function escapeGitIgnore(value: string): string {
  return value.replace(/([\\*?\[\]#!])/g, "\\$1").replace(/ /g, "\\ ");
}

async function ensureDirectoryWithoutSymlink(root: string, path: string): Promise<void> {
  if (!isPathInside(root, path)) throw new SkillRuntimeError("managed_path_outside_workspace", "托管目录超出聊天工作区。", true);
  const pathParts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const part of pathParts) {
    current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new SkillRuntimeError("managed_path_symlink", "托管目录路径包含符号链接。", true);
    if (info && !info.isDirectory()) throw new SkillRuntimeError("managed_path_conflict", "托管目录路径被普通文件占用。", true);
    if (!info) await mkdir(current, { mode: 0o700 });
  }
}

async function assertNoSymlinkComponents(root: string, target: string, targetPath: string): Promise<void> {
  if (!isPathInside(root, target)) throw new SkillRuntimeError("runtime_file_path_invalid", "配置文件路径超出聊天工作区。", true);
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) break;
    if (info.isSymbolicLink()) throw new SkillRuntimeError("runtime_file_symlink", "配置文件路径包含符号链接，未执行写入。", true, targetPath);
  }
}

function isPathInside(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function runtimeConflict(code: string, path: string): SkillRuntimeError {
  return new SkillRuntimeError(code, `配置文件 ${path || "目标路径"} 与工作区现状冲突，未执行覆盖或删除。`, true, path || null);
}

async function readSkillHubMetadata(skillPath: string): Promise<WorkerUserSkill["skillhub"]> {
  try {
    const raw = JSON.parse(await readFile(join(dirname(skillPath), ".skillhub", "metadata.json"), "utf8")) as Record<string, unknown>;
    const namespace = typeof raw.namespace === "string" ? raw.namespace : typeof raw.skillNamespace === "string" ? raw.skillNamespace : null;
    const slug = typeof raw.slug === "string" ? raw.slug : typeof raw.skillSlug === "string" ? raw.skillSlug : null;
    const version = typeof raw.version === "string" ? raw.version : null;
    if (!namespace || !slug || !version) return null;
    const coordinate = `@${namespace}/${slug}`;
    if (!/^@[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,127}$/.test(coordinate)) return null;
    return { coordinate, version };
  } catch {
    return null;
  }
}

function redactUserSkillPath(path: string): string {
  const home = resolve(homedir());
  const absolute = resolve(path);
  if (isPathInside(home, absolute)) return `~/${relative(home, absolute).split(sep).join("/")}`.slice(0, 1_024);
  return `[user-skill]/${basename(dirname(path))}/${basename(path)}`.slice(0, 1_024);
}

function sanitizeSkillError(value: string): string {
  void value;
  return "用户级技能扫描遇到错误，已保留上次可用清单。";
}
