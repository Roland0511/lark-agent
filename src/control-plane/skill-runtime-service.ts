import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import { randomToken, sha256 } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";
import type { ControlPlaneConfig } from "./config.js";
import type { AdminEventBus } from "./admin-events.js";
import { executorHasClaimCapacity, lockExecutorClaim } from "./executor-claim-lock.js";
import { SkillSecretBox, type EncryptedSecret } from "./skill-runtime-crypto.js";
import { normalizeDeclaredDependencies, SkillHubService, parseSkillCoordinate } from "./skillhub-service.js";
import { chatDisplayName } from "./chat-display-name.js";

const MAX_EFFECTIVE_SKILLS = 64;
const MAX_ENV_PER_BINDING = 64;
const MAX_ENV_VALUE_BYTES = 16 * 1024;
const MAX_ENV_TOTAL_BYTES = 256 * 1024;
const MAX_FILES_PER_BINDING = 20;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_EFFECTIVE_FILES = 40;
const MIN_SYNC_LEASE_SECONDS = 15 * 60;
const blockedEnvironmentNames = new Set([
  "HOME", "PATH", "CODEX_HOME", "CODEX_SQLITE_HOME", "NODE_OPTIONS", "BASH_ENV", "ENV", "SHELLOPTS", "CDPATH", "GLOBIGNORE",
  "ZDOTDIR", "PS4", "GIT_ASKPASS", "SSH_ASKPASS", "PYTHONPATH", "RUBYOPT"
]);
const reservedRoots = new Set([".git", ".codex", ".agents", ".lark-agent"]);

export interface TaskSkillSnapshot {
  packageId: string;
  coordinate: string;
  name: string;
  description: string;
  version: string;
  registryFingerprint: string;
  archiveSha256: string;
  archiveSize: number;
  downloadPath: string;
  scope: "bot" | "chat_context";
  bindingId: string;
}

export interface RuntimeEnvironmentSnapshot {
  id: string;
  bindingId: string;
  name: string;
  revision: number;
  scope: "bot" | "chat_context";
}

export interface RuntimeFileSnapshot {
  id: string;
  bindingId: string;
  targetPath: string;
  revision: number;
  sha256: string | null;
  size: number;
  desiredState: "present" | "absent";
  scope: "bot" | "chat_context";
  downloadPath: string | null;
}

export interface TaskRuntimeSnapshot {
  environment: RuntimeEnvironmentSnapshot[];
  files: RuntimeFileSnapshot[];
}

interface ReportedRuntimeFile {
  id: string;
  targetPath: string;
  revision?: number | null;
  actualSha256?: string | null;
  status: "applied" | "deleted" | "unchanged" | "conflict" | "failed";
  errorCode?: string | null;
}

export function validateRuntimeFileResults(expected: RuntimeFileSnapshot[], reported: ReportedRuntimeFile[], applied: boolean): void {
  const wantedById = new Map(expected.map((file) => [file.id, file]));
  if (applied && expected.length !== reported.length) throw new AppError("运行结果未完整覆盖固定文件集合", 409, "runtime_result_incomplete");
  const seen = new Set<string>();
  for (const actual of reported) {
    const wanted = wantedById.get(actual.id);
    if (!wanted || seen.has(actual.id) || wanted.targetPath !== actual.targetPath || wanted.revision !== actual.revision) throw new AppError("运行结果包含未知、重复或过期的文件修订", 409, "runtime_result_mismatch");
    seen.add(actual.id);
    if (applied) {
      const validStatus = wanted.desiredState === "absent" ? ["deleted", "unchanged"].includes(actual.status) : ["applied", "unchanged"].includes(actual.status);
      const validDigest = wanted.desiredState === "absent" ? actual.actualSha256 === null : actual.actualSha256 === wanted.sha256;
      if (!validStatus || !validDigest || actual.errorCode) throw new AppError("运行成功结果与期望文件状态不一致", 409, "runtime_result_mismatch");
    } else if (!["conflict", "failed"].includes(actual.status) || !actual.errorCode) {
      throw new AppError("运行失败结果缺少对应文件错误", 409, "sync_result_mismatch");
    }
  }
}

function normalizeSkillPackage(value: Record<string, unknown>) {
  return {
    packageId: value.packageId, coordinate: value.coordinate, name: value.name, version: value.version,
    registryFingerprint: value.registryFingerprint, archiveSha256: value.archiveSha256, sourceScope: value.sourceScope ?? value.scope
  };
}

export function validateRuntimeIdentity(expectedSkills: Record<string, unknown>[], reportedSkills: Record<string, unknown>[], expectedNames: string[], reportedNames: string[]): void {
  const expected = expectedSkills.map(normalizeSkillPackage).sort((left, right) => String(left.packageId).localeCompare(String(right.packageId)));
  const reported = reportedSkills.map(normalizeSkillPackage).sort((left, right) => String(left.packageId).localeCompare(String(right.packageId)));
  if (JSON.stringify(expected) !== JSON.stringify(reported)) throw new AppError("Runner 上报的托管技能集合与任务快照不一致", 409, "runtime_snapshot_mismatch");
  if (JSON.stringify([...expectedNames].sort()) !== JSON.stringify([...reportedNames].sort())) throw new AppError("Runner 上报的环境变量名称集合不完整", 409, "runtime_snapshot_mismatch");
}

function parseArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function parseRuntime(value: unknown): TaskRuntimeSnapshot {
  if (!value || typeof value !== "object") return { environment: [], files: [] };
  const record = value as Record<string, unknown>;
  return { environment: parseArray<RuntimeEnvironmentSnapshot>(record.environment), files: parseArray<RuntimeFileSnapshot>(record.files) };
}

function canonicalFingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function secretAad(kind: "env" | "file", id: string, bindingId: string, contextId: string | null, target: string, revision: number): string {
  return `${kind}:${id}:${bindingId}:${contextId ?? "global"}:${target}:${revision}`;
}

function encryptedFromRow(row: { key_id: string | null; nonce: string | null; ciphertext: string | null; auth_tag: string | null }): EncryptedSecret {
  if (!row.key_id || !row.nonce || !row.ciphertext || !row.auth_tag) throw new AppError("技能运行凭证修订不完整", 500, "skill_runtime_secret_invalid");
  return { keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag };
}

export function validateEnvironmentName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) throw new AppError("环境变量名称格式无效", 400, "invalid_environment_name");
  const securityKey = normalized.toUpperCase();
  if (blockedEnvironmentNames.has(securityKey) || securityKey.startsWith("LARK_AGENT_") || securityKey.startsWith("SKILL_RUNTIME_")
    || securityKey.startsWith("LD_") || securityKey.startsWith("DYLD_") || securityKey.startsWith("GIT_CONFIG")) {
    throw new AppError("该安全关键环境变量不能由技能覆盖", 400, "reserved_environment_name");
  }
  return normalized;
}

export function validateRuntimeFilePath(input: string): string {
  const value = input.trim();
  if (value !== value.normalize("NFC")) throw new AppError("配置文件路径必须使用 Unicode NFC 格式", 400, "invalid_runtime_file_path");
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new AppError("配置文件必须使用工作区内的相对路径", 400, "invalid_runtime_file_path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw new AppError("配置文件路径包含不安全片段", 400, "invalid_runtime_file_path");
  }
  if (segments.some((segment) => reservedRoots.has(segment.normalize("NFC").toLowerCase()))) throw new AppError("配置文件不能写入系统保留目录", 400, "reserved_runtime_file_path");
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized.length > 512) throw new AppError("配置文件路径格式无效", 400, "invalid_runtime_file_path");
  return normalized;
}

export function runtimePathCollisionKey(input: string): string {
  return validateRuntimeFilePath(input).normalize("NFC").toLowerCase();
}

function assertUtf8Text(content: Buffer): void {
  if (!content.length || content.length > MAX_FILE_BYTES || content.includes(0)) throw new AppError("配置文件必须是 1 MiB 以内且不含 NUL 的文本", 400, "invalid_runtime_file");
  try { new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { throw new AppError("配置文件必须是 UTF-8 文本", 400, "invalid_runtime_file"); }
}

export class SkillRuntimeService {
  readonly hub: SkillHubService;
  readonly secrets: SkillSecretBox;

  constructor(private readonly db: Kysely<Database>, config: ControlPlaneConfig, private readonly events: AdminEventBus) {
    this.hub = new SkillHubService(db, config);
    this.secrets = new SkillSecretBox(config.skillRuntimeEncryptionKeys, config.skillRuntimeActiveKeyId);
  }

  private async lockBot(trx: Transaction<Database>, botId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtext(${`skill-runtime:${botId}`}))`.execute(trx);
  }

  private async assertBindingLocked(trx: Transaction<Database>, botId: string, bindingId: string): Promise<void> {
    const binding = await trx.selectFrom("bot_skill_bindings").select("id").where("id", "=", bindingId).where("bot_id", "=", botId).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
    if (!binding) throw new AppError("技能绑定已变化，请刷新后重试", 409, "skill_binding_revision_conflict");
  }

  private async validateBindingScopeQuota(trx: Transaction<Database>, bindingId: string, contextId: string | null): Promise<void> {
    let environmentQuery = trx.selectFrom("skill_runtime_environment_revisions").select([
      sql<number>`count(*)::int`.as("count"), sql<number>`coalesce(sum(value_size), 0)::int`.as("bytes")
    ]).where("binding_id", "=", bindingId).where("superseded_at", "is", null).where("desired_state", "=", "present");
    environmentQuery = contextId ? environmentQuery.where("chat_context_id", "=", contextId) : environmentQuery.where("chat_context_id", "is", null);
    const environment = await environmentQuery.executeTakeFirstOrThrow();
    if (environment.count > MAX_ENV_PER_BINDING || environment.bytes > MAX_ENV_TOTAL_BYTES) throw new AppError("单个技能在当前作用域的环境变量超过数量或总大小限制", 409, "runtime_environment_limit");

    let fileQuery = trx.selectFrom("skill_runtime_file_revisions").select([
      sql<number>`count(*)::int`.as("count"), sql<number>`coalesce(sum(content_size), 0)::int`.as("bytes")
    ]).where("binding_id", "=", bindingId).where("superseded_at", "is", null).where("desired_state", "=", "present");
    fileQuery = contextId ? fileQuery.where("chat_context_id", "=", contextId) : fileQuery.where("chat_context_id", "is", null);
    const files = await fileQuery.executeTakeFirstOrThrow();
    if (files.count > MAX_FILES_PER_BINDING || files.bytes > MAX_FILE_TOTAL_BYTES) throw new AppError("单个技能在当前作用域的配置文件超过数量或总大小限制", 409, "runtime_file_limit");
  }

  async assertBinding(bindingId: string, botId?: string) {
    let query = this.db.selectFrom("bot_skill_bindings").selectAll().where("id", "=", bindingId).where("deleted_at", "is", null);
    if (botId) query = query.where("bot_id", "=", botId);
    const binding = await query.executeTakeFirst();
    if (!binding) throw new AppError("技能绑定不存在", 404, "skill_binding_not_found");
    return binding;
  }

  private async assertBotAndContext(botId: string, contextId: string | null): Promise<void> {
    const bot = await this.db.selectFrom("bots").select("id").where("id", "=", botId).where("deleted_at", "is", null).executeTakeFirst();
    if (!bot) throw new AppError("机器人不存在", 404, "bot_not_found");
    if (!contextId) return;
    const context = await this.db.selectFrom("chat_contexts").select("id").where("id", "=", contextId).where("bot_id", "=", botId).executeTakeFirst();
    if (!context) throw new AppError("聊天记忆不属于该机器人", 409, "chat_context_bot_mismatch");
  }

  private async assertNoUserSkillConflict(botId: string, contextId: string | null, skillName: string): Promise<void> {
    let query = this.db.selectFrom("workers").select(["workers.executor_id", "workers.user_skills"])
      .where("workers.deleted_at", "is", null).where("workers.user_skills_scan_status", "in", ["ready", "stale"]);
    if (contextId) {
      query = query.where("workers.executor_id", "in", this.db.selectFrom("chat_contexts").select("executor_id").where("id", "=", contextId).where("executor_id", "is not", null));
    } else {
      query = query.where("workers.executor_id", "in", this.db.selectFrom("chat_contexts").select("executor_id").where("bot_id", "=", botId).where("executor_id", "is not", null));
    }
    const workers = await query.execute();
    const conflict = workers.find((worker) => Array.isArray(worker.user_skills) && worker.user_skills.some((item) => item && typeof item === "object" && (item as { name?: string }).name === skillName));
    if (conflict) throw new AppError(`技能名称 ${skillName} 与执行器 ${conflict.executor_id} 已生效的用户级技能冲突`, 409, "runner_user_skill_conflict");
  }

  async listBindings(botId: string) {
    await this.assertBotAndContext(botId, null);
    const rows = await this.db.selectFrom("bot_skill_bindings").innerJoin("skillhub_packages", "skillhub_packages.id", "bot_skill_bindings.package_id")
      .selectAll("bot_skill_bindings").select([
        "skillhub_packages.version", "skillhub_packages.registry_fingerprint", "skillhub_packages.archive_sha256",
        "skillhub_packages.skill_name", "skillhub_packages.description", "skillhub_packages.dependencies",
        sql<string | null>`(select binding.chat_name from chat_contexts context left join bot_chat_bindings binding on binding.bot_id = context.bot_id and binding.chat_id = context.chat_id where context.id = bot_skill_bindings.chat_context_id)`.as("chat_name"),
        sql<string | null>`(select context.chat_type from chat_contexts context where context.id = bot_skill_bindings.chat_context_id)`.as("chat_type"),
        sql<string | null>`(select context.peer_open_id from chat_contexts context where context.id = bot_skill_bindings.chat_context_id)`.as("peer_open_id"),
        sql<string | null>`(select context.peer_display_name from chat_contexts context where context.id = bot_skill_bindings.chat_context_id)`.as("peer_display_name"),
        sql<number>`(select count(*)::int from skill_runtime_environment_revisions env where env.binding_id = bot_skill_bindings.id and env.superseded_at is null and env.desired_state = 'present')`.as("environment_count"),
        sql<number>`(select count(*)::int from skill_runtime_file_revisions file where file.binding_id = bot_skill_bindings.id and file.superseded_at is null and file.desired_state = 'present')`.as("file_count"),
        sql<string | null>`(select case when context.skills_sync_error is not null then 'error' when context.desired_skill_set_fingerprint is distinct from context.applied_skill_set_fingerprint then 'pending' when context.skills_synced_at is not null then 'applied' else 'unknown' end from chat_contexts context where context.id = bot_skill_bindings.chat_context_id)`.as("sync_status")
      ]).where("bot_skill_bindings.bot_id", "=", botId).where("bot_skill_bindings.deleted_at", "is", null)
      .orderBy("bot_skill_bindings.chat_context_id").orderBy("bot_skill_bindings.namespace").orderBy("bot_skill_bindings.slug").execute();
    const contexts = await this.db.selectFrom("chat_contexts").select(["id", "skills_sync_error", "desired_skill_set_fingerprint", "applied_skill_set_fingerprint", "skills_synced_at"]).where("bot_id", "=", botId).execute();
    return rows.map((row) => ({
      id: row.id, coordinate: `@${row.namespace}/${row.slug}`, scope: row.chat_context_id ? "chat_context" : "bot",
      chatContextId: row.chat_context_id, version: row.version, registryFingerprint: row.registry_fingerprint,
      archiveSha256: row.archive_sha256, name: row.skill_name, description: row.description,
      declaredDependencies: normalizeDeclaredDependencies(row.dependencies),
      chatName: row.chat_name,
      chatDisplayName: row.chat_context_id ? chatDisplayName({ chatType: row.chat_type ?? "p2p", chatName: row.chat_name, peerOpenId: row.peer_open_id, peerDisplayName: row.peer_display_name }) : null,
      peerOpenId: row.peer_open_id, peerDisplayName: row.peer_display_name,
      environmentCount: Number(row.environment_count), fileCount: Number(row.file_count),
      syncStatus: row.chat_context_id ? row.sync_status : contexts.some((context) => context.skills_sync_error) ? "error"
        : contexts.some((context) => context.desired_skill_set_fingerprint !== context.applied_skill_set_fingerprint) ? "pending"
          : contexts.length && contexts.every((context) => context.skills_synced_at) ? "applied" : "unknown",
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()
    }));
  }

  async addBinding(botId: string, coordinate: string, contextId: string | null, actor: string) {
    await this.assertBotAndContext(botId, contextId);
    const parsed = parseSkillCoordinate(coordinate);
    const inherited = await this.db.selectFrom("bot_skill_bindings").select("id").where("bot_id", "=", botId).where("namespace", "=", parsed.namespace).where("slug", "=", parsed.slug)
      .where("deleted_at", "is", null).where(contextId ? "chat_context_id" : "chat_context_id", contextId ? "=" : "is", contextId).executeTakeFirst();
    if (inherited) throw new AppError("该技能已在当前作用域生效", 409, "skill_binding_exists");
    const pkg = await this.hub.resolveAndCache(coordinate);
    await this.assertNoUserSkillConflict(botId, contextId, pkg.skill_name);
    const conflictingName = await this.db.selectFrom("bot_skill_bindings").innerJoin("skillhub_packages", "skillhub_packages.id", "bot_skill_bindings.package_id")
      .select(["bot_skill_bindings.id", "bot_skill_bindings.namespace", "bot_skill_bindings.slug"])
      .where("bot_skill_bindings.bot_id", "=", botId).where("bot_skill_bindings.deleted_at", "is", null).where("skillhub_packages.skill_name", "=", pkg.skill_name)
      .where((eb) => eb.or([eb("bot_skill_bindings.namespace", "!=", parsed.namespace), eb("bot_skill_bindings.slug", "!=", parsed.slug)]))
      .where((eb) => contextId ? eb.or([eb("bot_skill_bindings.chat_context_id", "is", null), eb("bot_skill_bindings.chat_context_id", "=", contextId)]) : eb.val(true)).executeTakeFirst();
    if (conflictingName) throw new AppError(`技能名称 ${pkg.skill_name} 已由 @${conflictingName.namespace}/${conflictingName.slug} 使用`, 409, "skill_name_conflict");
    let binding!: Awaited<ReturnType<SkillRuntimeService["assertBinding"]>>;
    let affectedContexts: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      await this.lockBot(trx, botId);
      binding = await trx.insertInto("bot_skill_bindings").values({
        bot_id: botId, chat_context_id: contextId, package_id: pkg.id, namespace: parsed.namespace, slug: parsed.slug,
        created_by: actor, deleted_at: null, updated_at: new Date()
      }).returningAll().executeTakeFirstOrThrow();
      await this.validateAffectedSkillCounts(trx, botId, contextId);
      await this.invalidateTaskSnapshots(botId, contextId, trx);
      affectedContexts = await this.enqueueSyncForBinding(binding, undefined, undefined, trx);
    });
    await this.audit(actor, "skill.binding.create", botId, binding.id, contextId, coordinate, null);
    this.events.publish("skill", binding.id); this.events.publish("bot", botId); for (const id of affectedContexts) this.events.publish("chat_context", id);
    return binding;
  }

  async updateBinding(botId: string, bindingId: string, actor: string) {
    const binding = await this.assertBinding(bindingId, botId);
    const pkg = await this.hub.resolveAndCache(`@${binding.namespace}/${binding.slug}`);
    if (pkg.id === binding.package_id) return { binding, updated: false };
    await this.assertNoUserSkillConflict(botId, binding.chat_context_id, pkg.skill_name);
    const conflict = await this.db.selectFrom("bot_skill_bindings").innerJoin("skillhub_packages", "skillhub_packages.id", "bot_skill_bindings.package_id")
      .select("bot_skill_bindings.id").where("bot_skill_bindings.bot_id", "=", botId).where("bot_skill_bindings.id", "!=", binding.id)
      .where("bot_skill_bindings.deleted_at", "is", null).where("skillhub_packages.skill_name", "=", pkg.skill_name)
      .where((eb) => eb.or([eb("bot_skill_bindings.namespace", "!=", binding.namespace), eb("bot_skill_bindings.slug", "!=", binding.slug)]))
      .where((eb) => binding.chat_context_id ? eb.or([eb("bot_skill_bindings.chat_context_id", "is", null), eb("bot_skill_bindings.chat_context_id", "=", binding.chat_context_id)]) : eb.val(true)).executeTakeFirst();
    if (conflict) throw new AppError(`升级后的技能名称 ${pkg.skill_name} 与现有技能冲突`, 409, "skill_name_conflict");
    let updated!: typeof binding;
    let affectedContexts: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      await this.lockBot(trx, botId);
      await this.assertBindingLocked(trx, botId, binding.id);
      updated = await trx.updateTable("bot_skill_bindings").set({ package_id: pkg.id, updated_at: new Date() }).where("id", "=", binding.id).returningAll().executeTakeFirstOrThrow();
      await this.validateAffectedSkillCounts(trx, botId, binding.chat_context_id);
      await this.invalidateTaskSnapshots(botId, binding.chat_context_id, trx);
      affectedContexts = await this.enqueueSyncForBinding(updated, undefined, undefined, trx);
    });
    await this.audit(actor, "skill.binding.update", botId, binding.id, binding.chat_context_id, `@${binding.namespace}/${binding.slug}`, null);
    this.events.publish("skill", binding.id); for (const id of affectedContexts) this.events.publish("chat_context", id);
    return { binding: updated, updated: true };
  }

  async deleteBinding(botId: string, bindingId: string, actor: string): Promise<void> {
    const binding = await this.assertBinding(bindingId, botId);
    const files = await this.db.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "=", binding.id).where("superseded_at", "is", null).execute();
    if (files.some((file) => file.desired_state === "present")) throw new AppError("请先删除该技能的工作区配置文件并等待同步完成", 409, "skill_binding_files_require_cleanup");
    const states = await this.db.selectFrom("skill_runtime_file_states").select(["target_path", "status"]).where("binding_id", "=", binding.id).execute();
    const pending = states.find((state) => !["deleted"].includes(state.status));
    if (pending) throw new AppError(`配置文件 ${pending.target_path} 尚未从工作区安全删除`, 409, "skill_binding_cleanup_pending");
    let affectedContexts: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      await this.lockBot(trx, botId);
      await this.assertBindingLocked(trx, botId, binding.id);
      const lockedFiles = await trx.selectFrom("skill_runtime_file_revisions").select("desired_state").where("binding_id", "=", binding.id).where("superseded_at", "is", null).execute();
      if (lockedFiles.some((file) => file.desired_state === "present")) throw new AppError("请先删除该技能的工作区配置文件并等待同步完成", 409, "skill_binding_files_require_cleanup");
      const lockedStates = await trx.selectFrom("skill_runtime_file_states").select(["target_path", "status"]).where("binding_id", "=", binding.id).execute();
      const lockedPending = lockedStates.find((state) => state.status !== "deleted");
      if (lockedPending) throw new AppError(`配置文件 ${lockedPending.target_path} 尚未从工作区安全删除`, 409, "skill_binding_cleanup_pending");
      await trx.updateTable("skill_runtime_file_revisions").set({ superseded_at: new Date() }).where("binding_id", "=", binding.id).where("superseded_at", "is", null).execute();
      await trx.updateTable("bot_skill_bindings").set({ deleted_at: new Date(), updated_at: new Date() }).where("id", "=", binding.id).execute();
      await this.validateAffectedSkillCounts(trx, botId, binding.chat_context_id);
      await this.validateAffectedRuntime(trx, botId, binding.chat_context_id);
      await this.invalidateTaskSnapshots(botId, binding.chat_context_id, trx);
      affectedContexts = await this.enqueueSyncForBinding(binding, undefined, undefined, trx);
    });
    await this.audit(actor, "skill.binding.delete", botId, binding.id, binding.chat_context_id, `@${binding.namespace}/${binding.slug}`, null);
    this.events.publish("skill", binding.id); for (const id of affectedContexts) this.events.publish("chat_context", id);
  }

  async listRuntimeConfig(botId: string, bindingId: string, contextId: string | null) {
    const binding = await this.assertBinding(bindingId, botId);
    await this.assertRuntimeScope(binding, contextId);
    const [environment, files] = await Promise.all([
      this.db.selectFrom("skill_runtime_environment_revisions").selectAll().where("binding_id", "=", binding.id).where("superseded_at", "is", null)
        .where((eb) => contextId ? eb.or([eb("chat_context_id", "is", null), eb("chat_context_id", "=", contextId)]) : eb("chat_context_id", "is", null)).orderBy("name").execute(),
      this.db.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "=", binding.id).where("superseded_at", "is", null)
        .where((eb) => contextId ? eb.or([eb("chat_context_id", "is", null), eb("chat_context_id", "=", contextId)]) : eb("chat_context_id", "is", null)).orderBy("target_path").execute()
    ]);
    let statesQuery = this.db.selectFrom("skill_runtime_file_states").selectAll().where("binding_id", "=", binding.id);
    if (contextId) statesQuery = statesQuery.where("chat_context_id", "=", contextId);
    const states = await statesQuery.execute();
    const effectiveEnvironment = new Map<string, typeof environment[number]>();
    for (const row of environment.sort((left, right) => Number(Boolean(left.chat_context_id)) - Number(Boolean(right.chat_context_id)))) effectiveEnvironment.set(row.name, row);
    const effectiveFiles = new Map<string, typeof files[number]>();
    for (const row of files.sort((left, right) => Number(Boolean(left.chat_context_id)) - Number(Boolean(right.chat_context_id)))) effectiveFiles.set(row.target_path_key, row);
    return {
      encryptionAvailable: this.secrets.available,
      environment: [...effectiveEnvironment.values()].sort((left, right) => left.name.localeCompare(right.name)).map((row) => ({
        id: row.id, name: row.name, configured: row.desired_state === "present",
        mode: row.desired_state === "absent" ? "disabled" : contextId && !row.chat_context_id ? "inherited" : row.chat_context_id ? "replace" : "configured",
        sourceScope: row.chat_context_id ? "chat_context" : "bot", scope: row.chat_context_id ? "chat_context" : "bot",
        chatContextId: row.chat_context_id, revision: row.revision, updatedAt: new Date(row.created_at).toISOString()
      })),
      files: [...effectiveFiles.values()].sort((left, right) => left.target_path.localeCompare(right.target_path)).map((row) => {
        const matchingStates = states.filter((item) => item.binding_id === row.binding_id && item.target_path === row.target_path && item.desired_file_revision_id === row.id);
        const statusPriority = ["error", "conflict", "drift", "pending_force", "pending", "pending_delete"] as const;
        let aggregateStatus = statusPriority.find((status) => matchingStates.some((item) => item.status === status))
          ?? (matchingStates.length && matchingStates.every((item) => item.status === "applied") ? "applied"
            : matchingStates.length && matchingStates.every((item) => item.status === "deleted") ? "deleted"
              : row.desired_state === "absent" ? "pending_delete" : "pending");
        const actualDigests = [...new Set(matchingStates.map((item) => item.actual_sha256).filter((digest): digest is string => Boolean(digest)))];
        if (aggregateStatus === "applied" && row.desired_state === "present" && (actualDigests.length !== 1 || actualDigests[0] !== row.content_sha256)) aggregateStatus = "drift";
        const checkedAt = matchingStates.reduce<Date | null>((latest, item) => {
          if (!item.checked_at) return latest;
          const current = new Date(item.checked_at);
          return !latest || current > latest ? current : latest;
        }, null);
        const lastError = matchingStates.find((item) => item.last_error)?.last_error ?? null;
        return {
          id: row.id, targetPath: row.target_path, desiredState: row.desired_state,
          mode: row.desired_state === "absent" ? "disabled" : contextId && !row.chat_context_id ? "inherited" : row.chat_context_id ? "replace" : "configured",
          sourceScope: row.chat_context_id ? "chat_context" : "bot", scope: row.chat_context_id ? "chat_context" : "bot",
          chatContextId: row.chat_context_id, revision: row.revision, sha256: row.content_sha256, size: Number(row.content_size),
          status: aggregateStatus, actualSha256: actualDigests.length === 1 ? actualDigests[0] : null,
          lastError, checkedAt: checkedAt?.toISOString() ?? null
        };
      })
    };
  }

  private async assertRuntimeScope(binding: Awaited<ReturnType<SkillRuntimeService["assertBinding"]>>, contextId: string | null): Promise<void> {
    if (contextId) await this.assertBotAndContext(binding.bot_id, contextId);
    if (binding.chat_context_id && binding.chat_context_id !== contextId) throw new AppError("Thread 专属技能只能配置对应聊天的运行依赖", 409, "runtime_scope_mismatch");
  }

  async putEnvironment(botId: string, bindingId: string, name: string, contextId: string | null, value: string | null, actor: string) {
    const binding = await this.assertBinding(bindingId, botId); await this.assertRuntimeScope(binding, contextId);
    const normalized = validateEnvironmentName(name);
    const content = value === null ? null : Buffer.from(value, "utf8");
    if (content && content.length === 0) throw new AppError("环境变量值不能为空", 400, "runtime_environment_value_required");
    if (content?.includes(0)) throw new AppError("环境变量值不能包含 NUL 字符", 400, "invalid_runtime_environment_value");
    if (content && content.length > MAX_ENV_VALUE_BYTES) throw new AppError("环境变量值超过 16 KiB", 400, "runtime_environment_too_large");
    let revision = 0;
    let id = "";
    await this.db.transaction().execute(async (trx) => {
      await this.lockBot(trx, botId);
      await this.assertBindingLocked(trx, botId, binding.id);
      let currentQuery = trx.selectFrom("skill_runtime_environment_revisions").selectAll().where("binding_id", "=", binding.id).where("name", "=", normalized).where("superseded_at", "is", null);
      currentQuery = contextId ? currentQuery.where("chat_context_id", "=", contextId) : currentQuery.where("chat_context_id", "is", null);
      const current = await currentQuery.executeTakeFirst();
      let historyQuery = trx.selectFrom("skill_runtime_environment_revisions").select(sql<number>`coalesce(max(revision), 0)::int`.as("revision")).where("binding_id", "=", binding.id).where("name", "=", normalized);
      historyQuery = contextId ? historyQuery.where("chat_context_id", "=", contextId) : historyQuery.where("chat_context_id", "is", null);
      const history = await historyQuery.executeTakeFirstOrThrow();
      revision = history.revision + 1;
      id = randomUUID();
      const encrypted = content ? this.secrets.encrypt(content, secretAad("env", id, binding.id, contextId, normalized, revision)) : null;
      if (current) await trx.updateTable("skill_runtime_environment_revisions").set({ superseded_at: new Date() }).where("id", "=", current.id).execute();
      await trx.insertInto("skill_runtime_environment_revisions").values({
        id, binding_id: binding.id, chat_context_id: contextId, name: normalized, desired_state: content ? "present" : "absent",
        key_id: encrypted?.keyId ?? null, nonce: encrypted?.nonce ?? null, ciphertext: encrypted?.ciphertext ?? null, auth_tag: encrypted?.authTag ?? null,
        value_size: content?.length ?? 0, revision, superseded_at: null, created_by: actor
      }).execute();
      await this.validateBindingScopeQuota(trx, binding.id, contextId);
      await this.validateAffectedRuntime(trx, botId, binding.chat_context_id ?? contextId);
      await this.invalidateTaskSnapshots(botId, binding.chat_context_id ?? contextId, trx);
    });
    await this.audit(actor, content ? "skill.runtime.env.put" : "skill.runtime.env.disable", botId, binding.id, contextId, normalized, revision);
    this.events.publish("skill", binding.id);
    return { id, name: normalized, configured: content !== null, revision };
  }

  async deleteEnvironment(botId: string, bindingId: string, name: string, contextId: string | null, restoreInheritance: boolean, actor: string) {
    const binding = await this.assertBinding(bindingId, botId); await this.assertRuntimeScope(binding, contextId);
    const normalized = validateEnvironmentName(name);
    let restoredRevision: number | null = null;
    if (restoreInheritance && contextId) {
      await this.db.transaction().execute(async (trx) => {
        await this.lockBot(trx, botId);
        await this.assertBindingLocked(trx, botId, binding.id);
        const current = await trx.selectFrom("skill_runtime_environment_revisions").selectAll().where("binding_id", "=", binding.id).where("name", "=", normalized)
          .where("chat_context_id", "=", contextId).where("superseded_at", "is", null).forUpdate().executeTakeFirst();
        restoredRevision = current?.revision ?? null;
        if (current) await trx.updateTable("skill_runtime_environment_revisions").set({ superseded_at: new Date() }).where("id", "=", current.id).execute();
        await this.validateAffectedRuntime(trx, botId, binding.chat_context_id ?? contextId);
        await this.invalidateTaskSnapshots(botId, binding.chat_context_id ?? contextId, trx);
      });
    } else {
      await this.putEnvironment(botId, bindingId, normalized, contextId, null, actor);
      return { ok: true };
    }
    await this.audit(actor, "skill.runtime.env.inherit", botId, binding.id, contextId, normalized, restoredRevision);
    this.events.publish("skill", binding.id);
    return { ok: true };
  }

  async putFile(botId: string, bindingId: string, targetPath: string, contextId: string | null, content: Buffer, actor: string, expectedFileId?: string) {
    const binding = await this.assertBinding(bindingId, botId); await this.assertRuntimeScope(binding, contextId);
    const normalized = validateRuntimeFilePath(targetPath); const collisionKey = runtimePathCollisionKey(normalized); assertUtf8Text(content);
    const current = await this.db.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "=", binding.id).where("target_path_key", "=", collisionKey).where("superseded_at", "is", null)
      .where(contextId ? "chat_context_id" : "chat_context_id", contextId ? "=" : "is", contextId).executeTakeFirst();
    if (current && current.target_path !== normalized) throw new AppError(`配置文件路径与 ${current.target_path} 在执行环境中冲突`, 409, "runtime_file_path_collision");
    if (expectedFileId) {
      const expected = await this.db.selectFrom("skill_runtime_file_revisions").selectAll().where("id", "=", expectedFileId).where("binding_id", "=", binding.id).where("superseded_at", "is", null).executeTakeFirst();
      if (!expected || expected.target_path !== normalized || (expected.chat_context_id !== contextId && !(contextId && expected.chat_context_id === null && !current))) {
        throw new AppError("配置文件已变化或目标路径与原修订不一致", 409, "runtime_file_revision_conflict");
      }
      if (current && current.id !== expectedFileId) throw new AppError("该 Thread 已存在更新后的配置文件覆盖", 409, "runtime_file_revision_conflict");
    }
    let statsQuery = this.db.selectFrom("skill_runtime_file_revisions").select([sql<number>`count(*)::int`.as("count"), sql<number>`coalesce(sum(content_size),0)::int`.as("bytes")]).where("binding_id", "=", binding.id).where("superseded_at", "is", null).where("desired_state", "=", "present");
    statsQuery = contextId ? statsQuery.where("chat_context_id", "=", contextId) : statsQuery.where("chat_context_id", "is", null);
    const stats = await statsQuery.executeTakeFirstOrThrow();
    if (current?.desired_state !== "present" && stats.count >= MAX_FILES_PER_BINDING) throw new AppError("单个技能在当前作用域最多配置 20 个文件", 409, "runtime_file_limit");
    if (stats.bytes - Number(current?.content_size ?? 0) + content.length > MAX_FILE_TOTAL_BYTES) throw new AppError("技能配置文件总大小超过 5 MiB", 409, "runtime_file_limit");
    let row: Awaited<ReturnType<SkillRuntimeService["createFileRevision"]>>;
    let affectedContexts: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      await this.lockBot(trx, botId);
      await this.assertBindingLocked(trx, botId, binding.id);
      const activeAtScope = await (contextId
        ? trx.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "=", binding.id).where("target_path_key", "=", collisionKey).where("chat_context_id", "=", contextId).where("superseded_at", "is", null)
        : trx.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "=", binding.id).where("target_path_key", "=", collisionKey).where("chat_context_id", "is", null).where("superseded_at", "is", null)).executeTakeFirst();
      if (!expectedFileId && activeAtScope) throw new AppError("该路径已有配置文件，请刷新后使用当前修订更新", 409, "runtime_file_revision_conflict");
      if (expectedFileId) {
        const expected = await trx.selectFrom("skill_runtime_file_revisions").selectAll().where("id", "=", expectedFileId).where("binding_id", "=", binding.id).where("target_path_key", "=", collisionKey).where("superseded_at", "is", null).executeTakeFirst();
        const sameScope = expected?.chat_context_id === contextId && activeAtScope?.id === expectedFileId;
        const inheritedOverride = Boolean(contextId && expected?.chat_context_id === null && !activeAtScope);
        if (!expected || (!sameScope && !inheritedOverride)) throw new AppError("配置文件已变化，请刷新后重试", 409, "runtime_file_revision_conflict");
      }
      row = await this.createFileRevision(trx, binding, contextId, normalized, content, actor);
      await this.validateBindingScopeQuota(trx, binding.id, contextId);
      await this.validateAffectedRuntime(trx, botId, binding.chat_context_id ?? contextId);
      await this.invalidateTaskSnapshots(botId, binding.chat_context_id ?? contextId, trx);
      affectedContexts = await this.enqueueSyncForBinding(binding, contextId, undefined, trx);
    });
    await this.audit(actor, "skill.runtime.file.put", botId, binding.id, contextId, normalized, row!.revision);
    this.events.publish("skill", binding.id); for (const id of affectedContexts) this.events.publish("chat_context", id);
    return { id: row!.id, targetPath: normalized, sha256: row!.content_sha256, size: Number(row!.content_size), revision: row!.revision };
  }

  private async createFileRevision(trx: Transaction<Database>, binding: { id: string; bot_id: string; chat_context_id: string | null }, contextId: string | null, targetPath: string, content: Buffer | null, actor: string) {
    const collisionKey = runtimePathCollisionKey(targetPath);
    const current = await trx.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "=", binding.id).where("target_path_key", "=", collisionKey).where("superseded_at", "is", null)
      .where(contextId ? "chat_context_id" : "chat_context_id", contextId ? "=" : "is", contextId).executeTakeFirst();
    if (current && current.target_path !== targetPath) throw new AppError(`配置文件路径与 ${current.target_path} 在执行环境中冲突`, 409, "runtime_file_path_collision");
    const history = await trx.selectFrom("skill_runtime_file_revisions").select(sql<number>`coalesce(max(revision), 0)::int`.as("revision"))
      .where("binding_id", "=", binding.id).where("target_path_key", "=", collisionKey).where(contextId ? "chat_context_id" : "chat_context_id", contextId ? "=" : "is", contextId).executeTakeFirstOrThrow();
    const revision = history.revision + 1;
    const id = randomUUID();
    const encrypted = content ? this.secrets.encrypt(content, secretAad("file", id, binding.id, contextId, targetPath, revision)) : null;
    if (current) await trx.updateTable("skill_runtime_file_revisions").set({ superseded_at: new Date() }).where("id", "=", current.id).execute();
    return trx.insertInto("skill_runtime_file_revisions").values({
      id, binding_id: binding.id, chat_context_id: contextId, target_path: targetPath, target_path_key: collisionKey, desired_state: content ? "present" : "absent",
      key_id: encrypted?.keyId ?? null, nonce: encrypted?.nonce ?? null, ciphertext: encrypted?.ciphertext ?? null, auth_tag: encrypted?.authTag ?? null,
      content_sha256: content ? sha256(content) : null, content_size: content?.length ?? 0, revision, superseded_at: null, created_by: actor
    }).returningAll().executeTakeFirstOrThrow();
  }

  async deleteFile(botId: string, bindingId: string, fileId: string, targetContextId: string | null, restoreInheritance: boolean, actor: string) {
    const binding = await this.assertBinding(bindingId, botId);
    const source = await this.db.selectFrom("skill_runtime_file_revisions").selectAll().where("id", "=", fileId).where("binding_id", "=", binding.id).executeTakeFirst();
    if (!source) throw new AppError("配置文件不存在", 404, "runtime_file_not_found");
    if (source.superseded_at) throw new AppError("配置文件已被更新，请刷新后重试", 409, "runtime_file_revision_conflict");
    const contextId = targetContextId ?? source.chat_context_id;
    await this.assertRuntimeScope(binding, contextId);
    const activeAtTarget = await this.db.selectFrom("skill_runtime_file_revisions").select("id").where("binding_id", "=", binding.id).where("target_path", "=", source.target_path).where("superseded_at", "is", null)
      .where(contextId ? "chat_context_id" : "chat_context_id", contextId ? "=" : "is", contextId).executeTakeFirst();
    if (activeAtTarget && activeAtTarget.id !== source.id && !(contextId && source.chat_context_id === null && !restoreInheritance)) throw new AppError("配置文件已被更新，请刷新后重试", 409, "runtime_file_revision_conflict");
    let affectedContexts: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      await this.lockBot(trx, botId);
      await this.assertBindingLocked(trx, botId, binding.id);
      const lockedSource = await trx.selectFrom("skill_runtime_file_revisions").selectAll().where("id", "=", source.id).where("binding_id", "=", binding.id).where("superseded_at", "is", null).executeTakeFirst();
      const activeAtScope = await (contextId
        ? trx.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "=", binding.id).where("target_path_key", "=", source.target_path_key).where("chat_context_id", "=", contextId).where("superseded_at", "is", null)
        : trx.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "=", binding.id).where("target_path_key", "=", source.target_path_key).where("chat_context_id", "is", null).where("superseded_at", "is", null)).executeTakeFirst();
      const sameScope = lockedSource?.chat_context_id === contextId && activeAtScope?.id === lockedSource?.id;
      const inheritedTarget = Boolean(contextId && lockedSource?.chat_context_id === null && !activeAtScope);
      if (!lockedSource || (restoreInheritance ? !sameScope : !sameScope && !inheritedTarget)) throw new AppError("配置文件已变化，请刷新后重试", 409, "runtime_file_revision_conflict");
      if (restoreInheritance && contextId) {
        await trx.updateTable("skill_runtime_file_revisions").set({ superseded_at: new Date() }).where("binding_id", "=", binding.id).where("chat_context_id", "=", contextId).where("target_path_key", "=", source.target_path_key).where("superseded_at", "is", null).execute();
      } else {
        await this.createFileRevision(trx, binding, contextId, source.target_path, null, actor);
      }
      await this.validateAffectedRuntime(trx, botId, binding.chat_context_id ?? contextId);
      await this.invalidateTaskSnapshots(botId, binding.chat_context_id ?? contextId, trx);
      affectedContexts = await this.enqueueSyncForBinding(binding, contextId, undefined, trx);
    });
    await this.audit(actor, restoreInheritance ? "skill.runtime.file.inherit" : "skill.runtime.file.delete", botId, binding.id, contextId, source.target_path, source.revision + 1);
    this.events.publish("skill", binding.id); for (const id of affectedContexts) this.events.publish("chat_context", id);
    return { ok: true };
  }

  async forceFile(botId: string, bindingId: string, fileId: string, contextId: string): Promise<void> {
    const binding = await this.assertBinding(bindingId, botId);
    const file = await this.db.selectFrom("skill_runtime_file_revisions").selectAll().where("id", "=", fileId).where("binding_id", "=", binding.id).executeTakeFirst();
    if (!file) throw new AppError("配置文件不存在", 404, "runtime_file_not_found");
    if (file.superseded_at) throw new AppError("配置文件已被更新，请刷新后重试", 409, "runtime_file_revision_conflict");
    await this.assertBotAndContext(botId, contextId);
    if (binding.chat_context_id && binding.chat_context_id !== contextId) throw new AppError("配置文件不属于该聊天", 409, "runtime_scope_mismatch");
    let affectedContexts: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      await this.lockBot(trx, botId);
      await this.assertBindingLocked(trx, botId, binding.id);
      const forced = await trx.updateTable("skill_runtime_file_states").set({ status: "pending_force", last_error: null, updated_at: new Date() }).where("binding_id", "=", binding.id).where("target_path", "=", file.target_path)
        .where("chat_context_id", "=", contextId).where("desired_file_revision_id", "=", file.id).returning("chat_context_id").executeTakeFirst();
      if (!forced) throw new AppError("该聊天没有等待处理的文件修订", 409, "runtime_file_revision_conflict");
      affectedContexts = await this.enqueueSyncForBinding(binding, contextId, file.target_path, trx);
    });
    this.events.publish("skill", binding.id); for (const id of affectedContexts) this.events.publish("chat_context", id);
  }

  private async invalidateTaskSnapshots(botId: string, contextId: string | null, db: Kysely<Database> | Transaction<Database> = this.db): Promise<void> {
    await sql`
      UPDATE tasks SET skill_set_snapshot = '[]'::jsonb, skill_set_fingerprint = NULL,
        runtime_config_snapshot = '{"environment":[],"files":[]}'::jsonb, runtime_config_fingerprint = NULL, updated_at = now()
      FROM conversations
      WHERE tasks.conversation_id = conversations.id AND tasks.bot_id = ${botId}
        AND tasks.state IN ('queued', 'waiting_worker') AND tasks.lease_token_hash IS NULL
        ${contextId ? sql`AND conversations.chat_context_id = ${contextId}` : sql``}
    `.execute(db);
  }

  private async currentBindings(botId: string, contextId: string, db: Kysely<Database> | Transaction<Database> = this.db) {
    const rows = await db.selectFrom("bot_skill_bindings").innerJoin("skillhub_packages", "skillhub_packages.id", "bot_skill_bindings.package_id")
      .selectAll("bot_skill_bindings").select([
        "skillhub_packages.version", "skillhub_packages.registry_fingerprint", "skillhub_packages.archive_sha256", "skillhub_packages.archive_size",
        "skillhub_packages.skill_name", "skillhub_packages.description"
      ]).where("bot_skill_bindings.bot_id", "=", botId).where("bot_skill_bindings.deleted_at", "is", null)
      .where((eb) => eb.or([eb("bot_skill_bindings.chat_context_id", "is", null), eb("bot_skill_bindings.chat_context_id", "=", contextId)]))
      .orderBy("bot_skill_bindings.namespace").orderBy("bot_skill_bindings.slug").execute();
    const selected = new Map<string, typeof rows[number]>();
    for (const row of rows.sort((left, right) => Number(Boolean(left.chat_context_id)) - Number(Boolean(right.chat_context_id)))) selected.set(`${row.namespace}/${row.slug}`, row);
    return [...selected.values()];
  }

  private async validateAffectedRuntime(db: Kysely<Database> | Transaction<Database>, botId: string, contextId: string | null): Promise<void> {
    if (contextId) {
      await this.effectiveRuntime(botId, contextId, db);
      return;
    }
    const contexts = await db.selectFrom("chat_contexts").select("id").where("bot_id", "=", botId).execute();
    await this.effectiveRuntime(botId, null, db);
    for (const context of contexts) await this.effectiveRuntime(botId, context.id, db);
  }

  private async validateAffectedSkillCounts(db: Kysely<Database> | Transaction<Database>, botId: string, contextId: string | null): Promise<void> {
    const contexts = contextId ? [{ id: contextId }] : await db.selectFrom("chat_contexts").select("id").where("bot_id", "=", botId).execute();
    const targets: Array<string | null> = contextId ? [contextId] : [null, ...contexts.map((context) => context.id)];
    const rows = await db.selectFrom("bot_skill_bindings").innerJoin("skillhub_packages", "skillhub_packages.id", "bot_skill_bindings.package_id")
      .select(["bot_skill_bindings.namespace", "bot_skill_bindings.slug", "bot_skill_bindings.chat_context_id", "skillhub_packages.skill_name"])
      .where("bot_skill_bindings.bot_id", "=", botId).where("bot_skill_bindings.deleted_at", "is", null).execute();
    for (const target of targets) {
      const selected = new Map<string, typeof rows[number]>();
      for (const row of rows.filter((item) => !item.chat_context_id || item.chat_context_id === target).sort((left, right) => Number(Boolean(left.chat_context_id)) - Number(Boolean(right.chat_context_id)))) {
        selected.set(`${row.namespace}/${row.slug}`, row);
      }
      if (selected.size > MAX_EFFECTIVE_SKILLS) throw new AppError("单个聊天最多配置 64 个托管技能", 409, "skill_limit_exceeded");
      const names = new Map<string, string>();
      for (const [coordinate, row] of selected) {
        const existing = names.get(row.skill_name);
        if (existing && existing !== coordinate) throw new AppError(`技能名称 ${row.skill_name} 已由 @${existing} 使用`, 409, "skill_name_conflict");
        names.set(row.skill_name, coordinate);
      }
    }
  }

  private async effectiveRuntime(botId: string, contextId: string | null, db: Kysely<Database> | Transaction<Database> = this.db): Promise<TaskRuntimeSnapshot> {
    const bindings = await db.selectFrom("bot_skill_bindings").selectAll().where("bot_id", "=", botId).where("deleted_at", "is", null).execute();
    const candidates = bindings.filter((binding) => !binding.chat_context_id || binding.chat_context_id === contextId);
    const activeByCoordinate = new Map<string, typeof candidates[number]>();
    for (const binding of candidates.filter((item) => !item.deleted_at).sort((left, right) => Number(Boolean(left.chat_context_id)) - Number(Boolean(right.chat_context_id)))) activeByCoordinate.set(`${binding.namespace}/${binding.slug}`, binding);
    const activeIds = new Set([...activeByCoordinate.values()].map((binding) => binding.id));
    const relevant = candidates.filter((binding) => activeIds.has(binding.id));
    if (!relevant.length) return { environment: [], files: [] };
    const ids = relevant.map((binding) => binding.id);
    const [envRows, fileRows] = await Promise.all([
      (contextId
        ? db.selectFrom("skill_runtime_environment_revisions").selectAll().where("binding_id", "in", ids).where("superseded_at", "is", null).where((eb) => eb.or([eb("chat_context_id", "is", null), eb("chat_context_id", "=", contextId)]))
        : db.selectFrom("skill_runtime_environment_revisions").selectAll().where("binding_id", "in", ids).where("superseded_at", "is", null).where("chat_context_id", "is", null)).execute(),
      (contextId
        ? db.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "in", ids).where("superseded_at", "is", null).where((eb) => eb.or([eb("chat_context_id", "is", null), eb("chat_context_id", "=", contextId)]))
        : db.selectFrom("skill_runtime_file_revisions").selectAll().where("binding_id", "in", ids).where("superseded_at", "is", null).where("chat_context_id", "is", null)).execute()
    ]);
    const choose = <T extends { binding_id: string; chat_context_id: string | null }>(rows: T[], key: (row: T) => string) => {
      const selected = new Map<string, T>();
      for (const row of rows.sort((left, right) => Number(Boolean(left.chat_context_id)) - Number(Boolean(right.chat_context_id)))) selected.set(`${row.binding_id}:${key(row)}`, row);
      return [...selected.values()];
    };
    const effectiveEnvRows = choose(envRows, (row) => row.name).filter((row) => row.desired_state === "present" && !relevant.find((binding) => binding.id === row.binding_id)?.deleted_at);
    const environment = effectiveEnvRows.map((row) => ({
      id: row.id, bindingId: row.binding_id, name: row.name, revision: row.revision, scope: row.chat_context_id ? "chat_context" as const : "bot" as const
    }));
    const effectiveFileRows = choose(fileRows, (row) => row.target_path_key).filter((row) => row.desired_state === "absent" || !relevant.find((binding) => binding.id === row.binding_id)?.deleted_at);
    const files = effectiveFileRows.map((row) => ({
      id: row.id, bindingId: row.binding_id, targetPath: row.target_path, revision: row.revision, sha256: row.content_sha256 ?? "0".repeat(64),
      size: Number(row.content_size), desiredState: row.desired_state, scope: row.chat_context_id ? "chat_context" as const : "bot" as const,
      downloadPath: row.desired_state === "present" ? `/v1/tasks/{taskId}/runtime-config/files/${row.id}/download` : null,
      force: false
    }));
    const names = new Set<string>();
    if (environment.length > 64) throw new AppError("当前聊天的有效环境变量超过 64 个", 409, "runtime_environment_limit");
    if (effectiveEnvRows.reduce((sum, row) => sum + Number(row.value_size), 0) > MAX_ENV_TOTAL_BYTES) throw new AppError("当前聊天的有效环境变量总大小超过 256 KiB", 409, "runtime_environment_limit");
    for (const item of environment) {
      if (names.has(item.name)) throw new AppError(`多个技能配置了同名环境变量 ${item.name}`, 409, "runtime_environment_conflict");
      names.add(item.name);
    }
    const paths = new Set<string>();
    if (files.length > MAX_EFFECTIVE_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_FILE_TOTAL_BYTES) throw new AppError("当前聊天的有效配置文件超过数量或总大小限制", 409, "runtime_file_limit");
    for (const item of files) {
      const collisionKey = runtimePathCollisionKey(item.targetPath);
      if (paths.has(collisionKey)) throw new AppError(`多个技能配置了在执行环境中冲突的路径 ${item.targetPath}`, 409, "runtime_file_conflict");
      paths.add(collisionKey);
    }
    environment.sort((left, right) => left.name.localeCompare(right.name) || left.bindingId.localeCompare(right.bindingId));
    files.sort((left, right) => left.targetPath.localeCompare(right.targetPath) || left.bindingId.localeCompare(right.bindingId));
    return { environment, files };
  }

  async prepareTaskSnapshot(taskId: string): Promise<{ skills: TaskSkillSnapshot[]; skillSetFingerprint: string; runtimeConfig: TaskRuntimeSnapshot & { fingerprint: string }; runtimeConfigFingerprint: string }> {
    const identity = await this.db.selectFrom("tasks").select("bot_id").where("id", "=", taskId).executeTakeFirstOrThrow();
    return this.db.transaction().execute(async (trx) => {
      await this.lockBot(trx, identity.bot_id);
      const task = await trx.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id")
        .select(["tasks.id", "tasks.bot_id", "tasks.executor_id", "tasks.skill_set_snapshot", "tasks.skill_set_fingerprint", "tasks.runtime_config_snapshot", "tasks.runtime_config_fingerprint", "conversations.chat_context_id"])
        .where("tasks.id", "=", taskId).forUpdate().executeTakeFirstOrThrow();
      if (task.skill_set_fingerprint && task.runtime_config_fingerprint) {
        const runtime = parseRuntime(task.runtime_config_snapshot);
        return { skills: parseArray<TaskSkillSnapshot>(task.skill_set_snapshot), skillSetFingerprint: task.skill_set_fingerprint, runtimeConfig: { ...runtime, fingerprint: task.runtime_config_fingerprint }, runtimeConfigFingerprint: task.runtime_config_fingerprint };
      }
      const bindings = await this.currentBindings(task.bot_id, task.chat_context_id, trx);
      if (bindings.length) {
        const worker = task.executor_id ? await trx.selectFrom("workers").select(["user_skills", "user_skills_scan_status", "user_skills_truncated"]).where("executor_id", "=", task.executor_id).executeTakeFirst() : null;
        if (!worker || worker.user_skills_scan_status !== "ready" || worker.user_skills_truncated) throw new AppError("执行器用户级技能清单尚未完整就绪", 409, "runner_user_skills_unavailable");
        const userNames = new Set(Array.isArray(worker.user_skills) ? worker.user_skills.flatMap((item) => item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" ? [(item as { name: string }).name] : []) : []);
        const conflict = bindings.find((binding) => userNames.has(binding.skill_name));
        if (conflict) throw new AppError(`托管技能 ${conflict.skill_name} 与执行器用户级技能同名`, 409, "runner_user_skill_conflict");
      }
      const skills = bindings.map((binding) => ({
        packageId: binding.package_id, coordinate: `@${binding.namespace}/${binding.slug}`, name: binding.skill_name, description: binding.description,
        version: binding.version, registryFingerprint: binding.registry_fingerprint, archiveSha256: binding.archive_sha256, archiveSize: Number(binding.archive_size),
        downloadPath: `/v1/tasks/${taskId}/skills/${binding.package_id}/download`, scope: binding.chat_context_id ? "chat_context" as const : "bot" as const,
        sourceScope: binding.chat_context_id ? "chat_context" as const : "bot" as const, bindingId: binding.id
      }));
      const runtime = await this.effectiveRuntime(task.bot_id, task.chat_context_id, trx);
      const forced = await trx.selectFrom("skill_runtime_file_states").select(["binding_id", "target_path"]).where("chat_context_id", "=", task.chat_context_id).where("status", "=", "pending_force").execute();
      runtime.files = runtime.files.map((file) => ({ ...file, force: forced.some((item) => item.binding_id === file.bindingId && item.target_path === file.targetPath), downloadPath: file.downloadPath?.replace("{taskId}", taskId) ?? null }));
      const skillFingerprint = canonicalFingerprint(skills.map(({ downloadPath: _downloadPath, description: _description, ...item }) => item));
      const runtimeFingerprint = canonicalFingerprint(runtime);
      await trx.updateTable("tasks").set({ skill_set_snapshot: JSON.stringify(skills), skill_set_fingerprint: skillFingerprint, runtime_config_snapshot: JSON.stringify(runtime), runtime_config_fingerprint: runtimeFingerprint, updated_at: new Date() }).where("id", "=", taskId).execute();
      await trx.updateTable("chat_contexts").set({ desired_skill_set_fingerprint: skillFingerprint, skills_sync_error: null, updated_at: new Date() }).where("id", "=", task.chat_context_id).execute();
      return { skills, skillSetFingerprint: skillFingerprint, runtimeConfig: { ...runtime, fingerprint: runtimeFingerprint }, runtimeConfigFingerprint: runtimeFingerprint };
    });
  }

  async taskEnvironment(taskId: string): Promise<Array<{ name: string; value: string }>> {
    const task = await this.db.selectFrom("tasks").select("runtime_config_snapshot").where("id", "=", taskId).executeTakeFirstOrThrow();
    const snapshot = parseRuntime(task.runtime_config_snapshot);
    if (!snapshot.environment.length) return [];
    const rows = await this.db.selectFrom("skill_runtime_environment_revisions").selectAll().where("id", "in", snapshot.environment.map((entry) => entry.id)).execute();
    return snapshot.environment.map((entry) => {
      const row = rows.find((candidate) => candidate.id === entry.id && candidate.revision === entry.revision && candidate.desired_state === "present");
      if (!row) throw new AppError(`环境变量 ${entry.name} 的固定修订不可用`, 409, "runtime_revision_unavailable");
      const value = this.secrets.decrypt(encryptedFromRow(row), secretAad("env", row.id, row.binding_id, row.chat_context_id, row.name, row.revision)).toString("utf8");
      return { name: entry.name, value };
    });
  }

  async taskFile(taskId: string, fileId: string): Promise<{ content: Buffer; sha256: string; size: number; targetPath: string }> {
    const task = await this.db.selectFrom("tasks").select("runtime_config_snapshot").where("id", "=", taskId).executeTakeFirstOrThrow();
    const entry = parseRuntime(task.runtime_config_snapshot).files.find((file) => file.id === fileId && file.desiredState === "present");
    if (!entry) throw new AppError("配置文件不在任务快照中", 404, "runtime_file_not_in_snapshot");
    const row = await this.db.selectFrom("skill_runtime_file_revisions").selectAll().where("id", "=", fileId).executeTakeFirst();
    if (!row || row.revision !== entry.revision || !row.content_sha256) throw new AppError("配置文件固定修订不可用", 409, "runtime_revision_unavailable");
    const content = this.secrets.decrypt(encryptedFromRow(row), secretAad("file", row.id, row.binding_id, row.chat_context_id, row.target_path, row.revision));
    if (sha256(content) !== row.content_sha256) throw new AppError("配置文件完整性校验失败", 500, "runtime_file_integrity_error");
    return { content, sha256: row.content_sha256, size: Number(row.content_size), targetPath: row.target_path };
  }

  private async enqueueSyncForBinding(
    binding: { id: string; bot_id: string; chat_context_id: string | null },
    explicitContext?: string | null,
    forceTargetPath?: string,
    db: Kysely<Database> | Transaction<Database> = this.db,
    skipExistingFingerprint = false
  ): Promise<string[]> {
    let query = db.selectFrom("chat_contexts").innerJoin("bots", "bots.id", "chat_contexts.bot_id")
      .select(["chat_contexts.id", "chat_contexts.executor_id", "chat_contexts.workspace_root_alias", "bots.app_id"])
      .where("chat_contexts.bot_id", "=", binding.bot_id);
    const contextId = explicitContext ?? binding.chat_context_id;
    if (contextId) query = query.where("chat_contexts.id", "=", contextId);
    const contexts = await query.execute();
    for (const context of contexts) {
      const runtime = await this.effectiveRuntime(binding.bot_id, context.id, db);
      const skillRows = await this.currentBindings(binding.bot_id, context.id, db);
      const skills = skillRows.map((row) => ({ packageId: row.package_id, coordinate: `@${row.namespace}/${row.slug}`, name: row.skill_name, version: row.version, registryFingerprint: row.registry_fingerprint, archiveSha256: row.archive_sha256, sourceScope: row.chat_context_id ? "chat_context" : "bot" }));
      runtime.files = runtime.files.map((file) => ({ ...file, force: file.targetPath === forceTargetPath }));
      const skillSetFingerprint = canonicalFingerprint(skills);
      const runtimeConfigFingerprint = canonicalFingerprint(runtime.files);
      const payload = { botAppId: context.app_id, resolvedWorkspaceAlias: context.workspace_root_alias, skills, skillSetFingerprint, runtimeConfig: { fingerprint: runtimeConfigFingerprint, files: runtime.files } };
      const fingerprint = canonicalFingerprint(payload);
      if (skipExistingFingerprint && context.executor_id && context.workspace_root_alias) {
        const existing = await db.selectFrom("skill_file_sync_jobs").select("id")
          .where("chat_context_id", "=", context.id).where("desired_fingerprint", "=", fingerprint)
          .where("state", "in", ["queued", "running", "completed"]).executeTakeFirst();
        if (existing) {
          await db.updateTable("chat_contexts").set({ desired_skill_set_fingerprint: skillSetFingerprint, updated_at: new Date() }).where("id", "=", context.id).execute();
          continue;
        }
      }
      await db.updateTable("chat_contexts").set({ desired_skill_set_fingerprint: skillSetFingerprint, skills_sync_error: null, updated_at: new Date() }).where("id", "=", context.id).execute();
      if (!context.executor_id || !context.workspace_root_alias) continue;
      await sql`
        INSERT INTO skill_file_sync_jobs(chat_context_id, executor_id, desired_fingerprint, payload, state, updated_at)
        VALUES (${context.id}, ${context.executor_id!}, ${fingerprint}, ${JSON.stringify(payload)}::jsonb, 'queued', now())
        ON CONFLICT (chat_context_id) WHERE state IN ('queued', 'running')
        DO UPDATE SET executor_id = EXCLUDED.executor_id, desired_fingerprint = EXCLUDED.desired_fingerprint,
          payload = EXCLUDED.payload,
          state = CASE WHEN skill_file_sync_jobs.state = 'running' THEN 'running' ELSE 'queued' END,
          lease_token_hash = CASE WHEN skill_file_sync_jobs.state = 'running' THEN skill_file_sync_jobs.lease_token_hash ELSE NULL END,
          lease_expires_at = CASE WHEN skill_file_sync_jobs.state = 'running' THEN skill_file_sync_jobs.lease_expires_at ELSE NULL END,
          leased_fingerprint = CASE WHEN skill_file_sync_jobs.state = 'running' THEN skill_file_sync_jobs.leased_fingerprint ELSE NULL END,
          leased_payload = CASE WHEN skill_file_sync_jobs.state = 'running' THEN skill_file_sync_jobs.leased_payload ELSE NULL END,
          last_error = NULL, updated_at = now()
      `.execute(db);
      for (const file of runtime.files) {
        await db.insertInto("skill_runtime_file_states").values({
          chat_context_id: context.id, binding_id: file.bindingId, target_path: file.targetPath, desired_file_revision_id: file.id,
          desired_revision: file.revision, applied_revision: null, actual_sha256: null,
          status: file.targetPath === forceTargetPath ? "pending_force" : file.desiredState === "absent" ? "pending_delete" : "pending", last_error: null, checked_at: null, updated_at: new Date()
        }).onConflict((conflict) => conflict.columns(["chat_context_id", "binding_id", "target_path"]).doUpdateSet({
          desired_file_revision_id: file.id, desired_revision: file.revision,
          status: file.targetPath === forceTargetPath ? "pending_force" : file.desiredState === "absent" ? "pending_delete" : "pending", last_error: null, updated_at: new Date()
        })).execute();
      }
    }
    return contexts.map((context) => context.id);
  }

  async enqueueLatestForContext(contextId: string, options: { forceRetry?: boolean; actor?: string } = {}): Promise<boolean> {
    const identity = await this.db.selectFrom("chat_contexts").select(["id", "bot_id"]).where("id", "=", contextId).executeTakeFirst();
    if (!identity) throw new AppError("聊天记忆不存在", 404, "chat_context_not_found");
    let affected: string[] = [];
    let ready = false;
    await this.db.transaction().execute(async (trx) => {
      await this.lockBot(trx, identity.bot_id);
      const context = await trx.selectFrom("chat_contexts").select(["executor_id", "workspace_root_alias"]).where("id", "=", contextId).forUpdate().executeTakeFirstOrThrow();
      if (!context.executor_id || !context.workspace_root_alias) return;
      ready = true;
      affected = await this.enqueueSyncForBinding({ id: contextId, bot_id: identity.bot_id, chat_context_id: contextId }, contextId, undefined, trx, !options.forceRetry);
    });
    if (options.actor && ready) await this.audit(options.actor, "skill.runtime.sync.retry", identity.bot_id, null, contextId, null, null);
    for (const id of affected) this.events.publish("chat_context", id);
    return ready;
  }

  async claimSyncJob(principal: {
    executorId: string;
    homeRef: string;
    codexProfile: string;
    configFingerprint: string;
    workspaceMappingFingerprint?: string | null;
  }, leaseSeconds: number) {
    const executorId = principal.executorId;
    const token = randomToken();
    const outcome = await this.db.transaction().execute(async (trx) => {
      await lockExecutorClaim(trx, executorId);
      const worker = await trx.selectFrom("workers")
        .select(["capacity", "operational_mode", "home_ref", "codex_profile", "config_fingerprint", "workspace_mapping_fingerprint", "workspace_aliases", "capabilities"])
        .where("executor_id", "=", executorId).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
      const workspaceMappingFingerprint = principal.workspaceMappingFingerprint ?? null;
      if (worker && (
        worker.home_ref !== principal.homeRef
        || worker.codex_profile !== principal.codexProfile
        || worker.config_fingerprint !== principal.configFingerprint
        || (workspaceMappingFingerprint !== null && worker.workspace_mapping_fingerprint !== workspaceMappingFingerprint)
      )) {
        throw new AppError("worker configuration changed; create a new session", 409, "worker_config_changed");
      }
      if (!worker) return { job: null, exhausted: [], expires: null };
      const now = new Date();
      await trx.updateTable("skill_file_sync_jobs").set({ state: "queued", leased_fingerprint: null, leased_payload: null, lease_token_hash: null, lease_expires_at: null, last_error: "上一次 Runner 同步租约已过期，正在重试", updated_at: now })
        .where("executor_id", "=", executorId).where("state", "=", "running").where("lease_expires_at", "<", now).where("attempt", "<", 5).execute();
      const exhausted = await trx.updateTable("skill_file_sync_jobs").set({ state: "failed", leased_fingerprint: null, leased_payload: null, lease_token_hash: null, lease_expires_at: null, last_error: "Runner 同步连续 5 次租约过期", updated_at: now })
        .where("executor_id", "=", executorId).where("state", "=", "running").where("lease_expires_at", "<", now).where("attempt", ">=", 5).returning(["id", "chat_context_id"]).execute();
      for (const failed of exhausted) {
        const fingerprint = `skill_file_sync:${failed.chat_context_id}`;
        await trx.insertInto("incidents").values({
          fingerprint, kind: "skill_file_sync", severity: "critical", title: "工作区技能配置同步失败", summary: "Runner 同步连续 5 次租约过期",
          state: "open", related_type: "chat_context", related_id: failed.chat_context_id, first_seen_at: now, last_seen_at: now,
          acknowledged_by: null, acknowledged_at: null, resolved_at: null, notification_message_id: null, last_notified_at: null,
          last_notification_error: null, updated_at: now
        }).onConflict((conflict) => conflict.column("fingerprint").doUpdateSet({ state: "open", summary: "Runner 同步连续 5 次租约过期", last_seen_at: now, resolved_at: null, updated_at: now })).execute();
      }
      const capabilities = Array.isArray(worker.capabilities) ? worker.capabilities.map(String) : [];
      const workspaceMappingReady = capabilities.includes("workspace_mapping_v1") && workspaceMappingFingerprint !== null &&
        worker.workspace_mapping_fingerprint === workspaceMappingFingerprint;
      if (worker.operational_mode !== "enabled" || !workspaceMappingReady || !await executorHasClaimCapacity(trx, executorId, worker.capacity)) {
        return { job: null, exhausted, expires: null };
      }
      const workspaceAliases = Array.isArray(worker.workspace_aliases) ? worker.workspace_aliases.map(String) : [];
      const expires = new Date(Date.now() + Math.max(leaseSeconds, MIN_SYNC_LEASE_SECONDS) * 1000);
      const result = await sql<{ id: string; chat_context_id: string; desired_fingerprint: string; payload: unknown; attempt: number }>`
        WITH candidate AS (
          SELECT job.id
          FROM skill_file_sync_jobs job
          JOIN chat_contexts context ON context.id = job.chat_context_id
          WHERE job.executor_id = ${executorId}
            AND job.state = 'queued'
            AND context.state <> 'blocked'
            AND context.executor_id = ${executorId}
            AND context.executor_home_ref = ${principal.homeRef}
            AND context.executor_profile = ${principal.codexProfile}
            AND context.executor_config_fingerprint = ${principal.configFingerprint}
            AND context.executor_workspace_mapping_fingerprint = ${workspaceMappingFingerprint}
            AND context.workspace_root_alias = ANY(${sql.val(workspaceAliases)}::text[])
            AND job.payload ->> 'resolvedWorkspaceAlias' = context.workspace_root_alias
          ORDER BY job.created_at
          FOR UPDATE OF job, context SKIP LOCKED
          LIMIT 1
        )
        UPDATE skill_file_sync_jobs job SET state = 'running', leased_fingerprint = job.desired_fingerprint, leased_payload = job.payload, lease_token_hash = ${sha256(token)}, lease_expires_at = ${expires},
          attempt = attempt + 1, updated_at = now()
        FROM candidate WHERE job.id = candidate.id
        RETURNING job.id, job.chat_context_id, job.desired_fingerprint, job.leased_payload AS payload, job.attempt
      `.execute(trx);
      return { job: result.rows[0] ?? null, exhausted, expires };
    });
    for (const failed of outcome.exhausted) {
      this.events.publish("incident"); this.events.publish("chat_context", failed.chat_context_id);
    }
    const job = outcome.job;
    const payload = job?.payload && typeof job.payload === "object" ? job.payload as { botAppId?: string; resolvedWorkspaceAlias?: string; skills?: TaskSkillSnapshot[]; skillSetFingerprint?: string; runtimeConfig?: { fingerprint?: string; files?: RuntimeFileSnapshot[] } } : {};
    return job ? {
      id: job.id, botAppId: payload.botAppId, chatContextId: job.chat_context_id, workspaceKey: job.chat_context_id,
      resolvedWorkspaceAlias: payload.resolvedWorkspaceAlias, desiredFingerprint: job.desired_fingerprint,
      skills: parseArray<TaskSkillSnapshot>(payload.skills), skillSetFingerprint: payload.skillSetFingerprint,
      runtimeConfig: { fingerprint: payload.runtimeConfig?.fingerprint, files: parseArray<RuntimeFileSnapshot>(payload.runtimeConfig?.files) },
      attempt: job.attempt, leaseToken: token, leaseExpiresAt: outcome.expires!.toISOString()
    } : null;
  }

  async heartbeatSyncJob(executorId: string, jobId: string, leaseToken: string, leaseSeconds: number): Promise<{ leaseExpiresAt: string }> {
    const leaseExpiresAt = new Date(Date.now() + Math.max(leaseSeconds, MIN_SYNC_LEASE_SECONDS) * 1000);
    const updated = await this.db.updateTable("skill_file_sync_jobs").set({ lease_expires_at: leaseExpiresAt, updated_at: new Date() })
      .where("id", "=", jobId).where("executor_id", "=", executorId).where("state", "=", "running")
      .where("lease_token_hash", "=", sha256(leaseToken)).where("lease_expires_at", ">", new Date())
      .returning("id").executeTakeFirst();
    if (!updated) throw new AppError("同步作业租约无效或已过期", 409, "invalid_sync_lease");
    return { leaseExpiresAt: leaseExpiresAt.toISOString() };
  }

  async finishSyncJob(executorId: string, jobId: string, leaseToken: string, body: { desiredFingerprint: string; skillSetFingerprint: string; runtimeConfigFingerprint: string; status: "applied" | "conflict" | "failed"; summary?: string; files?: Array<{ id: string; targetPath: string; revision?: number | null; actualSha256?: string | null; status: "applied" | "deleted" | "unchanged" | "conflict" | "failed"; errorCode?: string | null }> }) {
    const outcome = await this.db.transaction().execute(async (trx) => {
      const job = await trx.selectFrom("skill_file_sync_jobs").selectAll().where("id", "=", jobId).where("executor_id", "=", executorId)
        .where("state", "=", "running").where("lease_token_hash", "=", sha256(leaseToken)).where("lease_expires_at", ">", new Date()).forUpdate().executeTakeFirst();
      if (!job || !job.leased_fingerprint || !job.leased_payload) throw new AppError("同步作业租约无效或已过期", 409, "invalid_sync_lease");
      if (job.leased_fingerprint !== body.desiredFingerprint) throw new AppError("同步作业指纹与租约不一致", 409, "sync_fingerprint_mismatch");
      if (job.desired_fingerprint !== job.leased_fingerprint) {
        await trx.updateTable("skill_file_sync_jobs").set({ state: "queued", leased_fingerprint: null, leased_payload: null, lease_token_hash: null, lease_expires_at: null, last_error: null, completed_at: null, updated_at: new Date() })
          .where("id", "=", job.id).where("state", "=", "running").where("lease_token_hash", "=", sha256(leaseToken)).execute();
        return { job, stale: true as const };
      }
      const expected = typeof job.leased_payload === "object" ? job.leased_payload as { skillSetFingerprint?: string; runtimeConfig?: { fingerprint?: string; files?: RuntimeFileSnapshot[] } } : {};
      if (expected.skillSetFingerprint !== body.skillSetFingerprint || expected.runtimeConfig?.fingerprint !== body.runtimeConfigFingerprint) throw new AppError("同步结果的技能或运行配置指纹不匹配", 409, "sync_fingerprint_mismatch");
      const expectedFiles = parseArray<RuntimeFileSnapshot>(expected.runtimeConfig?.files);
      const reportedFiles = [...(body.files ?? [])];
      validateRuntimeFileResults(expectedFiles, reportedFiles, body.status === "applied");
      for (const item of body.files ?? []) {
        const desired = await trx.selectFrom("skill_runtime_file_revisions").select(["desired_state", "binding_id"]).where("id", "=", item.id).executeTakeFirst();
        const mapped = item.status === "unchanged" ? desired?.desired_state === "absent" ? "deleted" : "applied" : item.status === "failed" ? "error" : item.status;
        const stateUpdated = await trx.updateTable("skill_runtime_file_states").set({ applied_revision: item.revision ?? null, actual_sha256: item.actualSha256 ?? null, status: mapped, last_error: item.errorCode?.slice(0, 1_000) ?? null, checked_at: new Date(), updated_at: new Date() })
          .where("chat_context_id", "=", job.chat_context_id).where("desired_file_revision_id", "=", item.id).where("target_path", "=", item.targetPath).returning("chat_context_id").executeTakeFirst();
        if (!stateUpdated) throw new AppError("同步结果对应的文件状态已变化", 409, "sync_result_mismatch");
        if (mapped === "deleted" && desired) {
          const deletedBinding = await trx.selectFrom("bot_skill_bindings").select("deleted_at").where("id", "=", desired.binding_id).executeTakeFirst();
          if (deletedBinding?.deleted_at) await trx.updateTable("skill_runtime_file_revisions").set({ superseded_at: new Date() }).where("id", "=", item.id).execute();
        }
      }
      if (body.status === "applied") {
        let staleStates = trx.updateTable("skill_runtime_file_states").set({ applied_revision: null, actual_sha256: null, status: "deleted", last_error: null, checked_at: new Date(), updated_at: new Date() })
          .where("chat_context_id", "=", job.chat_context_id);
        if (expectedFiles.length) staleStates = staleStates.where("desired_file_revision_id", "not in", expectedFiles.map((file) => file.id));
        await staleStates.execute();
      }
      const state = body.status === "applied" ? "completed" : "failed";
      const completed = await trx.updateTable("skill_file_sync_jobs").set({ state, leased_fingerprint: null, leased_payload: null, last_error: body.status === "applied" ? null : body.summary?.slice(0, 2_000) ?? body.status, lease_token_hash: null, lease_expires_at: null, completed_at: body.status === "applied" ? new Date() : null, updated_at: new Date() })
        .where("id", "=", job.id).where("state", "=", "running").whereRef("desired_fingerprint", "=", "leased_fingerprint").returning("id").executeTakeFirst();
      if (!completed) throw new AppError("同步期间期望配置已变化", 409, "sync_result_stale");
      await trx.updateTable("chat_contexts").set({
        applied_skill_set_fingerprint: body.status === "applied" ? body.skillSetFingerprint : sql`applied_skill_set_fingerprint`,
        skills_synced_at: body.status === "applied" ? new Date() : sql`skills_synced_at`,
        skills_sync_error: body.status === "applied" ? null : body.summary?.slice(0, 2_000) ?? body.status,
        updated_at: new Date()
      }).where("id", "=", job.chat_context_id).execute();
      const fingerprint = `skill_file_sync:${job.chat_context_id}`;
      if (body.status === "applied") {
        await trx.updateTable("incidents").set({ state: "resolved", resolved_at: new Date(), updated_at: new Date() }).where("fingerprint", "=", fingerprint).where("state", "!=", "resolved").execute();
      } else {
        const summary = body.summary?.slice(0, 2_000) ?? "工作区技能配置同步失败";
        await trx.insertInto("incidents").values({
          fingerprint, kind: "skill_file_sync", severity: "critical", title: "工作区技能配置同步失败", summary,
          state: "open", related_type: "chat_context", related_id: job.chat_context_id, first_seen_at: new Date(), last_seen_at: new Date(),
          acknowledged_by: null, acknowledged_at: null, resolved_at: null, notification_message_id: null, last_notified_at: null,
          last_notification_error: null, updated_at: new Date()
        }).onConflict((conflict) => conflict.column("fingerprint").doUpdateSet({ state: "open", summary, last_seen_at: new Date(), resolved_at: null, updated_at: new Date() })).execute();
      }
      return { job, stale: false as const };
    });
    this.events.publish("chat_context", outcome.job.chat_context_id); this.events.publish("skill", outcome.job.id);
    if (!outcome.stale) this.events.publish("incident");
  }

  async recordRuntimeSnapshot(taskId: string, executorId: string, body: {
    skillSetFingerprint: string; runtimeConfigFingerprint: string; managedSkills: Array<Record<string, unknown>>; userSkills: unknown[]; environmentNames: string[];
    files: Array<{ id: string; targetPath: string; revision: number; actualSha256: string | null; status: "applied" | "deleted" | "unchanged"; error: null }>
  }) {
    const task = await this.db.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id").select(["tasks.skill_set_snapshot", "tasks.skill_set_fingerprint", "tasks.runtime_config_snapshot", "tasks.runtime_config_fingerprint", "conversations.chat_context_id"]).where("tasks.id", "=", taskId).where("tasks.executor_id", "=", executorId).executeTakeFirstOrThrow();
    if (task.skill_set_fingerprint !== body.skillSetFingerprint || (body.runtimeConfigFingerprint && task.runtime_config_fingerprint !== body.runtimeConfigFingerprint)) throw new AppError("Runner 上报的技能运行快照与任务不一致", 409, "runtime_snapshot_mismatch");
    const expectedSkills = parseArray<Record<string, unknown>>(task.skill_set_snapshot);
    const expectedRuntime = parseRuntime(task.runtime_config_snapshot);
    const expectedNames = expectedRuntime.environment.map((item) => item.name).sort();
    validateRuntimeIdentity(expectedSkills, body.managedSkills, expectedNames, body.environmentNames);
    validateRuntimeFileResults(expectedRuntime.files, body.files, true);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable("tasks").set({ user_skills_snapshot: JSON.stringify(body.userSkills), updated_at: new Date() }).where("id", "=", taskId).execute();
      await trx.updateTable("chat_contexts").set({
        applied_skill_set_fingerprint: body.skillSetFingerprint, skills_synced_at: new Date(), updated_at: new Date()
      }).where("id", "=", task.chat_context_id).execute();
      for (const item of body.files) {
        const wanted = expectedRuntime.files.find((file) => file.id === item.id)!;
        await trx.insertInto("skill_runtime_file_states").values({
          chat_context_id: task.chat_context_id, binding_id: wanted.bindingId, target_path: wanted.targetPath, desired_file_revision_id: wanted.id,
          desired_revision: wanted.revision, applied_revision: item.revision, actual_sha256: item.actualSha256,
          status: wanted.desiredState === "absent" ? "deleted" : "applied", last_error: null, checked_at: new Date(), updated_at: new Date()
        }).onConflict((conflict) => conflict.columns(["chat_context_id", "binding_id", "target_path"]).doNothing()).execute();
        await trx.updateTable("skill_runtime_file_states").set({
          applied_revision: item.revision, actual_sha256: item.actualSha256, status: wanted.desiredState === "absent" ? "deleted" : "applied",
          last_error: null, checked_at: new Date(), updated_at: new Date()
        }).where("chat_context_id", "=", task.chat_context_id).where("binding_id", "=", wanted.bindingId).where("target_path", "=", wanted.targetPath)
          .where("desired_file_revision_id", "=", wanted.id).execute();
      }
      await trx.updateTable("incidents").set({ state: "resolved", resolved_at: new Date(), updated_at: new Date() }).where("fingerprint", "=", `skill_runtime:${task.chat_context_id}`).where("state", "!=", "resolved").execute();
    });
    this.events.publish("task", taskId); this.events.publish("chat_context", task.chat_context_id);
  }

  async recordRuntimeFailure(taskId: string, executorId: string, body: { skillSetFingerprint: string; runtimeConfigFingerprint: string; code: string; summary: string; targetPath?: string | null | undefined }): Promise<void> {
    const task = await this.db.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id")
      .select(["tasks.skill_set_fingerprint", "tasks.runtime_config_snapshot", "tasks.runtime_config_fingerprint", "conversations.chat_context_id"])
      .where("tasks.id", "=", taskId).where("tasks.executor_id", "=", executorId).executeTakeFirstOrThrow();
    if (task.skill_set_fingerprint !== body.skillSetFingerprint || task.runtime_config_fingerprint !== body.runtimeConfigFingerprint) {
      throw new AppError("Runner 上报的技能运行失败不属于任务固定快照", 409, "runtime_snapshot_mismatch");
    }
    const expectedRuntime = parseRuntime(task.runtime_config_snapshot);
    const targetKey = body.targetPath ? runtimePathCollisionKey(body.targetPath) : null;
    const expectedFile = targetKey ? expectedRuntime.files.find((file) => runtimePathCollisionKey(file.targetPath) === targetKey) : null;
    if (targetKey && !expectedFile) throw new AppError("Runner 上报的失败文件不属于任务固定快照", 409, "runtime_snapshot_mismatch");
    const message = `${body.code}: ${body.summary}`.slice(0, 2_000);
    const forceEligible = new Set(["runtime_file_drift", "runtime_file_exists", "runtime_file_unmanaged_delete"]);
    const fileStatus = forceEligible.has(body.code) ? "conflict" : "error";
    await this.db.transaction().execute(async (trx) => {
      for (const file of expectedFile ? [expectedFile] : []) {
        await trx.insertInto("skill_runtime_file_states").values({
          chat_context_id: task.chat_context_id, binding_id: file.bindingId, target_path: file.targetPath,
          desired_file_revision_id: file.id, desired_revision: file.revision, applied_revision: null, actual_sha256: null,
          status: fileStatus, last_error: message, checked_at: new Date(), updated_at: new Date()
        }).onConflict((conflict) => conflict.columns(["chat_context_id", "binding_id", "target_path"]).doNothing()).execute();
        await trx.updateTable("skill_runtime_file_states").set({ status: fileStatus, last_error: message, checked_at: new Date(), updated_at: new Date() })
          .where("chat_context_id", "=", task.chat_context_id).where("binding_id", "=", file.bindingId).where("target_path", "=", file.targetPath)
          .where("desired_file_revision_id", "=", file.id).execute();
      }
      const fingerprint = `skill_runtime:${task.chat_context_id}`;
      await trx.insertInto("incidents").values({
        fingerprint, kind: "skill_runtime", severity: "critical", title: "任务技能运行配置未能安全生效", summary: message,
        state: "open", related_type: "task", related_id: taskId, first_seen_at: new Date(), last_seen_at: new Date(), acknowledged_by: null,
        acknowledged_at: null, resolved_at: null, notification_message_id: null, last_notified_at: null, last_notification_error: null, updated_at: new Date()
      }).onConflict((entry) => entry.column("fingerprint").doUpdateSet({ state: "open", summary: message, related_type: "task", related_id: taskId, last_seen_at: new Date(), resolved_at: null, updated_at: new Date() })).execute();
    });
    this.events.publish("task", taskId); this.events.publish("chat_context", task.chat_context_id); this.events.publish("incident");
  }

  async syncJobFile(executorId: string, jobId: string, leaseToken: string, fileId: string) {
    const job = await this.db.selectFrom("skill_file_sync_jobs").select(["leased_payload", "leased_fingerprint"]).where("id", "=", jobId).where("executor_id", "=", executorId)
      .where("state", "=", "running").where("lease_token_hash", "=", sha256(leaseToken)).where("lease_expires_at", ">", new Date()).executeTakeFirst();
    if (!job) throw new AppError("同步作业租约无效或已过期", 409, "invalid_sync_lease");
    const payload = job.leased_payload && typeof job.leased_payload === "object" ? job.leased_payload as { runtimeConfig?: { files?: RuntimeFileSnapshot[] } } : {};
    const entry = parseArray<RuntimeFileSnapshot>(payload.runtimeConfig?.files).find((file) => file.id === fileId && file.desiredState === "present");
    if (!entry) throw new AppError("配置文件不在同步作业快照中", 404, "runtime_file_not_in_snapshot");
    const row = await this.db.selectFrom("skill_runtime_file_revisions").selectAll().where("id", "=", fileId).executeTakeFirst();
    if (!row || row.revision !== entry.revision || !row.content_sha256) throw new AppError("配置文件固定修订不可用", 409, "runtime_revision_unavailable");
    const content = this.secrets.decrypt(encryptedFromRow(row), secretAad("file", row.id, row.binding_id, row.chat_context_id, row.target_path, row.revision));
    if (sha256(content) !== row.content_sha256) throw new AppError("配置文件完整性校验失败", 500, "runtime_file_integrity_error");
    return { content, sha256: row.content_sha256, size: Number(row.content_size), targetPath: row.target_path };
  }

  private async audit(actor: string, action: string, botId: string, bindingId: string | null, contextId: string | null, target: string | null, revision: number | null): Promise<void> {
    await this.db.insertInto("skill_admin_audit_events").values({ actor_open_id: actor, action, bot_id: botId, binding_id: bindingId, chat_context_id: contextId, target_name: target, revision, result: "success" }).execute();
  }
}
