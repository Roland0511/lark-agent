import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import pg from "pg";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db/database.js";
import type { ControlPlaneConfig } from "./config.js";
import { buildControlPlane } from "./app.js";
import { EventRouter } from "./event-router.js";
import { ControlPlaneRepository } from "./repository.js";
import type { LarkGateway } from "../lark/gateway.js";
import type { LarkMessageDetails, LarkMessageEvent } from "../shared/contracts.js";
import { sha256 } from "../shared/crypto.js";
import { workerUserSkillsFingerprint } from "../shared/user-skills.js";
import { RuntimeStatus } from "./runtime-status.js";
import { IncidentService } from "./incidents.js";
import { AdminEventBus } from "./admin-events.js";
import { DraftService } from "./drafts.js";
import { TaskOutputService } from "./task-output.js";
import { AppError } from "../shared/errors.js";
import { registerBotAdminRoutes } from "./bot-admin-routes.js";
import { bootstrapLegacyBot, BotGatewayRegistry } from "./bot-runtime.js";
import { MessageRouter } from "./message-router.js";
import { BotDialogueGuardService } from "./bot-dialogue-guard.js";
import { BotPermissionService } from "./bot-permissions.js";
import { RetentionService } from "./retention.js";
import { SkillRuntimeService } from "./skill-runtime-service.js";
import { inspectSkillArchive, SkillHubService } from "./skillhub-service.js";
import { issueWorkerSession } from "./auth.js";
import { ChatIdentityService } from "./chat-identity.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("control plane PostgreSQL integration", () => {
  const db = createDatabase(databaseUrl as string);
  const config: ControlPlaneConfig = {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: databaseUrl as string,
    sessionSigningSecret: "test-session-secret".repeat(2),
    ownerOpenId: "ou_owner",
    botAppId: "cli_bot",
    agentDisplayName: "Lark Agent",
    whitelistChatIds: new Set(["oc_test"]),
    larkEnabled: false,
    larkCardActionsEnabled: false,
    larkCliPath: "lark-cli",
    messageRetentionDays: 30,
    attachmentMaxBytes: 104_857_600,
    attachmentTaskMaxBytes: 209_715_200,
    attachmentRetentionDays: 7,
    traceRetentionDays: 180,
    leaseSeconds: 60,
    sessionMinutes: 60,
    adminOrigin: "https://agent.example.test/lark-agent",
    adminSessionHours: 12,
    adminIdleMinutes: 120,
    metricsBearerToken: "metrics-test-token",
    alertsEnabled: false,
    runnerArtifactPublicBaseUrl: "https://cdn.example.test/home/cdn/lark-agent",
    runnerManifestRefreshSeconds: 300,
    skillhubRegistryUrl: "",
    skillhubApiToken: "",
    skillhubCacheDir: "/tmp/lark-agent-test-skill-cache",
    skillRuntimeEncryptionKeys: `test:${Buffer.alloc(32, 7).toString("base64")}`,
    skillRuntimeActiveKeyId: "test"
  };
  const { app, services } = buildControlPlane(db, config);
  const reconciledBotIds: string[] = [];
  let grantedBotScopes = [
    "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly", "im:message.group_msg",
    "im:message.group_at_msg.include_bot:readonly", "im:message.group_bot_msg:readonly",
    "im:message", "im:chat:readonly", "contact:contact.base:readonly",
    "contact:user.base:readonly", "cardkit:card:write"
  ];
  registerBotAdminRoutes(app, db, config, {
    gateways: services.gateways,
    runtime: services.runtime,
    events: services.adminEvents,
    controller: {
      reconcile: async (botId) => { reconciledBotIds.push(botId); },
      suspend: async () => undefined
    },
    permissions: new BotPermissionService(async () => grantedBotScopes)
  });
  const workspaceMappingFingerprint = "c".repeat(64);
  const insertWorker = async () => db.insertInto("workers").values({
    executor_id: "worker-a", display_name: "Worker A", home_ref: "worker-a:home", codex_profile: "lark-agent",
    config_fingerprint: "a".repeat(64), codex_version: "test", capacity: 1,
    workspace_aliases: JSON.stringify(["repo"]), capabilities: JSON.stringify(["codex", "chat_context_v1"]), last_seen_at: new Date(), updated_at: new Date()
  }).execute();
  const enableWorkerWorkspaceMapping = async () => db.updateTable("workers").set({
    workspace_mapping_fingerprint: workspaceMappingFingerprint,
    capabilities: JSON.stringify(["codex", "chat_context_v1", "workspace_mapping_v1"]),
    updated_at: new Date()
  }).where("executor_id", "=", "worker-a").execute();
  const insertSkillContext = async (chatId: string, executorId: string | null = null) => {
    const worker = executorId ? await db.selectFrom("workers").select("workspace_mapping_fingerprint").where("executor_id", "=", executorId).executeTakeFirst() : null;
    return db.insertInto("chat_contexts").values({
    bot_id: "00000000-0000-0000-0000-000000000001", chat_id: chatId, chat_type: "p2p", codex_thread_id: null,
    executor_id: executorId, executor_home_ref: executorId ? `${executorId}:home` : null, executor_profile: executorId ? "lark-agent" : null,
    executor_config_fingerprint: executorId ? "a".repeat(64) : null, codex_version: executorId ? "test" : null,
    executor_workspace_mapping_fingerprint: worker?.workspace_mapping_fingerprint ?? null,
    workspace_root_alias: executorId ? "repo" : null, state: "uninitialized", blocked_reason: null, last_activity_at: new Date(),
    last_compacted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
  };
  const insertSkillPackage = async (namespace: string, slug: string, name = slug) => db.insertInto("skillhub_packages").values({
    registry_url: "https://registry.example.test", namespace, slug, version: "1.0.0", registry_fingerprint: `sha256:${sha256(`${namespace}/${slug}`)}`,
    archive_sha256: sha256(`archive:${namespace}/${slug}`), archive_path: `/tmp/${namespace}-${slug}.zip`, archive_size: 1,
    skill_name: name, description: `${name} test skill`, dependencies: JSON.stringify({ tools: [] })
  }).returningAll().executeTakeFirstOrThrow();

  beforeAll(async () => {
    const initialSql = await readFile(fileURLToPath(new URL("../db/migrations/001_initial.sql", import.meta.url)), "utf8");
    const adminSql = await readFile(fileURLToPath(new URL("../db/migrations/002_ops_admin.sql", import.meta.url)), "utf8");
    const commandLoginSql = await readFile(fileURLToPath(new URL("../db/migrations/003_lark_command_login.sql", import.meta.url)), "utf8");
    const streamingOutputsSql = await readFile(fileURLToPath(new URL("../db/migrations/004_streaming_outputs.sql", import.meta.url)), "utf8");
    const outputCursorSql = await readFile(fileURLToPath(new URL("../db/migrations/005_output_item_cursor.sql", import.meta.url)), "utf8");
    const multiTurnSql = await readFile(fileURLToPath(new URL("../db/migrations/006_multi_turn_conversations.sql", import.meta.url)), "utf8");
    const resolvedWorkspacesSql = await readFile(fileURLToPath(new URL("../db/migrations/007_resolved_workspaces.sql", import.meta.url)), "utf8");
    const singleUserFlowSql = await readFile(fileURLToPath(new URL("../db/migrations/008_single_user_flow.sql", import.meta.url)), "utf8");
    const runnerEnrollmentSql = await readFile(fileURLToPath(new URL("../db/migrations/009_runner_enrollment.sql", import.meta.url)), "utf8");
    const workerSoftDeleteSql = await readFile(fileURLToPath(new URL("../db/migrations/010_worker_soft_delete.sql", import.meta.url)), "utf8");
    const multiBotSql = await readFile(fileURLToPath(new URL("../db/migrations/011_multi_bot.sql", import.meta.url)), "utf8");
    const latencyAndModelPolicySql = await readFile(fileURLToPath(new URL("../db/migrations/012_latency_and_model_policy.sql", import.meta.url)), "utf8");
    const botDialogueSql = await readFile(fileURLToPath(new URL("../db/migrations/013_bot_dialogue.sql", import.meta.url)), "utf8");
    const botPermissionsSql = await readFile(fileURLToPath(new URL("../db/migrations/014_bot_permissions.sql", import.meta.url)), "utf8");
    const signalAttachmentsSql = await readFile(fileURLToPath(new URL("../db/migrations/015_signal_attachments.sql", import.meta.url)), "utf8");
    const chatContextsSql = await readFile(fileURLToPath(new URL("../db/migrations/016_chat_contexts.sql", import.meta.url)), "utf8");
    const chatContextRecoveryAttemptsSql = await readFile(fileURLToPath(new URL("../db/migrations/017_chat_context_recovery_attempts.sql", import.meta.url)), "utf8");
    const chatContextRebindSql = await readFile(fileURLToPath(new URL("../db/migrations/018_rebind_chat_context_fingerprints.sql", import.meta.url)), "utf8");
    const workerDisplayAliasSql = await readFile(fileURLToPath(new URL("../db/migrations/019_worker_display_alias.sql", import.meta.url)), "utf8");
    const skillhubRuntimeSql = await readFile(fileURLToPath(new URL("../db/migrations/020_skillhub_runtime.sql", import.meta.url)), "utf8");
    const chatContextIdentitySql = await readFile(fileURLToPath(new URL("../db/migrations/021_chat_context_identity.sql", import.meta.url)), "utf8");
    const chatThreadSnapshotsSql = await readFile(fileURLToPath(new URL("../db/migrations/022_chat_thread_snapshots.sql", import.meta.url)), "utf8");
    const chatThreadTurnSummariesSql = await readFile(fileURLToPath(new URL("../db/migrations/023_chat_thread_turn_summaries.sql", import.meta.url)), "utf8");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(initialSql);
    await client.query(adminSql);
    await client.query(commandLoginSql);
    await client.query(streamingOutputsSql);
    await client.query(outputCursorSql);
    await client.query(multiTurnSql);
    await client.query(resolvedWorkspacesSql);
    await client.query(singleUserFlowSql);
    await client.query(runnerEnrollmentSql);
    await client.query(workerSoftDeleteSql);
    const multiBotApplied = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'bot_id'");
    if (multiBotApplied.rowCount === 0) await client.query(multiBotSql);
    const latencyPolicyApplied = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'attention_model_snapshot'");
    if (latencyPolicyApplied.rowCount === 0) await client.query(latencyAndModelPolicySql);
    const botDialogueApplied = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'signals' AND column_name = 'sender_type'");
    if (botDialogueApplied.rowCount === 0) await client.query(botDialogueSql);
    const botPermissionsApplied = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'bots' AND column_name = 'permission_state'");
    if (botPermissionsApplied.rowCount === 0) await client.query(botPermissionsSql);
    const signalAttachmentsApplied = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'signals' AND column_name = 'attachments'");
    if (signalAttachmentsApplied.rowCount === 0) await client.query(signalAttachmentsSql);
    const chatContextsApplied = await client.query("SELECT to_regclass('public.chat_contexts') AS table_name");
    if (!chatContextsApplied.rows[0]?.table_name) await client.query(chatContextsSql);
    const chatContextRecoveryAttemptsApplied = await client.query("SELECT to_regclass('public.chat_context_recovery_attempts') AS table_name");
    if (!chatContextRecoveryAttemptsApplied.rows[0]?.table_name) await client.query(chatContextRecoveryAttemptsSql);
    await client.query(chatContextRebindSql);
    await client.query(workerDisplayAliasSql);
    await client.query(skillhubRuntimeSql);
    const chatContextIdentityApplied = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_contexts' AND column_name = 'peer_open_id'");
    if (chatContextIdentityApplied.rowCount === 0) await client.query(chatContextIdentitySql);
    await client.query(chatThreadSnapshotsSql);
    await client.query(chatThreadTurnSummariesSql);
    await client.end();
  });

  beforeEach(async () => {
    reconciledBotIds.length = 0;
    grantedBotScopes = [
      "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly", "im:message.group_msg",
      "im:message.group_at_msg.include_bot:readonly", "im:message.group_bot_msg:readonly",
      "im:message", "im:chat:readonly", "contact:contact.base:readonly",
      "contact:user.base:readonly", "cardkit:card:write"
    ];
    await db.deleteFrom("admin_sessions").execute();
    await db.deleteFrom("admin_login_tokens").execute();
    await db.deleteFrom("incidents").execute();
    await db.deleteFrom("skill_admin_audit_events").execute();
    await db.deleteFrom("skill_file_sync_jobs").execute();
    await db.deleteFrom("skill_runtime_file_states").execute();
    await db.deleteFrom("skill_runtime_file_revisions").execute();
    await db.deleteFrom("skill_runtime_environment_revisions").execute();
    await db.deleteFrom("bot_skill_bindings").execute();
    await db.deleteFrom("skillhub_packages").execute();
    await db.deleteFrom("bot_dialogue_guards").execute();
    await db.deleteFrom("task_output_updates").execute();
    await db.deleteFrom("task_outputs").execute();
    await db.deleteFrom("outbox_messages").execute();
    await db.deleteFrom("drafts").execute();
    await db.deleteFrom("approvals").execute();
    await db.deleteFrom("task_events").execute();
    await db.deleteFrom("chat_thread_snapshot_jobs").execute();
    await db.deleteFrom("chat_context_recovery_attempts").execute();
    await db.deleteFrom("chat_context_compactions").execute();
    await db.deleteFrom("signals").execute();
    await db.deleteFrom("tasks").execute();
    await db.deleteFrom("conversations").execute();
    await db.deleteFrom("chat_contexts").execute();
    await db.deleteFrom("processed_events").execute();
    await db.deleteFrom("bot_owner_binding_tokens").execute();
    await db.deleteFrom("bot_chat_bindings").execute();
    await db.deleteFrom("worker_device_credentials").execute();
    await db.deleteFrom("worker_enrollment_tokens").execute();
    await db.deleteFrom("workers").execute();
    await db.deleteFrom("bots").where("id", "!=", "00000000-0000-0000-0000-000000000001").execute();
    await db.updateTable("bot_dialogue_settings").set({ max_consecutive_depth: 30, updated_at: new Date() }).where("id", "=", 1).execute();
    await db.updateTable("bots").set({ app_id: config.botAppId, bot_open_id: config.botAppId, display_name: config.agentDisplayName, owner_open_id: config.ownerOpenId, attention_model: null, attention_reasoning_effort: null, execution_model: null, execution_reasoning_effort: null, default_executor_id: null, default_workspace_alias: null, enabled: true, is_system: true, credential_state: "verified", permission_state: "unchecked", permission_check: null, permission_checked_at: null, deleted_at: null }).where("id", "=", "00000000-0000-0000-0000-000000000001").execute();
    await db.insertInto("bot_chat_bindings").values({ bot_id: "00000000-0000-0000-0000-000000000001", chat_id: "oc_test", chat_name: "测试群", enabled: true, preferred_executor_id: null, workspace_alias: null, updated_at: new Date() }).execute();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it("redirects the site root to the admin console", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/admin/");
    const admin = await app.inject({ method: "GET", url: "/admin" });
    expect(admin.statusCode).toBe(302);
    expect(admin.headers.location).toBe("/admin/");
  });

  it("repairs a damaged SkillHub cache row when the same content fingerprint is repacked", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lark-agent-skillhub-repair-"));
    const skillMd = strToU8("---\nname: repaired-skill\ndescription: damaged cache repair test\n---\n\n# Repair\n");
    const script = strToU8(`#!/bin/sh\n${"echo repair\n".repeat(2_000)}`);
    const originalArchive = Buffer.from(zipSync({ "SKILL.md": skillMd, "scripts/run.sh": script }, { level: 0 }));
    const repackedArchive = Buffer.from(zipSync({ "SKILL.md": skillMd, "scripts/run.sh": script }, { level: 9 }));
    const registryFingerprint = inspectSkillArchive(originalArchive).registryFingerprint;
    expect(inspectSkillArchive(repackedArchive).registryFingerprint).toBe(registryFingerprint);
    expect(sha256(repackedArchive)).not.toBe(sha256(originalArchive));
    const resolveBody = JSON.stringify({ data: { namespace: "repair", slug: "same-content", version: "1.0.0", fingerprint: registryFingerprint } });
    const responses = [
      new Response(resolveBody, { status: 200, headers: { "content-type": "application/json" } }),
      new Response(new Uint8Array(originalArchive), { status: 200, headers: { "content-length": String(originalArchive.length) } }),
      new Response(resolveBody, { status: 200, headers: { "content-type": "application/json" } }),
      new Response(new Uint8Array(repackedArchive), { status: 200, headers: { "content-length": String(repackedArchive.length) } })
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 })));
    try {
      const hub = new SkillHubService(db, {
        ...config, skillhubRegistryUrl: "https://registry.example.test", skillhubApiToken: "test-token", skillhubCacheDir: cacheDir
      });
      const original = await hub.resolveAndCache("@repair/same-content");
      await writeFile(original.archive_path, Buffer.from("damaged cache"));

      const repaired = await hub.resolveAndCache("@repair/same-content");
      expect(repaired.id).toBe(original.id);
      expect(repaired.archive_sha256).toBe(sha256(repackedArchive));
      expect(repaired.archive_path).not.toBe(original.archive_path);
      await expect(hub.verifyCachedPackage(repaired.id)).resolves.toMatchObject({ archive_sha256: sha256(repackedArchive) });
    } finally {
      vi.unstubAllGlobals();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("persists encrypted environment revisions and atomically rejects cross-platform file collisions", async () => {
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const firstPackage = await insertSkillPackage("runtime", "first");
    const firstBinding = await db.insertInto("bot_skill_bindings").values({
      bot_id: "00000000-0000-0000-0000-000000000001", chat_context_id: null, package_id: firstPackage.id,
      namespace: firstPackage.namespace, slug: firstPackage.slug, created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();

    await expect(runtime.putEnvironment(firstBinding.bot_id, firstBinding.id, "API_TOKEN", null, "", "ou_owner"))
      .rejects.toMatchObject({ statusCode: 400, code: "runtime_environment_value_required" });
    await expect(runtime.putEnvironment(firstBinding.bot_id, firstBinding.id, "API_TOKEN", null, "bad\0value", "ou_owner"))
      .rejects.toMatchObject({ statusCode: 400, code: "invalid_runtime_environment_value" });
    const firstSecret = await runtime.putEnvironment(firstBinding.bot_id, firstBinding.id, "API_TOKEN", null, "secret-one", "ou_owner");
    const secondSecret = await runtime.putEnvironment(firstBinding.bot_id, firstBinding.id, "API_TOKEN", null, "secret-two", "ou_owner");
    expect(secondSecret.revision).toBe(firstSecret.revision + 1);
    await runtime.putEnvironment(firstBinding.bot_id, firstBinding.id, "API_TOKEN", null, null, "ou_owner");
    const activeEnvironment = await db.selectFrom("skill_runtime_environment_revisions").selectAll().where("binding_id", "=", firstBinding.id).where("superseded_at", "is", null).executeTakeFirstOrThrow();
    expect({ ...activeEnvironment, value_size: Number(activeEnvironment.value_size) }).toMatchObject({ desired_state: "absent", value_size: 0, ciphertext: null });

    await runtime.putFile(firstBinding.bot_id, firstBinding.id, "A.env", null, Buffer.from("ONE=1\n"), "ou_owner");
    const secondPackage = await insertSkillPackage("runtime", "second");
    const secondBinding = await db.insertInto("bot_skill_bindings").values({
      bot_id: firstBinding.bot_id, chat_context_id: null, package_id: secondPackage.id, namespace: secondPackage.namespace,
      slug: secondPackage.slug, created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    await expect(runtime.putFile(secondBinding.bot_id, secondBinding.id, "a.env", null, Buffer.from("TWO=2\n"), "ou_owner"))
      .rejects.toMatchObject({ statusCode: 409, code: "runtime_file_conflict" });
    expect(await db.selectFrom("skill_runtime_file_revisions").select("id").where("binding_id", "=", secondBinding.id).execute()).toHaveLength(0);
  });

  it("queues only the latest runtime files when a Thread receives its first executor binding", async () => {
    await insertWorker();
    const context = await insertSkillContext("oc_first_executor_binding");
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const pkg = await insertSkillPackage("runtime", "first-binding");
    const binding = await db.insertInto("bot_skill_bindings").values({
      bot_id: context.bot_id, chat_context_id: null, package_id: pkg.id, namespace: pkg.namespace, slug: pkg.slug,
      created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();

    const firstFile = await runtime.putFile(context.bot_id, binding.id, ".env", null, Buffer.from("TOKEN=first\n"), "ou_owner");
    const latestFile = await runtime.putFile(context.bot_id, binding.id, ".env", null, Buffer.from("TOKEN=latest\n"), "ou_owner", firstFile.id);
    expect(await db.selectFrom("skill_file_sync_jobs").select("id").where("chat_context_id", "=", context.id).execute()).toHaveLength(0);
    expect(await db.selectFrom("skill_runtime_file_states").select("chat_context_id").where("chat_context_id", "=", context.id).execute()).toHaveLength(0);

    await db.updateTable("chat_contexts").set({
      executor_id: "worker-a", executor_home_ref: "worker-a:home", executor_profile: "lark-agent",
      executor_config_fingerprint: "a".repeat(64), codex_version: "test", workspace_root_alias: "repo",
      state: "ready", updated_at: new Date()
    }).where("id", "=", context.id).execute();
    await runtime.enqueueLatestForContext(context.id);

    const job = await db.selectFrom("skill_file_sync_jobs").select(["state", "payload"]).where("chat_context_id", "=", context.id).executeTakeFirstOrThrow();
    const payload = job.payload as { runtimeConfig: { files: Array<{ id: string }> } };
    expect(job.state).toBe("queued");
    expect(payload.runtimeConfig.files.map((file) => file.id)).toEqual([latestFile.id]);
    expect(await db.selectFrom("skill_runtime_file_states").select(["desired_file_revision_id", "status"]).where("chat_context_id", "=", context.id).executeTakeFirstOrThrow())
      .toEqual({ desired_file_revision_id: latestFile.id, status: "pending" });

    await db.updateTable("skill_file_sync_jobs").set({ state: "completed", completed_at: new Date(), updated_at: new Date() }).where("chat_context_id", "=", context.id).execute();
    await db.updateTable("skill_runtime_file_states").set({ status: "applied", applied_revision: latestFile.revision, actual_sha256: latestFile.sha256, updated_at: new Date() }).where("chat_context_id", "=", context.id).execute();
    await runtime.enqueueLatestForContext(context.id);
    expect(await db.selectFrom("skill_file_sync_jobs").select("id").where("chat_context_id", "=", context.id).execute()).toHaveLength(1);
    expect((await db.selectFrom("skill_runtime_file_states").select("status").where("chat_context_id", "=", context.id).executeTakeFirstOrThrow()).status).toBe("applied");
  });

  it("shows a case-insensitive Thread file override as one effective runtime path", async () => {
    const context = await insertSkillContext("oc_case_folded_override");
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const pkg = await insertSkillPackage("runtime", "case-folded-override");
    const binding = await db.insertInto("bot_skill_bindings").values({
      bot_id: context.bot_id, chat_context_id: null, package_id: pkg.id, namespace: pkg.namespace, slug: pkg.slug,
      created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    await runtime.putFile(context.bot_id, binding.id, "A.env", null, Buffer.from("SCOPE=global\n"), "ou_owner");
    await db.insertInto("skill_runtime_file_revisions").values({
      id: "99999999-9999-4999-8999-999999999999",
      binding_id: binding.id, chat_context_id: context.id, target_path: "a.env", target_path_key: "a.env", desired_state: "absent",
      key_id: null, nonce: null, ciphertext: null, auth_tag: null, content_sha256: null, content_size: 0,
      revision: 1, superseded_at: null, created_by: "migration:test"
    }).execute();

    expect((await runtime.listRuntimeConfig(context.bot_id, binding.id, context.id)).files).toEqual([
      expect.objectContaining({ targetPath: "a.env", sourceScope: "chat_context", desiredState: "absent" })
    ]);
  });

  it("allows a same-coordinate Thread override at 64 effective skills and rolls a 65th global skill back", async () => {
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const context = await insertSkillContext("oc_skill_limit");
    const packages = [];
    for (let index = 0; index < 65; index += 1) packages.push(await insertSkillPackage("limit", `skill-${index}`, `limit-skill-${index}`));
    await db.insertInto("bot_skill_bindings").values(packages.slice(0, 64).map((pkg) => ({
      bot_id: context.bot_id, chat_context_id: null, package_id: pkg.id, namespace: pkg.namespace, slug: pkg.slug,
      created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }))).execute();
    const resolve = vi.spyOn(runtime.hub, "resolveAndCache").mockResolvedValueOnce(packages[0]!).mockResolvedValueOnce(packages[64]!);
    try {
      await expect(runtime.addBinding(context.bot_id, "@limit/skill-0", context.id, "ou_owner")).resolves.toMatchObject({ chat_context_id: context.id });
      await expect(runtime.addBinding(context.bot_id, "@limit/skill-64", null, "ou_owner"))
        .rejects.toMatchObject({ statusCode: 409, code: "skill_limit_exceeded" });
      expect(await db.selectFrom("bot_skill_bindings").select("id").where("bot_id", "=", context.bot_id).where("deleted_at", "is", null).execute()).toHaveLength(65);
    } finally {
      resolve.mockRestore();
    }
  });

  it("requeues the latest desired sync when an old lease result arrives and supports heartbeat renewal", async () => {
    await insertWorker();
    const context = await insertSkillContext("oc_sync_stale", "worker-a");
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const oldDesired = "1".repeat(64); const newDesired = "2".repeat(64);
    const oldSkill = "3".repeat(64); const oldRuntime = "4".repeat(64);
    const newPayload = { skillSetFingerprint: "5".repeat(64), runtimeConfig: { fingerprint: "6".repeat(64), files: [] } };
    const oldPayload = { skillSetFingerprint: oldSkill, runtimeConfig: { fingerprint: oldRuntime, files: [] } };
    const job = await db.insertInto("skill_file_sync_jobs").values({
      chat_context_id: context.id, executor_id: "worker-a", desired_fingerprint: newDesired, leased_fingerprint: oldDesired,
      payload: JSON.stringify(newPayload), leased_payload: JSON.stringify(oldPayload), state: "running", lease_token_hash: sha256("old-lease"),
      lease_expires_at: new Date(Date.now() + 60_000), attempt: 1, last_error: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();

    await runtime.finishSyncJob("worker-a", job.id, "old-lease", {
      desiredFingerprint: oldDesired, skillSetFingerprint: oldSkill, runtimeConfigFingerprint: oldRuntime, status: "applied", summary: "old result", files: []
    });
    expect(await db.selectFrom("skill_file_sync_jobs").select(["state", "desired_fingerprint", "leased_fingerprint", "leased_payload"]).where("id", "=", job.id).executeTakeFirstOrThrow())
      .toMatchObject({ state: "queued", desired_fingerprint: newDesired, leased_fingerprint: null, leased_payload: null });
    const before = new Date(Date.now() + 60_000);
    await db.updateTable("skill_file_sync_jobs").set({
      state: "running", leased_fingerprint: newDesired, leased_payload: JSON.stringify(newPayload), lease_token_hash: sha256("new-lease"), lease_expires_at: before
    }).where("id", "=", job.id).execute();
    const heartbeat = await runtime.heartbeatSyncJob("worker-a", job.id, "new-lease", 60);
    expect(new Date(heartbeat.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it("only leases workspace sync to the Runner identity fixed on an unblocked chat context", async () => {
    await insertWorker();
    await enableWorkerWorkspaceMapping();
    const context = await insertSkillContext("oc_sync_identity_gate", "worker-a");
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const payload = {
      botAppId: "cli_bot", resolvedWorkspaceAlias: "repo", skills: [], skillSetFingerprint: "2".repeat(64),
      runtimeConfig: { fingerprint: "3".repeat(64), files: [] }
    };
    const job = await db.insertInto("skill_file_sync_jobs").values({
      chat_context_id: context.id, executor_id: "worker-a", desired_fingerprint: "1".repeat(64),
      payload: JSON.stringify(payload), state: "queued", updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();
    const original = { executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64), workspaceMappingFingerprint };

    await db.updateTable("chat_contexts").set({ state: "blocked", updated_at: new Date() }).where("id", "=", context.id).execute();
    await expect(runtime.claimSyncJob(original, 60)).resolves.toBeNull();
    expect((await db.selectFrom("skill_file_sync_jobs").select("state").where("id", "=", job.id).executeTakeFirstOrThrow()).state).toBe("queued");

    await db.updateTable("chat_contexts").set({ state: "ready", updated_at: new Date() }).where("id", "=", context.id).execute();
    await expect(runtime.claimSyncJob({ ...original, configFingerprint: "b".repeat(64) }, 60))
      .rejects.toMatchObject({ statusCode: 409, code: "worker_config_changed" });

    await db.updateTable("workers").set({ config_fingerprint: "b".repeat(64), updated_at: new Date() }).where("executor_id", "=", "worker-a").execute();
    await expect(runtime.claimSyncJob({ ...original, configFingerprint: "b".repeat(64) }, 60)).resolves.toBeNull();

    await db.updateTable("workers").set({ config_fingerprint: original.configFingerprint, workspace_aliases: JSON.stringify([]), updated_at: new Date() }).where("executor_id", "=", "worker-a").execute();
    await expect(runtime.claimSyncJob(original, 60)).resolves.toBeNull();

    await db.updateTable("workers").set({ workspace_aliases: JSON.stringify(["repo"]), updated_at: new Date() }).where("executor_id", "=", "worker-a").execute();
    await db.updateTable("skill_file_sync_jobs").set({ payload: JSON.stringify({ ...payload, resolvedWorkspaceAlias: "other" }), updated_at: new Date() }).where("id", "=", job.id).execute();
    await expect(runtime.claimSyncJob(original, 60)).resolves.toBeNull();

    await db.updateTable("skill_file_sync_jobs").set({ payload: JSON.stringify(payload), updated_at: new Date() }).where("id", "=", job.id).execute();
    await expect(runtime.claimSyncJob(original, 60)).resolves.toMatchObject({ id: job.id, resolvedWorkspaceAlias: "repo" });
  });

  it("lets only the owner retry a failed managed-skill-only sync with CSRF protection", async () => {
    await insertWorker();
    await enableWorkerWorkspaceMapping();
    const context = await insertSkillContext("oc_retry_managed_skill", "worker-a");
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const pkg = await insertSkillPackage("runtime", "retry-managed-only");
    await db.insertInto("bot_skill_bindings").values({
      bot_id: context.bot_id, chat_context_id: null, package_id: pkg.id, namespace: pkg.namespace, slug: pkg.slug,
      created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).execute();
    await runtime.enqueueLatestForContext(context.id);
    const first = await runtime.claimSyncJob({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64), workspaceMappingFingerprint }, 60);
    expect(first?.skills).toHaveLength(1);
    expect(first?.runtimeConfig.files).toEqual([]);
    await runtime.finishSyncJob("worker-a", first!.id, first!.leaseToken, {
      desiredFingerprint: first!.desiredFingerprint, skillSetFingerprint: first!.skillSetFingerprint!,
      runtimeConfigFingerprint: first!.runtimeConfig.fingerprint!, status: "failed", summary: "temporary registry outage", files: []
    });
    expect((await db.selectFrom("skill_file_sync_jobs").select("state").where("id", "=", first!.id).executeTakeFirstOrThrow()).state).toBe("failed");

    await db.insertInto("admin_sessions").values({
      token_hash: sha256("owner-skill-retry"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "skill-retry-csrf",
      last_seen_at: new Date(), expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const cookie = { cookie: "lark_agent_admin_session=owner-skill-retry" };
    const missingCsrf = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/skill-runtime/retry`, headers: cookie });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json<{ error: { code: string } }>().error.code).toBe("invalid_csrf");
    const retried = await app.inject({
      method: "POST", url: `/v1/admin/chat-contexts/${context.id}/skill-runtime/retry`,
      headers: { ...cookie, "x-csrf-token": "skill-retry-csrf" }
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ ok: true, queued: true });
    expect(await db.selectFrom("skill_admin_audit_events").select(["actor_open_id", "action", "chat_context_id"]).where("action", "=", "skill.runtime.sync.retry").executeTakeFirstOrThrow())
      .toEqual({ actor_open_id: "ou_owner", action: "skill.runtime.sync.retry", chat_context_id: context.id });

    const second = await runtime.claimSyncJob({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64), workspaceMappingFingerprint }, 60);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.skills).toHaveLength(1);
    await runtime.finishSyncJob("worker-a", second!.id, second!.leaseToken, {
      desiredFingerprint: second!.desiredFingerprint, skillSetFingerprint: second!.skillSetFingerprint!,
      runtimeConfigFingerprint: second!.runtimeConfig.fingerprint!, status: "applied", summary: "recovered", files: []
    });
    expect((await db.selectFrom("skill_file_sync_jobs").select("state").where("id", "=", second!.id).executeTakeFirstOrThrow()).state).toBe("completed");
    expect((await db.selectFrom("incidents").select("state").where("fingerprint", "=", `skill_file_sync:${context.id}`).executeTakeFirstOrThrow()).state).toBe("resolved");
  });

  it("never lets an old task runtime report overwrite a newer desired file revision", async () => {
    await insertWorker();
    await db.updateTable("workers").set({
      capabilities: JSON.stringify(["codex", "chat_context_v1", "skillhub_skills_v1", "skill_runtime_config_v1", "user_skills_inventory_v1"]),
      user_skills_scan_status: "ready", user_skills: JSON.stringify([]), user_skills_truncated: false, user_skills_scanned_at: new Date()
    }).where("executor_id", "=", "worker-a").execute();
    const context = await insertSkillContext("oc_old_task_runtime");
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const pkg = await insertSkillPackage("runtime", "old-task");
    const binding = await db.insertInto("bot_skill_bindings").values({
      bot_id: context.bot_id, chat_context_id: null, package_id: pkg.id, namespace: pkg.namespace, slug: pkg.slug,
      created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const firstFile = await runtime.putFile(context.bot_id, binding.id, ".env", null, Buffer.from("TOKEN=first\n"), "ou_owner");
    await db.updateTable("chat_contexts").set({
      executor_id: "worker-a", executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64),
      codex_version: "test", workspace_root_alias: "repo", state: "ready", updated_at: new Date()
    }).where("id", "=", context.id).execute();
    const conversation = await db.insertInto("conversations").values({
      bot_id: context.bot_id, chat_context_id: context.id, bot_config_revision: 1, role_instructions_snapshot: "test",
      attention_model_snapshot: null, attention_reasoning_effort_snapshot: null, execution_model_snapshot: null, execution_reasoning_effort_snapshot: null,
      chat_id: context.chat_id, chat_type: "p2p", root_message_id: "om_old_task", thread_id: null, room_seq: 1, active: true,
      response_message_id: null, followup_expires_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      bot_id: context.bot_id, conversation_id: conversation.id, state: "running", trigger_message_id: "om_old_task", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo", resolved_workspace_alias: "repo", preferred_executor_id: "worker-a", executor_id: "worker-a", codex_thread_id: null,
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test",
      lease_token_hash: sha256("task-lease"), lease_expires_at: new Date(Date.now() + 60_000), summary: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const snapshot = await runtime.prepareTaskSnapshot(task.id);
    expect(snapshot.runtimeConfig.files[0]?.id).toBe(firstFile.id);

    await expect(runtime.recordRuntimeFailure(task.id, "worker-a", {
      skillSetFingerprint: snapshot.skillSetFingerprint, runtimeConfigFingerprint: snapshot.runtimeConfigFingerprint,
      code: "runtime_file_exists", summary: "unknown path", targetPath: "other.env"
    })).rejects.toMatchObject({ statusCode: 409, code: "runtime_snapshot_mismatch" });
    await runtime.recordRuntimeFailure(task.id, "worker-a", {
      skillSetFingerprint: snapshot.skillSetFingerprint, runtimeConfigFingerprint: snapshot.runtimeConfigFingerprint,
      code: "runtime_file_exists", summary: "current task observed an unmanaged file", targetPath: ".env"
    });
    expect(await db.selectFrom("skill_runtime_file_states").select(["desired_file_revision_id", "status"]).where("chat_context_id", "=", context.id).where("binding_id", "=", binding.id).executeTakeFirstOrThrow())
      .toEqual({ desired_file_revision_id: firstFile.id, status: "conflict" });
    await expect(runtime.forceFile(context.bot_id, binding.id, firstFile.id, context.id)).resolves.toBeUndefined();
    expect((await db.selectFrom("skill_runtime_file_states").select("status").where("chat_context_id", "=", context.id).where("binding_id", "=", binding.id).executeTakeFirstOrThrow()).status)
      .toBe("pending_force");

    const secondFile = await runtime.putFile(context.bot_id, binding.id, ".env", null, Buffer.from("TOKEN=second\n"), "ou_owner", firstFile.id);
    const pending = await db.selectFrom("skill_runtime_file_states").selectAll().where("chat_context_id", "=", context.id).where("binding_id", "=", binding.id).executeTakeFirstOrThrow();
    expect(pending).toMatchObject({ desired_file_revision_id: secondFile.id, status: "pending" });

    await runtime.recordRuntimeFailure(task.id, "worker-a", {
      skillSetFingerprint: snapshot.skillSetFingerprint, runtimeConfigFingerprint: snapshot.runtimeConfigFingerprint,
      code: "runtime_file_unmanaged_delete", summary: "old task observed drift", targetPath: ".env"
    });
    expect(await db.selectFrom("skill_runtime_file_states").select(["desired_file_revision_id", "status"]).where("chat_context_id", "=", context.id).where("binding_id", "=", binding.id).executeTakeFirstOrThrow())
      .toEqual({ desired_file_revision_id: secondFile.id, status: "pending" });
    await runtime.recordRuntimeSnapshot(task.id, "worker-a", {
      skillSetFingerprint: snapshot.skillSetFingerprint, runtimeConfigFingerprint: snapshot.runtimeConfigFingerprint,
      managedSkills: snapshot.skills, userSkills: [], environmentNames: [],
      files: [{ id: firstFile.id, targetPath: ".env", revision: firstFile.revision, actualSha256: firstFile.sha256, status: "applied", error: null }]
    });
    expect(await db.selectFrom("skill_runtime_file_states").select(["desired_file_revision_id", "status"]).where("chat_context_id", "=", context.id).where("binding_id", "=", binding.id).executeTakeFirstOrThrow())
      .toEqual({ desired_file_revision_id: secondFile.id, status: "pending" });
    expect((await db.selectFrom("incidents").select("state").where("fingerprint", "=", `skill_runtime:${context.id}`).executeTakeFirstOrThrow()).state).toBe("resolved");
  });

  it("marks files removed from the leased manifest deleted before allowing binding cleanup", async () => {
    await insertWorker();
    await enableWorkerWorkspaceMapping();
    const context = await insertSkillContext("oc_restore_file", "worker-a");
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const pkg = await insertSkillPackage("runtime", "restore-file");
    const binding = await db.insertInto("bot_skill_bindings").values({
      bot_id: context.bot_id, chat_context_id: null, package_id: pkg.id, namespace: pkg.namespace, slug: pkg.slug,
      created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const file = await runtime.putFile(context.bot_id, binding.id, "thread.env", context.id, Buffer.from("THREAD=1\n"), "ou_owner");
    await db.updateTable("skill_runtime_file_states").set({
      applied_revision: file.revision, actual_sha256: file.sha256, status: "applied", checked_at: new Date(), updated_at: new Date()
    }).where("chat_context_id", "=", context.id).where("binding_id", "=", binding.id).execute();
    await runtime.deleteFile(context.bot_id, binding.id, file.id, context.id, true, "ou_owner");
    const claimed = await runtime.claimSyncJob({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64), workspaceMappingFingerprint }, 60);
    expect(claimed?.runtimeConfig.files).toEqual([]);
    await runtime.finishSyncJob("worker-a", claimed!.id, claimed!.leaseToken, {
      desiredFingerprint: claimed!.desiredFingerprint, skillSetFingerprint: claimed!.skillSetFingerprint!,
      runtimeConfigFingerprint: claimed!.runtimeConfig.fingerprint!, status: "applied", summary: "removed", files: []
    });
    expect((await db.selectFrom("skill_runtime_file_states").select("status").where("chat_context_id", "=", context.id).where("binding_id", "=", binding.id).executeTakeFirstOrThrow()).status).toBe("deleted");
    await expect(runtime.deleteBinding(context.bot_id, binding.id, "ou_owner")).resolves.toBeUndefined();
  });

  it("aggregates global file state across bound Threads without reporting a permanent pending state", async () => {
    await insertWorker();
    const firstContext = await insertSkillContext("oc_global_file_first", "worker-a");
    const secondContext = await insertSkillContext("oc_global_file_second", "worker-a");
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const pkg = await insertSkillPackage("runtime", "global-file-state");
    const binding = await db.insertInto("bot_skill_bindings").values({
      bot_id: firstContext.bot_id, chat_context_id: null, package_id: pkg.id, namespace: pkg.namespace, slug: pkg.slug,
      created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const file = await runtime.putFile(firstContext.bot_id, binding.id, "config/global.env", null, Buffer.from("GLOBAL=1\n"), "ou_owner");
    expect((await runtime.listRuntimeConfig(firstContext.bot_id, binding.id, null)).files[0]).toMatchObject({ status: "pending", actualSha256: null });

    await db.updateTable("skill_runtime_file_states").set({ status: "applied", applied_revision: file.revision, actual_sha256: file.sha256, checked_at: new Date(), updated_at: new Date() })
      .where("binding_id", "=", binding.id).execute();
    expect((await runtime.listRuntimeConfig(firstContext.bot_id, binding.id, null)).files[0]).toMatchObject({ status: "applied", actualSha256: file.sha256 });

    await db.updateTable("skill_runtime_file_states").set({ actual_sha256: "f".repeat(64), updated_at: new Date() }).where("chat_context_id", "=", secondContext.id).where("binding_id", "=", binding.id).execute();
    expect((await runtime.listRuntimeConfig(firstContext.bot_id, binding.id, null)).files[0]).toMatchObject({ status: "drift", actualSha256: null });
    await db.updateTable("skill_runtime_file_states").set({ status: "conflict", last_error: "workspace file exists", updated_at: new Date() }).where("chat_context_id", "=", firstContext.id).where("binding_id", "=", binding.id).execute();
    expect((await runtime.listRuntimeConfig(firstContext.bot_id, binding.id, null)).files[0]).toMatchObject({ status: "conflict", lastError: "workspace file exists" });
  });

  it("backfills the active historical Thread and its matching execution environment", async () => {
    const schema = "chat_context_migration_test";
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      const migrationNames = [
        "001_initial.sql", "002_ops_admin.sql", "003_lark_command_login.sql", "004_streaming_outputs.sql",
        "005_output_item_cursor.sql", "006_multi_turn_conversations.sql", "007_resolved_workspaces.sql",
        "008_single_user_flow.sql", "009_runner_enrollment.sql", "010_worker_soft_delete.sql", "011_multi_bot.sql",
        "012_latency_and_model_policy.sql", "013_bot_dialogue.sql", "014_bot_permissions.sql", "015_signal_attachments.sql"
      ];
      for (const name of migrationNames) {
        await client.query(await readFile(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), "utf8"));
      }
      await client.query(`
        INSERT INTO workers(executor_id, display_name, home_ref, codex_profile, config_fingerprint, codex_version, capacity, workspace_aliases, capabilities, last_seen_at)
        VALUES ('worker-history', 'History Worker', 'history:home', 'history-profile', '${"f".repeat(64)}', 'test', 1, '["repo"]', '["codex","chat_context_v1"]', now());
        INSERT INTO conversations(id, chat_id, chat_type, root_message_id, active, updated_at)
        VALUES
          ('10000000-0000-4000-8000-000000000001', 'oc_history', 'group', 'om_active', false, now() - interval '2 days'),
          ('10000000-0000-4000-8000-000000000002', 'oc_history', 'group', 'om_recent', true, now());
        INSERT INTO tasks(conversation_id, state, trigger_message_id, requester_id, requester_role, authorization_grant,
          requested_workspace_alias, resolved_workspace_alias, preferred_executor_id, executor_id, codex_thread_id,
          executor_home_ref, executor_profile, executor_config_fingerprint, codex_version, turn_index, updated_at)
        VALUES
          ('10000000-0000-4000-8000-000000000001', 'waiting_input', 'om_active', 'ou_owner', 'owner', '{}',
            'repo', 'repo', 'worker-history', 'worker-history', 'thread-active', 'history:home', 'history-profile', '${"f".repeat(64)}', 'test', 1, now() - interval '2 days'),
          ('10000000-0000-4000-8000-000000000002', 'completed', 'om_recent', 'ou_owner', 'owner', '{}',
            'repo', 'repo', 'worker-history', 'worker-history', 'thread-recent', 'history:home', 'history-profile', '${"f".repeat(64)}', 'test', 1, now()),
          ('10000000-0000-4000-8000-000000000002', 'waiting_worker', 'om_stale', 'ou_owner', 'owner', '{}',
            'stale', 'stale', 'worker-history', 'worker-history', 'thread-stale', 'stale:home', 'stale-profile', '${"e".repeat(64)}', 'stale', 2, now() - interval '3 days');
      `);
      await client.query(await readFile(fileURLToPath(new URL("../db/migrations/016_chat_contexts.sql", import.meta.url)), "utf8"));
      const context = (await client.query(`SELECT * FROM chat_contexts WHERE chat_id = 'oc_history'`)).rows[0];
      expect(context).toMatchObject({
        codex_thread_id: "thread-active", executor_id: "worker-history", executor_home_ref: "history:home",
        executor_profile: "history-profile", executor_config_fingerprint: "f".repeat(64), workspace_root_alias: "repo", state: "ready"
      });
      expect((await client.query("SELECT count(DISTINCT chat_context_id)::int AS count FROM conversations")).rows[0]?.count).toBe(1);
      expect((await client.query("SELECT codex_thread_id, executor_id, executor_home_ref, executor_profile, executor_config_fingerprint, requested_workspace_alias, resolved_workspace_alias, revision FROM tasks WHERE trigger_message_id = 'om_stale'")).rows[0]).toMatchObject({
        codex_thread_id: "thread-active", executor_id: "worker-history", executor_home_ref: "history:home",
        executor_profile: "history-profile", executor_config_fingerprint: "f".repeat(64),
        requested_workspace_alias: "repo", resolved_workspace_alias: "repo", revision: 1
      });
      expect((await client.query("SELECT count(*)::int AS count FROM pg_constraint WHERE conname = 'conversations_chat_context_id_fkey' AND conrelid = 'conversations'::regclass")).rows[0]?.count).toBe(1);
      expect((await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'chat_context_compactions' AND indexname IN ('chat_context_compactions_context_item_idx', 'chat_context_compactions_context_legacy_turn_idx') ORDER BY indexname")).rows.map((row) => row.indexname)).toEqual([
        "chat_context_compactions_context_item_idx", "chat_context_compactions_context_legacy_turn_idx"
      ]);
      await client.query(await readFile(fileURLToPath(new URL("../db/migrations/017_chat_context_recovery_attempts.sql", import.meta.url)), "utf8"));
      await client.query(`
        UPDATE workers
        SET config_fingerprint = '${"a".repeat(64)}', codex_version = 'next', runner_version = '0.3.1', last_seen_at = now()
        WHERE executor_id = 'worker-history';
        UPDATE chat_contexts
        SET state = 'blocked', blocked_reason = '旧版整份配置指纹已变化'
        WHERE chat_id = 'oc_history';
      `);
      await client.query(await readFile(fileURLToPath(new URL("../db/migrations/018_rebind_chat_context_fingerprints.sql", import.meta.url)), "utf8"));
      expect((await client.query("SELECT state, blocked_reason, executor_config_fingerprint, codex_version FROM chat_contexts WHERE chat_id = 'oc_history'")).rows[0]).toMatchObject({
        state: "ready", blocked_reason: null, executor_config_fingerprint: "a".repeat(64), codex_version: "next"
      });
      expect((await client.query("SELECT actor_open_id, result, failed_check_keys FROM chat_context_recovery_attempts")).rows[0]).toMatchObject({
        actor_open_id: "system:migration-018", result: "recovered", failed_check_keys: []
      });
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    }
  });

  it("does not require bootstrap identity after a bot has been imported", async () => {
    const withoutBootstrap = { ...config, ownerOpenId: "", botAppId: "", whitelistChatIds: new Set<string>() };
    await expect(bootstrapLegacyBot(db, withoutBootstrap)).resolves.toMatchObject({ app_id: "cli_bot", owner_open_id: "ou_owner" });
    await db.updateTable("bots").set({ app_id: "__legacy__", owner_open_id: null }).where("id", "=", "00000000-0000-0000-0000-000000000001").execute();
    await expect(bootstrapLegacyBot(db, withoutBootstrap)).rejects.toThrow("空数据库首次启动需要配置 BOT_APP_ID 和 OWNER_OPEN_ID");
  });

  it("clears attachment metadata together with expired signal content", async () => {
    const old = new Date(Date.now() - 31 * 86_400_000);
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_retention", chat_type: "p2p", root_message_id: "om_retention", thread_id: null,
      room_seq: 1, active: false, response_message_id: null, created_at: old, updated_at: old
    }).returning("id").executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, state: "completed", trigger_message_id: "om_retention", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, preferred_executor_id: null, executor_id: null, codex_thread_id: null, lease_token_hash: null, lease_expires_at: null,
      summary: null, created_at: old, updated_at: old, completed_at: old
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("processed_events").values({ event_id: "ev_retention", event_type: "message", status: "processed", received_at: old, processed_at: old }).execute();
    await db.insertInto("signals").values({
      conversation_id: conversation.id, task_id: task.id, event_id: "ev_retention", seq: 1, message_id: "om_retention", origin_message_id: "om_retention",
      sender_id: "ou_owner", sender_role: "owner", message_type: "file", content: "old", preview: "old",
      attachments: JSON.stringify([{ id: "99999999-9999-4999-8999-999999999999", type: "file", fileName: "old.txt", resourceKey: "file_old" }]),
      priority: 90, decision: "consume", decision_rationale: null, created_at: old, decided_at: old
    }).execute();
    await new RetentionService(db, 30, 180).runOnce();
    const retained = await db.selectFrom("signals").select(["content", "preview", "attachments"]).where("task_id", "=", task.id).executeTakeFirstOrThrow();
    expect(retained).toEqual({ content: "[expired]", preview: "[expired]", attachments: [] });
  });

  it("reconnects one enabled bot without changing its configuration", async () => {
    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("owner-reconnect-bot"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "reconnect-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const botId = "00000000-0000-0000-0000-000000000001";
    const before = await db.selectFrom("bots").select(["enabled", "is_system", "config_revision"]).where("id", "=", botId).executeTakeFirstOrThrow();
    const response = await app.inject({
      method: "POST", url: `/v1/admin/bots/${botId}/commands`,
      headers: { cookie: "lark_agent_admin_session=owner-reconnect-bot", "x-csrf-token": "reconnect-csrf" },
      payload: { command: "reconnect" }
    });
    expect(response.statusCode).toBe(200);
    expect(reconciledBotIds).toEqual([botId]);
    expect(await db.selectFrom("bots").select(["enabled", "is_system", "config_revision"]).where("id", "=", botId).executeTakeFirstOrThrow()).toEqual(before);
  });

  it("blocks bot deletion until every managed skill and its tracked workspace files are removed", async () => {
    const botId = "00000000-0000-0000-0000-000000000001";
    await db.updateTable("bots").set({ enabled: false, is_system: false, updated_at: new Date() }).where("id", "=", botId).execute();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("owner-delete-bot-with-skill"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "delete-bot-skill-csrf",
      last_seen_at: new Date(), expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const pkg = await insertSkillPackage("runtime", "delete-bot-guard");
    await db.insertInto("bot_skill_bindings").values({
      bot_id: botId, chat_context_id: null, package_id: pkg.id, namespace: pkg.namespace, slug: pkg.slug,
      created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).execute();

    const response = await app.inject({
      method: "DELETE", url: `/v1/admin/bots/${botId}`,
      headers: { cookie: "lark_agent_admin_session=owner-delete-bot-with-skill", "x-csrf-token": "delete-bot-skill-csrf" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("bot_has_skills");
    expect((await db.selectFrom("bots").select("deleted_at").where("id", "=", botId).executeTakeFirstOrThrow()).deleted_at).toBeNull();
  });

  it("checks existing bot permissions and blocks enabling until every capability is granted", async () => {
    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("owner-check-bot-permissions"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "permission-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const botId = "00000000-0000-0000-0000-000000000001";
    const headers = { cookie: "lark_agent_admin_session=owner-check-bot-permissions", "x-csrf-token": "permission-csrf" };
    grantedBotScopes = grantedBotScopes.filter((scope) => scope !== "im:message.group_bot_msg:readonly");

    const checked = await app.inject({ method: "POST", url: `/v1/admin/bots/${botId}/permission-check`, headers });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({ permissionState: "missing", permissionCheck: { ok: false, missingScopes: ["im:message.group_bot_msg:readonly"] } });

    await db.updateTable("bots").set({ enabled: false, is_system: false }).where("id", "=", botId).execute();
    const blocked = await app.inject({ method: "POST", url: `/v1/admin/bots/${botId}/commands`, headers, payload: { command: "enable" } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe("bot_permissions_missing");
    expect((await db.selectFrom("bots").select("enabled").where("id", "=", botId).executeTakeFirstOrThrow()).enabled).toBe(false);

    grantedBotScopes.push("im:message.group_bot_msg:readonly");
    expect((await app.inject({ method: "POST", url: `/v1/admin/bots/${botId}/permission-check`, headers })).json()).toMatchObject({ permissionState: "valid" });
    expect((await app.inject({ method: "POST", url: `/v1/admin/bots/${botId}/commands`, headers, payload: { command: "enable" } })).statusCode).toBe(200);
  });

  it("reports device status and lets the bound credential unregister itself", async () => {
    await insertWorker();
    const deviceToken = "device-token-self-unregister";
    await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256(deviceToken), last_used_at: null, revoked_at: null
    }).execute();
    const context = await insertSkillContext("oc_runner_status", "worker-a");
    const syncJob = await db.insertInto("skill_file_sync_jobs").values({
      chat_context_id: context.id, executor_id: "worker-a", desired_fingerprint: "d".repeat(64), leased_fingerprint: "d".repeat(64),
      payload: JSON.stringify({}), leased_payload: JSON.stringify({}), state: "running", lease_token_hash: sha256("runner-status-sync-lease"),
      lease_expires_at: new Date(Date.now() + 60_000), attempt: 1, last_error: null, completed_at: null, updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();

    const status = await app.inject({ method: "GET", url: "/v1/runner/status/worker-a", headers: { authorization: `Bearer ${deviceToken}` } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      executorId: "worker-a", activeTasks: 0, activeRuntimeSyncJobs: 1,
      workspaceAliases: ["repo"], workspaceAliasesText: "repo"
    });

    const busyUnregister = await app.inject({ method: "DELETE", url: "/v1/runner/credentials/current", headers: { authorization: `Bearer ${deviceToken}` } });
    expect(busyUnregister.statusCode).toBe(409);
    expect(busyUnregister.json<{ error: { code: string } }>().error.code).toBe("worker_has_active_runtime_sync");
    await db.updateTable("skill_file_sync_jobs").set({ lease_expires_at: new Date(Date.now() - 1_000), updated_at: new Date() })
      .where("id", "=", syncJob.id).execute();
    expect((await app.inject({ method: "GET", url: "/v1/runner/status/worker-a", headers: { authorization: `Bearer ${deviceToken}` } })).json())
      .toMatchObject({ activeRuntimeSyncJobs: 0 });

    const unregister = await app.inject({ method: "DELETE", url: "/v1/runner/credentials/current", headers: { authorization: `Bearer ${deviceToken}` } });
    expect(unregister.statusCode).toBe(204);
    const worker = await db.selectFrom("workers").select(["status", "operational_mode"]).where("executor_id", "=", "worker-a").executeTakeFirstOrThrow();
    expect(worker).toEqual({ status: "offline", operational_mode: "disabled" });
    expect((await db.selectFrom("worker_device_credentials").select("revoked_at").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
    expect((await app.inject({ method: "DELETE", url: "/v1/runner/credentials/current", headers: { authorization: `Bearer ${deviceToken}` } })).statusCode).toBe(401);
  });

  it("reports active Thread snapshots and refuses upgrade drain until their lease expires", async () => {
    await insertWorker();
    const deviceToken = "device-token-thread-snapshot-drain";
    await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256(deviceToken), last_used_at: null, revoked_at: null
    }).execute();
    const context = await insertSkillContext("oc_thread_snapshot_drain", "worker-a");
    const snapshot = await db.insertInto("chat_thread_snapshot_jobs").values({
      chat_context_id: context.id, executor_id: "worker-a", codex_thread_id: "thread-snapshot-drain",
      requested_by: "ou_owner", state: "running", lease_token_hash: sha256("thread-snapshot-drain-lease"),
      lease_expires_at: new Date(Date.now() + 60_000), attempt: 1, updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();
    const authorization = { authorization: `Bearer ${deviceToken}` };

    expect((await app.inject({ method: "GET", url: "/v1/runner/status/worker-a", headers: authorization })).json())
      .toMatchObject({ activeThreadSnapshotJobs: 1 });
    const blocked = await app.inject({ method: "POST", url: "/v1/runner/upgrade-drain/worker-a", headers: authorization });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe("worker_has_active_thread_snapshot");
    expect((await db.selectFrom("workers").select("operational_mode").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).operational_mode)
      .toBe("enabled");

    await db.updateTable("chat_thread_snapshot_jobs").set({ lease_expires_at: new Date(Date.now() - 1_000), updated_at: new Date() })
      .where("id", "=", snapshot.id).execute();
    expect((await app.inject({ method: "GET", url: "/v1/runner/status/worker-a", headers: authorization })).json())
      .toMatchObject({ activeThreadSnapshotJobs: 0 });
  });

  it("drains an idle executor atomically for upgrade and restores its previous mode", async () => {
    await insertWorker();
    const deviceToken = "device-token-upgrade-drain";
    const credential = await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256(deviceToken), last_used_at: null, revoked_at: null
    }).returning("id").executeTakeFirstOrThrow();
    await db.updateTable("workers").set({
      capabilities: JSON.stringify(["codex", "chat_context_v1", "thread_snapshot_v1"]), updated_at: new Date()
    }).where("executor_id", "=", "worker-a").execute();
    const snapshotContext = await insertSkillContext("oc_upgrade_drain_snapshot", "worker-a");
    await db.updateTable("chat_contexts").set({
      codex_thread_id: "thread-upgrade-drain", state: "ready", updated_at: new Date()
    }).where("id", "=", snapshotContext.id).execute();
    await db.insertInto("chat_thread_snapshot_jobs").values({
      chat_context_id: snapshotContext.id, executor_id: "worker-a", codex_thread_id: "thread-upgrade-drain",
      requested_by: "ou_owner", state: "queued", updated_at: new Date()
    }).execute();
    const workerSession = await issueWorkerSession(config, {
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent",
      configFingerprint: "a".repeat(64), workspaceMappingFingerprint: null, credentialId: credential.id
    });
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const routed = await new MessageRouter(db).route(bot, {
      eventId: "ev_upgrade_drain", eventType: "im.message.receive_v1", messageId: "om_upgrade_drain",
      chatId: "oc_upgrade_drain", chatType: "p2p", rootMessageId: "om_upgrade_drain",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_upgrade_drain", botDialogueDepth: 0,
      messageType: "text", content: "upgrade", explicitlyActivated: true
    });
    const authorization = { authorization: `Bearer ${deviceToken}` };
    const drained = await app.inject({ method: "POST", url: "/v1/runner/upgrade-drain/worker-a", headers: authorization });
    expect(drained.statusCode).toBe(200);
    const drainToken = drained.json<{ drainToken: string }>().drainToken;
    expect(drained.json()).toMatchObject({ operationalMode: "maintenance", previousOperationalMode: "enabled" });
    expect((await app.inject({
      method: "GET", url: "/v1/runner/status/worker-a",
      headers: { ...authorization, "x-upgrade-drain-token": drainToken }
    })).json()).toMatchObject({ upgradeDraining: true, upgradeDrainOwned: true });
    expect((await db.selectFrom("workers").select("operational_mode").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).operational_mode).toBe("maintenance");
    expect((await app.inject({
      method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim",
      headers: { authorization: `Bearer ${workerSession.token}` }
    })).statusCode).toBe(204);
    await expect(new ControlPlaneRepository(db, 60).claimTask({
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64)
    })).resolves.toBeNull();
    expect((await app.inject({
      method: "DELETE", url: "/v1/runner/upgrade-drain/worker-a",
      headers: { ...authorization, "x-upgrade-drain-token": "wrong-token" }
    })).statusCode).toBe(409);
    const released = await app.inject({
      method: "DELETE", url: "/v1/runner/upgrade-drain/worker-a",
      headers: { ...authorization, "x-upgrade-drain-token": drainToken }
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ operationalMode: "enabled" });
    expect((await new ControlPlaneRepository(db, 60).claimTask({
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64)
    }))?.task.id).toBe(routed.taskId);
  });

  it("lets an emergency credential revoke invalidate an in-flight upgrade drain", async () => {
    await insertWorker();
    const deviceToken = "device-token-emergency-revoke";
    await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256(deviceToken), last_used_at: null, revoked_at: null
    }).execute();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("owner-emergency-revoke"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "emergency-csrf",
      last_seen_at: new Date(), expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const authorization = { authorization: `Bearer ${deviceToken}` };
    const drained = await app.inject({ method: "POST", url: "/v1/runner/upgrade-drain/worker-a", headers: authorization });
    expect(drained.statusCode).toBe(200);
    const drainToken = drained.json<{ drainToken: string }>().drainToken;

    const revoked = await app.inject({
      method: "POST", url: "/v1/admin/workers/worker-a/commands",
      headers: { cookie: "lark_agent_admin_session=owner-emergency-revoke", "x-csrf-token": "emergency-csrf" },
      payload: { command: "revoke_credentials" }
    });
    expect(revoked.statusCode).toBe(200);
    expect(await db.selectFrom("workers")
      .select(["status", "operational_mode", "upgrade_drain_token_hash", "upgrade_drain_previous_mode"])
      .where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).toEqual({
      status: "offline", operational_mode: "disabled", upgrade_drain_token_hash: null, upgrade_drain_previous_mode: null
    });
    expect((await app.inject({
      method: "DELETE", url: "/v1/runner/upgrade-drain/worker-a",
      headers: { ...authorization, "x-upgrade-drain-token": drainToken }
    })).statusCode).toBe(401);
  });

  it("validates user-skill inventory fingerprints before persisting a worker report", async () => {
    await insertWorker();
    const credential = await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256("inventory-device-token"), last_used_at: null, revoked_at: null
    }).returning("id").executeTakeFirstOrThrow();
    const session = await issueWorkerSession(config, {
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent",
      configFingerprint: "a".repeat(64), credentialId: credential.id
    });
    const payload = {
      skills: [], fingerprint: workerUserSkillsFingerprint([]), scannedAt: new Date().toISOString(),
      status: "ready", truncated: false, total: 0, errors: []
    };
    const headers = { authorization: `Bearer ${session.token}` };

    const invalid = await app.inject({ method: "PUT", url: "/v1/workers/user-skills", headers, payload: { ...payload, fingerprint: "f".repeat(64) } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("user_skills_fingerprint_mismatch");
    expect((await db.selectFrom("workers").select("user_skills_fingerprint").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).user_skills_fingerprint).toBeNull();

    expect((await app.inject({ method: "PUT", url: "/v1/workers/user-skills", headers, payload })).statusCode).toBe(200);
    expect((await db.selectFrom("workers").select(["user_skills_fingerprint", "user_skills_scan_status"]).where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()))
      .toEqual({ user_skills_fingerprint: payload.fingerprint, user_skills_scan_status: "ready" });

    await db.updateTable("workers").set({ config_fingerprint: "b".repeat(64), updated_at: new Date() }).where("executor_id", "=", "worker-a").execute();
    const staleConfig = await app.inject({ method: "PUT", url: "/v1/workers/user-skills", headers, payload });
    expect(staleConfig.statusCode).toBe(409);
    expect(staleConfig.json<{ error: { code: string } }>().error.code).toBe("stale_worker_session");

    await db.updateTable("workers").set({ config_fingerprint: "a".repeat(64), workspace_mapping_fingerprint: workspaceMappingFingerprint, updated_at: new Date() }).where("executor_id", "=", "worker-a").execute();
    const mappingSession = await issueWorkerSession(config, {
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64),
      workspaceMappingFingerprint, credentialId: credential.id
    });
    await db.updateTable("workers").set({ workspace_mapping_fingerprint: "d".repeat(64), updated_at: new Date() }).where("executor_id", "=", "worker-a").execute();
    const staleMapping = await app.inject({ method: "PUT", url: "/v1/workers/user-skills", headers: { authorization: `Bearer ${mappingSession.token}` }, payload });
    expect(staleMapping.statusCode).toBe(409);
    expect(staleMapping.json<{ error: { code: string } }>().error.code).toBe("stale_worker_session");
  });

  it("refuses device self-unregister for every executor-occupying task state", async () => {
    await insertWorker();
    const deviceToken = "device-token-active-task";
    await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256(deviceToken), last_used_at: null, revoked_at: null
    }).execute();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_unregister", chat_type: "group", root_message_id: "om_unregister", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_unregister", state: "running", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo", preferred_executor_id: "worker-a", executor_id: "worker-a", codex_thread_id: null,
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test",
      lease_token_hash: sha256("lease"), lease_expires_at: new Date(Date.now() + 60_000), summary: null, completed_at: null, updated_at: new Date()
    }).execute();

    for (const state of ["running", "waiting_approval", "held_draft", "human_owned"] as const) {
      await db.updateTable("tasks").set({ state, updated_at: new Date() }).where("executor_id", "=", "worker-a").execute();
      const status = await app.inject({ method: "GET", url: "/v1/runner/status/worker-a", headers: { authorization: `Bearer ${deviceToken}` } });
      expect(status.json()).toMatchObject({ activeTasks: 1 });
      const response = await app.inject({ method: "DELETE", url: "/v1/runner/credentials/current", headers: { authorization: `Bearer ${deviceToken}` } });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("worker_has_active_tasks");
      const drain = await app.inject({ method: "POST", url: "/v1/runner/upgrade-drain/worker-a", headers: { authorization: `Bearer ${deviceToken}` } });
      expect(drain.statusCode).toBe(409);
      expect((await db.selectFrom("workers").select("operational_mode").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).operational_mode).toBe("enabled");
    }
    expect((await db.selectFrom("worker_device_credentials").select("revoked_at").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).revoked_at).toBeNull();
  });

  it("only deletes disabled workers without unfinished tasks and preserves task history", async () => {
    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("owner-delete-worker"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "delete-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    await insertWorker();
    await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256("delete-device-token"), last_used_at: null, revoked_at: null
    }).execute();
    const headers = { cookie: "lark_agent_admin_session=owner-delete-worker", "x-csrf-token": "delete-csrf" };

    const enabled = await app.inject({ method: "DELETE", url: "/v1/admin/workers/worker-a", headers });
    expect(enabled.statusCode).toBe(409);
    expect(enabled.json<{ error: { code: string } }>().error.code).toBe("worker_not_disabled");

    await db.updateTable("workers").set({ operational_mode: "disabled" }).where("executor_id", "=", "worker-a").execute();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_delete", chat_type: "group", root_message_id: "om_delete", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: now
    }).returning("id").executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_delete", state: "waiting_input", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo", preferred_executor_id: "worker-a", executor_id: "worker-a", codex_thread_id: "thread-delete",
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test",
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: now
    }).returning("id").executeTakeFirstOrThrow();

    const active = await app.inject({ method: "DELETE", url: "/v1/admin/workers/worker-a", headers });
    expect(active.statusCode).toBe(409);
    expect(active.json<{ error: { code: string } }>().error.code).toBe("worker_has_active_tasks");

    await db.updateTable("tasks").set({ state: "completed", completed_at: now }).where("id", "=", task.id).execute();
    const context = await insertSkillContext("oc_delete_sync", "worker-a");
    const syncJob = await db.insertInto("skill_file_sync_jobs").values({
      chat_context_id: context.id, executor_id: "worker-a", desired_fingerprint: "e".repeat(64),
      payload: JSON.stringify({}), state: "queued", updated_at: now
    }).returning("id").executeTakeFirstOrThrow();
    const syncing = await app.inject({ method: "DELETE", url: "/v1/admin/workers/worker-a", headers });
    expect(syncing.statusCode).toBe(409);
    expect(syncing.json<{ error: { code: string } }>().error.code).toBe("worker_has_active_runtime_sync");
    await db.updateTable("skill_file_sync_jobs").set({ state: "completed", completed_at: now, updated_at: now }).where("id", "=", syncJob.id).execute();
    const removed = await app.inject({ method: "DELETE", url: "/v1/admin/workers/worker-a", headers });
    expect(removed.statusCode).toBe(200);
    expect((await db.selectFrom("workers").select("deleted_at").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).deleted_at).not.toBeNull();
    expect((await db.selectFrom("worker_device_credentials").select("revoked_at").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
    expect((await db.selectFrom("tasks").select("executor_id").where("id", "=", task.id).executeTakeFirstOrThrow()).executor_id).toBe("worker-a");
    expect((await app.inject({ method: "GET", url: "/v1/admin/workers", headers })).json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it("baselines workspace mappings once, preserves them for old Runners, and blocks later mapping changes", async () => {
    const now = new Date();
    await insertWorker();
    const context = await insertSkillContext("oc_workspace_mapping_upgrade", "worker-a");
    await db.updateTable("chat_contexts").set({ codex_thread_id: "thread-workspace-mapping", state: "ready", updated_at: now }).where("id", "=", context.id).execute();
    const conversation = await db.insertInto("conversations").values({
      bot_id: context.bot_id, chat_context_id: context.id, bot_config_revision: 1, role_instructions_snapshot: "test",
      attention_model_snapshot: null, attention_reasoning_effort_snapshot: null, execution_model_snapshot: null, execution_reasoning_effort_snapshot: null,
      chat_id: context.chat_id, chat_type: "p2p", root_message_id: "om_workspace_mapping", thread_id: null, room_seq: 1,
      active: true, response_message_id: null, followup_expires_at: null, updated_at: now
    }).returning("id").executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      bot_id: context.bot_id, conversation_id: conversation.id, state: "waiting_worker", trigger_message_id: "om_workspace_mapping",
      requester_id: "ou_owner", requester_role: "owner", authorization_grant: JSON.stringify({ read: true }),
      requested_workspace_alias: "repo", resolved_workspace_alias: "repo", preferred_executor_id: "worker-a", executor_id: "worker-a",
      codex_thread_id: "thread-workspace-mapping", executor_home_ref: "worker-a:home", executor_profile: "lark-agent",
      executor_config_fingerprint: "a".repeat(64), codex_version: "test", lease_token_hash: null, lease_expires_at: null,
      summary: null, completed_at: null, updated_at: now
    }).returning("id").executeTakeFirstOrThrow();
    const repository = new ControlPlaneRepository(db, 60);
    const registration = {
      executorId: "worker-a", displayName: "Worker A", homeRef: "worker-a:home", codexProfile: "lark-agent",
      configFingerprint: "a".repeat(64), workspaceMappingFingerprint, codexVersion: "test", capacity: 1,
      workspaceAliases: ["repo"], capabilities: ["codex", "chat_context_v1", "workspace_mapping_v1"]
    };

    await repository.upsertWorker(registration);
    expect((await db.selectFrom("workers").select("workspace_mapping_fingerprint").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).workspace_mapping_fingerprint)
      .toBe(workspaceMappingFingerprint);
    expect((await db.selectFrom("chat_contexts").select(["executor_workspace_mapping_fingerprint", "state"]).where("id", "=", context.id).executeTakeFirstOrThrow()))
      .toEqual({ executor_workspace_mapping_fingerprint: workspaceMappingFingerprint, state: "ready" });
    expect((await db.selectFrom("tasks").select(["executor_workspace_mapping_fingerprint", "state"]).where("id", "=", task.id).executeTakeFirstOrThrow()))
      .toEqual({ executor_workspace_mapping_fingerprint: workspaceMappingFingerprint, state: "waiting_worker" });

    const { workspaceMappingFingerprint: _omittedForLegacyRunner, ...legacyRegistration } = registration;
    await repository.upsertWorker({ ...legacyRegistration, codexVersion: "old-runner-rollback", capabilities: ["codex", "chat_context_v1"] });
    expect((await db.selectFrom("workers").select("workspace_mapping_fingerprint").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).workspace_mapping_fingerprint)
      .toBe(workspaceMappingFingerprint);

    const changedMapping = "d".repeat(64);
    await repository.upsertWorker({ ...registration, workspaceMappingFingerprint: changedMapping });
    expect(await db.selectFrom("chat_contexts").select(["executor_workspace_mapping_fingerprint", "state"]).where("id", "=", context.id).executeTakeFirstOrThrow())
      .toEqual({ executor_workspace_mapping_fingerprint: workspaceMappingFingerprint, state: "blocked" });
    expect(await db.selectFrom("tasks").select(["executor_workspace_mapping_fingerprint", "state"]).where("id", "=", task.id).executeTakeFirstOrThrow())
      .toEqual({ executor_workspace_mapping_fingerprint: workspaceMappingFingerprint, state: "waiting_input" });

    await db.updateTable("chat_contexts").set({ state: "ready", blocked_reason: null, updated_at: new Date() }).where("id", "=", context.id).execute();
    await db.updateTable("tasks").set({ state: "queued", summary: null, updated_at: new Date() }).where("id", "=", task.id).execute();
    const currentPrincipal = { executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64), workspaceMappingFingerprint: changedMapping };
    await expect(repository.claimTask(currentPrincipal)).resolves.toBeNull();
    const syncJob = await db.insertInto("skill_file_sync_jobs").values({
      chat_context_id: context.id, executor_id: "worker-a", desired_fingerprint: "e".repeat(64),
      payload: JSON.stringify({ botAppId: "cli_bot", resolvedWorkspaceAlias: "repo", skills: [], skillSetFingerprint: "1".repeat(64), runtimeConfig: { fingerprint: "2".repeat(64), files: [] } }),
      state: "queued", updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();
    await expect(new SkillRuntimeService(db, config, services.adminEvents).claimSyncJob(currentPrincipal, 60)).resolves.toBeNull();
    expect((await db.selectFrom("skill_file_sync_jobs").select("state").where("id", "=", syncJob.id).executeTakeFirstOrThrow()).state).toBe("queued");
  });

  it("saves, validates and clears a worker alias without changing its stable execution identity", async () => {
    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("owner-worker-alias"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "worker-alias-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    await insertWorker();
    const headers = { cookie: "lark_agent_admin_session=owner-worker-alias", "x-csrf-token": "worker-alias-csrf" };
    const before = await db.selectFrom("workers").select(["executor_id", "home_ref", "codex_profile", "config_fingerprint", "operational_mode", "status"]).where("executor_id", "=", "worker-a").executeTakeFirstOrThrow();

    expect((await app.inject({ method: "PATCH", url: "/v1/admin/workers/worker-a/display-alias", payload: { displayAlias: "阿朱本机" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "PATCH", url: "/v1/admin/workers/worker-a/display-alias", headers: { cookie: headers.cookie }, payload: { displayAlias: "阿朱本机" } })).statusCode).toBe(403);
    for (const displayAlias of ["   ", "a".repeat(65), "阿朱\n本机"]) {
      expect((await app.inject({ method: "PATCH", url: "/v1/admin/workers/worker-a/display-alias", headers, payload: { displayAlias } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "PATCH", url: "/v1/admin/workers/missing/display-alias", headers, payload: { displayAlias: "不存在" } })).statusCode).toBe(404);

    const saved = await app.inject({ method: "PATCH", url: "/v1/admin/workers/worker-a/display-alias", headers, payload: { displayAlias: "  阿朱本机  " } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ok: true, displayAlias: "阿朱本机", reportedDisplayName: "Worker A", displayName: "阿朱本机" });
    expect(await db.selectFrom("workers").select(["executor_id", "home_ref", "codex_profile", "config_fingerprint", "operational_mode", "status"]).where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).toEqual(before);
    expect((await app.inject({ method: "GET", url: "/v1/admin/workers", headers })).json<{ items: Array<Record<string, unknown>> }>().items[0]).toMatchObject({
      executor_id: "worker-a", display_name: "阿朱本机", display_alias: "阿朱本机", reported_display_name: "Worker A"
    });

    await new ControlPlaneRepository(db, 60).upsertWorker({
      executorId: "worker-a", displayName: "新设备名称", homeRef: "worker-a:home", codexProfile: "lark-agent",
      configFingerprint: "a".repeat(64), codexVersion: "test-upgraded", capacity: 1,
      workspaceAliases: ["repo"], capabilities: ["codex", "chat_context_v1"], runnerVersion: "0.3.1", architecture: "arm64", registrationSource: "quick_install"
    });
    expect(await db.selectFrom("workers").select(["display_name", "display_alias", "codex_version"]).where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).toEqual({
      display_name: "新设备名称", display_alias: "阿朱本机", codex_version: "test-upgraded"
    });

    const enrollmentToken = "worker-alias-reregister-token-0123456789";
    await db.insertInto("worker_enrollment_tokens").values({
      token_hash: sha256(enrollmentToken), expires_at: new Date(Date.now() + 60_000), used_at: null, revoked_at: null, executor_id: null
    }).execute();
    const reenrolled = await app.inject({
      method: "POST", url: "/v1/runner/enroll", payload: {
        token: enrollmentToken,
        registration: {
          executorId: "worker-a", displayName: "重新注册设备", homeRef: "worker-a:home", codexProfile: "lark-agent",
          configFingerprint: "a".repeat(64), codexVersion: "test-reregistered", capacity: 1,
          workspaceAliases: ["repo"], capabilities: ["codex", "chat_context_v1"], runnerVersion: "0.3.1", architecture: "arm64", registrationSource: "quick_install"
        }
      }
    });
    expect(reenrolled.statusCode).toBe(200);
    expect(await db.selectFrom("workers").select(["display_name", "display_alias"]).where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).toEqual({
      display_name: "重新注册设备", display_alias: "阿朱本机"
    });

    const cleared = await app.inject({ method: "PATCH", url: "/v1/admin/workers/worker-a/display-alias", headers, payload: { displayAlias: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ displayAlias: null, reportedDisplayName: "重新注册设备", displayName: "重新注册设备" });
  });

  it("binds a claimed task to the registered home/profile/fingerprint and holds a stale draft", async () => {
    const staticSession = await app.inject({
      method: "POST", url: "/v1/worker-sessions", headers: { authorization: "Bearer legacy-static-token" },
      payload: {
        executorId: "worker-a", displayName: "Worker A", homeRef: "worker-a:home", codexProfile: "lark-agent",
        configFingerprint: "a".repeat(64), codexVersion: "codex-cli test", capacity: 1,
        workspaceAliases: ["repo"], capabilities: ["codex", "chat_context_v1"], runnerVersion: "0.1.1", architecture: "arm64", registrationSource: "quick_install"
      }
    });
    expect(staticSession.statusCode).toBe(401);
    const enrollmentToken = "enrollment-token-0123456789-abcdef";
    await db.insertInto("worker_enrollment_tokens").values({
      token_hash: sha256(enrollmentToken), expires_at: new Date(Date.now() + 60_000), used_at: null, revoked_at: null, executor_id: null
    }).execute();
    const enrollResponse = await app.inject({
      method: "POST",
      url: "/v1/runner/enroll",
      payload: {
        token: enrollmentToken,
        registration: {
          executorId: "worker-a", displayName: "Worker A", homeRef: "worker-a:home", codexProfile: "lark-agent",
          configFingerprint: "a".repeat(64), codexVersion: "codex-cli test", capacity: 1,
          workspaceAliases: ["repo"], capabilities: ["codex", "chat_context_v1"], runnerVersion: "0.1.0", architecture: "arm64", registrationSource: "quick_install"
        }
      }
    });
    expect(enrollResponse.statusCode).toBe(200);
    const deviceToken = enrollResponse.json<{ deviceToken: string }>().deviceToken;
    const duplicateEnrollment = await app.inject({
      method: "POST", url: "/v1/runner/enroll", payload: {
        token: enrollmentToken,
        registration: {
          executorId: "worker-a", displayName: "Worker A", homeRef: "worker-a:home", codexProfile: "lark-agent",
          configFingerprint: "a".repeat(64), codexVersion: "codex-cli test", capacity: 1,
          workspaceAliases: ["repo"], capabilities: ["codex", "chat_context_v1"], runnerVersion: "0.1.0", architecture: "arm64", registrationSource: "quick_install"
        }
      }
    });
    expect(duplicateEnrollment.statusCode).toBe(401);
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/worker-sessions",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        executorId: "worker-a",
        displayName: "Worker A",
        homeRef: "worker-a:home",
        codexProfile: "lark-agent",
        configFingerprint: "a".repeat(64),
        codexVersion: "codex-cli test",
        capacity: 1,
        workspaceAliases: ["repo"],
        capabilities: ["codex", "chat_context_v1"],
        runnerVersion: "0.1.0",
        architecture: "arm64",
        registrationSource: "quick_install"
      }
    });
    expect(sessionResponse.statusCode).toBe(200);
    const sessionToken = sessionResponse.json<{ sessionToken: string }>().sessionToken;
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_test",
      chat_type: "group",
      root_message_id: "om_root",
      thread_id: "omt_thread",
      room_seq: 2,
      active: true,
      response_message_id: null,
      updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id,
      trigger_message_id: "om_root",
      state: "queued",
      requester_id: "ou_owner",
      requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: true, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo",
      preferred_executor_id: null,
      executor_id: null,
      codex_thread_id: null,
      executor_home_ref: null,
      executor_profile: null,
      executor_config_fingerprint: null,
      codex_version: null,
      lease_token_hash: null,
      lease_expires_at: null,
      summary: null,
      completed_at: null,
      updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("processed_events").values({ event_id: "ev_1", event_type: "message", status: "processed", processed_at: new Date() }).execute();
    await db.insertInto("signals").values({
      conversation_id: conversation.id,
      task_id: task.id,
      event_id: "ev_1",
      seq: 2,
      message_id: "om_root",
      origin_message_id: "om_root",
      sender_id: "ou_owner",
      sender_role: "owner",
      message_type: "text",
      content: "implement",
      preview: "implement",
      attachments: JSON.stringify([{
        id: "11111111-1111-4111-8111-111111111111",
        type: "file",
        fileName: "proof.txt",
        resourceKey: "file_internal_secret"
      }]),
      priority: 90,
      decision: "pending",
      decision_rationale: null,
      decided_at: null
    }).execute();

    const claimResponse = await app.inject({ method: "POST", url: "/v1/tasks/claim", headers: { authorization: `Bearer ${sessionToken}` } });
    expect(claimResponse.statusCode).toBe(200);
    const claim = claimResponse.json<{ id: string; botAppId: string; leaseToken: string; chatType: string; turnIndex: number; triggerMessageId: string; attentionContext: string; requestedWorkspaceAlias: string | null; resolvedWorkspaceAlias: string; signals: Array<{ id: string; attachments: Array<{ id: string; type: string; fileName: string }> }> }>();
    expect(claim.id).toBe(task.id);
    expect(claim).toMatchObject({ botAppId: "cli_bot", chatType: "group", turnIndex: 1, triggerMessageId: "om_root", requestedWorkspaceAlias: "repo", resolvedWorkspaceAlias: "repo" });
    expect(claim.attentionContext).toContain("首次激活回合");
    expect(claim.signals[0]?.attachments).toEqual([{ id: "11111111-1111-4111-8111-111111111111", type: "file", fileName: "proof.txt" }]);
    expect(claimResponse.body).not.toContain("file_internal_secret");
    const claimedRow = await db.selectFrom("tasks").selectAll().where("id", "=", task.id).executeTakeFirstOrThrow();
    expect(claimedRow.executor_home_ref).toBe("worker-a:home");
    expect(claimedRow.executor_profile).toBe("lark-agent");
    expect(claimedRow.executor_config_fingerprint).toBe("a".repeat(64));
    expect(claimedRow.resolved_workspace_alias).toBe("repo");

    let attachmentTemp = "";
    const attachmentGateway = new (await import("../lark/gateway.js")).LarkGateway("lark-cli", async () => ({}), null, async (_command, args, _env, options) => {
      attachmentTemp = options?.cwd ?? "";
      const output = args[args.indexOf("--output") + 1] ?? "";
      await writeFile(join(attachmentTemp, output), "attachment proof");
      return { stdout: "{}", stderr: "", exitCode: 0 };
    });
    const attachmentControl = buildControlPlane(db, config, { lark: attachmentGateway }).app;
    const attachmentHeaders = { authorization: `Bearer ${sessionToken}`, "x-lease-token": claim.leaseToken };
    const downloaded = await attachmentControl.inject({
      method: "GET",
      url: `/v1/tasks/${task.id}/signals/${claim.signals[0]?.id}/attachments/11111111-1111-4111-8111-111111111111`,
      headers: attachmentHeaders
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe("attachment proof");
    expect(downloaded.headers["content-disposition"]).toContain("proof.txt");
    const wrongSignal = await attachmentControl.inject({ method: "GET", url: `/v1/tasks/${task.id}/signals/22222222-2222-4222-8222-222222222222/attachments/11111111-1111-4111-8111-111111111111`, headers: attachmentHeaders });
    expect(wrongSignal.statusCode).toBe(404);
    const crossTask = await attachmentControl.inject({ method: "GET", url: `/v1/tasks/33333333-3333-4333-8333-333333333333/signals/${claim.signals[0]?.id}/attachments/11111111-1111-4111-8111-111111111111`, headers: attachmentHeaders });
    expect(crossTask.statusCode).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(stat(attachmentTemp)).rejects.toThrow();
    await attachmentControl.close();

    const draftResponse = await app.inject({
      method: "POST",
      url: `/v1/tasks/${task.id}/drafts`,
      headers: { authorization: `Bearer ${sessionToken}`, "x-lease-token": claim.leaseToken },
      payload: { content: "stale answer", baseRoomSeq: 1, force: false }
    });
    expect(draftResponse.statusCode).toBe(200);
    expect(draftResponse.json<{ held: boolean }>().held).toBe(true);
    const draft = await db.selectFrom("drafts").selectAll().where("task_id", "=", task.id).executeTakeFirstOrThrow();
    expect(draft.state).toBe("held");
    expect(draft.observed_room_seq).toBe(2);

    const replacementResponse = await app.inject({
      method: "POST",
      url: `/v1/tasks/${task.id}/drafts`,
      headers: { authorization: `Bearer ${sessionToken}`, "x-lease-token": claim.leaseToken },
      payload: { content: "fresh answer", baseRoomSeq: 2, force: false }
    });
    expect(replacementResponse.statusCode).toBe(200);
    expect(replacementResponse.json<{ held: boolean; simulated: boolean }>()).toMatchObject({ held: false, simulated: true });
    const replacementDrafts = await db.selectFrom("drafts").select(["content", "state"]).where("task_id", "=", task.id).orderBy("created_at").execute();
    expect(replacementDrafts).toEqual([
      { content: "stale answer", state: "discarded" },
      { content: "fresh answer", state: "approved" }
    ]);

    await db.updateTable("worker_device_credentials").set({ revoked_at: new Date() }).where("executor_id", "=", "worker-a").execute();
    const revokedSession = await app.inject({ method: "POST", url: "/v1/tasks/claim", headers: { authorization: `Bearer ${sessionToken}` } });
    expect(revokedSession.statusCode).toBe(401);
  });

  it("persists the single executor workspace as the effective task workspace", async () => {
    await insertWorker();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_auto_workspace", chat_type: "group", root_message_id: "om_auto", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_auto", state: "queued", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, preferred_executor_id: null, executor_id: null, codex_thread_id: null,
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();

    const claim = await new ControlPlaneRepository(db, 60).claimTask({
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64)
    });

    expect(claim?.task.id).toBe(task.id);
    expect(claim?.task.requested_workspace_alias).toBeNull();
    expect(claim?.task.resolved_workspace_alias).toBe("repo");
  });

  it("does not let a multi-workspace executor claim a task without a workspace selection", async () => {
    await db.insertInto("workers").values({
      executor_id: "worker-a", display_name: "Worker A", home_ref: "worker-a:home", codex_profile: "lark-agent",
      config_fingerprint: "a".repeat(64), codex_version: "test", capacity: 1,
      workspace_aliases: JSON.stringify(["repo", "docs"]), capabilities: JSON.stringify(["codex", "chat_context_v1"]), last_seen_at: new Date(), updated_at: new Date()
    }).execute();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_ambiguous_workspace", chat_type: "group", root_message_id: "om_ambiguous", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_ambiguous", state: "queued", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, preferred_executor_id: null, executor_id: null, codex_thread_id: null,
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();

    const claim = await new ControlPlaneRepository(db, 60).claimTask({
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64)
    });

    expect(claim).toBeNull();
    expect(await db.selectFrom("tasks").select(["state", "resolved_workspace_alias"]).where("id", "=", task.id).executeTakeFirstOrThrow())
      .toEqual({ state: "queued", resolved_workspace_alias: null });
  });

  it("does not let multiple eligible executors race for an unbound task", async () => {
    await insertWorker();
    await db.insertInto("workers").values({
      executor_id: "worker-b", display_name: "Worker B", home_ref: "worker-b:home", codex_profile: "lark-agent",
      config_fingerprint: "b".repeat(64), codex_version: "test", capacity: 1,
      workspace_aliases: JSON.stringify(["repo"]), capabilities: JSON.stringify(["codex", "chat_context_v1"]), last_seen_at: new Date(), updated_at: new Date()
    }).execute();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_ambiguous_executor", chat_type: "group", root_message_id: "om_ambiguous_executor", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_ambiguous_executor", state: "queued", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo", preferred_executor_id: null, executor_id: null, codex_thread_id: null,
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();
    const repository = new ControlPlaneRepository(db, 60);

    await expect(repository.claimTask({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64) })).resolves.toBeNull();
    await expect(repository.claimTask({ executorId: "worker-b", homeRef: "worker-b:home", codexProfile: "lark-agent", configFingerprint: "b".repeat(64) })).resolves.toBeNull();
    expect((await db.selectFrom("tasks").select("state").where("id", "=", task.id).executeTakeFirstOrThrow()).state).toBe("queued");
  });

  it("pauses a task after three pre-thread lease expirations and creates an incident", async () => {
    await insertWorker();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_lease_loop", chat_type: "group", root_message_id: "om_lease_loop", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_lease_loop", state: "running", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo", resolved_workspace_alias: "repo", preferred_executor_id: "worker-a", executor_id: "worker-a", codex_thread_id: null,
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test",
      lease_token_hash: sha256("expired"), lease_expires_at: new Date(Date.now() - 1_000), attempt: 3, summary: null, completed_at: null, updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();
    const repository = new ControlPlaneRepository(db, 60);

    await expect(repository.recoverExpiredLeases()).resolves.toBe(1);
    expect(await db.selectFrom("tasks").select(["state", "lease_token_hash", "lease_expires_at"]).where("id", "=", task.id).executeTakeFirstOrThrow())
      .toEqual({ state: "waiting_input", lease_token_hash: null, lease_expires_at: null });
    expect((await db.selectFrom("task_events").select("event_type").where("task_id", "=", task.id).executeTakeFirstOrThrow()).event_type).toBe("task.lease_recovery_stopped");

    const incidents = new IncidentService(db, config, services.lark, services.runtime, services.adminEvents);
    await incidents.evaluate();
    expect(await db.selectFrom("incidents").select(["kind", "related_id"]).where("kind", "=", "lease_recovery_stopped").executeTakeFirstOrThrow())
      .toEqual({ kind: "lease_recovery_stopped", related_id: task.id });
  });

  it("keeps commentary and final answer in one CardKit message with monotonic sequence", async () => {
    const calls: Array<{ kind: string; sequence?: number; content?: string }> = [];
    const cardLark = {
      createCardEntity: async (content: string, streaming: boolean) => { calls.push({ kind: streaming ? "create_stream" : "create_final", content }); return "card_one"; },
      sendCardEntityToChat: async () => { calls.push({ kind: "send" }); return "om_one"; },
      streamCardContent: async (_cardId: string, _elementId: string, content: string, sequence: number) => { calls.push({ kind: "update", sequence, content }); },
      closeCardStream: async (_cardId: string, _summary: string, sequence: number) => { calls.push({ kind: "close", sequence }); },
      sendMarkdownToChat: async () => { throw new Error("markdown fallback must not be used"); }
    } as unknown as LarkGateway;
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_stream", chat_type: "p2p", root_message_id: "om_request", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_request", state: "running", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, preferred_executor_id: null, executor_id: null, codex_thread_id: null,
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const outputs = new TaskOutputService(db, { ...config, larkEnabled: true }, cardLark);

    await outputs.streamCommentary(task.id, { itemId: "comment_1", phase: "commentary", text: "正在查询…", ordinal: 1, baseRoomSeq: 1 });
    await outputs.streamCommentary(task.id, { itemId: "comment_1", phase: "commentary", text: "重复", ordinal: 1, baseRoomSeq: 1 });
    await outputs.streamCommentary(task.id, { itemId: "comment_2", phase: "commentary", text: "新的回合", ordinal: 1, baseRoomSeq: 1 });
    await expect(outputs.streamCommentary(task.id, {
      itemId: "misphased_final", phase: "commentary", text: '{"disposition":"awaiting_followup"', ordinal: 2, baseRoomSeq: 1
    })).resolves.toEqual({ messageId: "om_one", ignored: true });
    await outputs.streamCommentary(task.id, {
      itemId: "misphased_final", phase: "commentary",
      text: JSON.stringify({ disposition: "awaiting_followup", rationale: "等待后续输入", reply: "只展示 reply" }),
      ordinal: 3, baseRoomSeq: 1
    });
    const final = await outputs.finalize(task.id, "最终答案", "draft-key");

    expect(final).toEqual({ messageId: "om_one", transport: "cardkit" });
    expect(calls).toEqual([
      { kind: "create_stream", content: "正在查询…" }, { kind: "send" },
      { kind: "update", sequence: 1, content: "新的回合" },
      { kind: "update", sequence: 2, content: "只展示 reply" },
      { kind: "update", sequence: 3, content: "最终答案" }, { kind: "close", sequence: 4 }
    ]);
    const output = await db.selectFrom("task_outputs").selectAll().where("task_id", "=", task.id).executeTakeFirstOrThrow();
    expect(output).toMatchObject({ card_id: "card_one", message_id: "om_one", sequence: 4, state: "completed", visible_phase: "final", last_item_id: "misphased_final" });
    expect(await db.selectFrom("task_output_updates").selectAll().where("task_id", "=", task.id).execute()).toHaveLength(6);
  });

  it("anchors a group CardKit reply to the activating message without sending directly to the chat", async () => {
    const calls: Array<{ kind: string; target?: string }> = [];
    const cardLark = {
      createCardEntity: async () => "card_group",
      replyCardEntityToMessage: async (messageId: string) => { calls.push({ kind: "reply_card", target: messageId }); return "om_group_reply"; },
      sendCardEntityToChat: async (chatId: string) => { calls.push({ kind: "send_card", target: chatId }); return "om_unexpected"; },
      streamCardContent: async () => undefined,
      closeCardStream: async () => undefined,
      replyMarkdownToMessage: async (messageId: string) => { calls.push({ kind: "reply_markdown", target: messageId }); return "om_fallback"; },
      sendMarkdownToChat: async (chatId: string) => { calls.push({ kind: "send_markdown", target: chatId }); return "om_unexpected"; }
    } as unknown as LarkGateway;
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_group", chat_type: "group", root_message_id: "om_original_activation", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_activation", state: "running", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, preferred_executor_id: null, executor_id: null, codex_thread_id: null,
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const outputs = new TaskOutputService(db, { ...config, larkEnabled: true }, cardLark);

    const final = await outputs.finalize(task.id, "群聊最终答案", "group-fallback-key");

    expect(final).toEqual({ messageId: "om_group_reply", transport: "cardkit" });
    expect(calls).toEqual([{ kind: "reply_card", target: "om_activation" }]);
    expect((await db.selectFrom("conversations").select(["thread_id", "response_message_id"]).where("id", "=", conversation.id).executeTakeFirstOrThrow()))
      .toMatchObject({ thread_id: null, response_message_id: "om_group_reply" });
  });

  it("falls back once to a quoted Markdown reply after a definite CardKit rejection", async () => {
    const calls: Array<{ kind: string; target?: string }> = [];
    const cardLark = {
      createCardEntity: async () => "invalid_card",
      replyCardEntityToMessage: async () => { throw new AppError("lark-cli failed: ErrCode: 11310; cardid is invalid", 502, "lark_cli_error"); },
      replyMarkdownToMessage: async (messageId: string) => { calls.push({ kind: "reply_markdown", target: messageId }); return "om_markdown"; }
    } as unknown as LarkGateway;
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_fallback", chat_type: "group", root_message_id: "om_original", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_current", state: "running", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, preferred_executor_id: null, executor_id: null, codex_thread_id: null,
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();

    const result = await new TaskOutputService(db, { ...config, larkEnabled: true }, cardLark).finalize(task.id, "fallback answer", "fallback-key");

    expect(result).toEqual({ messageId: "om_markdown", transport: "markdown_fallback" });
    expect(calls).toEqual([{ kind: "reply_markdown", target: "om_current" }]);
    expect(await db.selectFrom("task_outputs").select(["card_id", "message_id", "state", "transport"]).where("task_id", "=", task.id).executeTakeFirstOrThrow())
      .toEqual({ card_id: null, message_id: "om_markdown", state: "completed", transport: "markdown_fallback" });
  });

  it("routes one active task per group without threads and ignores messages after completion", async () => {
    let details: LarkMessageDetails = {
      messageId: "om_unrelated",
      rootId: null,
      parentId: null,
      threadId: null,
      chatId: "oc_test",
      senderId: "ou_member",
      senderType: "user",
      messageType: "text",
      content: "ordinary chat",
      createTime: "1",
      mentions: []
    };
    let getMessageCalls = 0;
    const fakeLark = { getMessage: async () => { getMessageCalls += 1; return details; } } as unknown as LarkGateway;
    const router = new EventRouter(db, config, fakeLark, new ControlPlaneRepository(db, 60));
    const event = (eventId: string, messageId: string, content: string, senderId = "ou_member", messageType = "text"): LarkMessageEvent => ({
      type: "im.message.receive_v1",
      event_id: eventId,
      timestamp: "1",
      message_id: messageId,
      chat_id: "oc_test",
      chat_type: "group",
      sender_id: senderId,
      message_type: messageType,
      content,
      create_time: "1"
    });

    await router.handleMessage(event("ev_unrelated", "om_unrelated", "ordinary chat"));
    expect(await db.selectFrom("processed_events").select("status").where("event_id", "=", "ev_unrelated").executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("signals").selectAll().execute()).toHaveLength(0);

    const inactiveFile = JSON.stringify({ file_key: "file_inactive", file_name: "inactive.txt" });
    details = { ...details, messageId: "om_inactive_file", messageType: "file", content: inactiveFile, rawContent: inactiveFile, mentions: [] };
    await router.handleMessage(event("ev_inactive_file", "om_inactive_file", inactiveFile, "ou_member", "file"));
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("signals").selectAll().execute()).toHaveLength(0);

    details = { ...details, messageId: "om_activated", messageType: "text", content: "@Lark Agent handle this", rawContent: undefined, mentions: [{ id: "cli_bot", idType: "app_id", name: "Lark Agent" }] };
    await router.handleMessage(event("ev_activated", "om_activated", "@Lark Agent handle this", "ou_owner"));
    expect(getMessageCalls).toBe(2);
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(1);
    const activatedConversation = await db.selectFrom("conversations").selectAll().executeTakeFirstOrThrow();
    expect(activatedConversation.thread_id).toBeNull();
    let signals = await db.selectFrom("signals").selectAll().orderBy("seq").execute();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.content).toBe("@Lark Agent handle this");

    details = { ...details, messageId: "om_followup", content: "follow up without mention", mentions: [] };
    await router.handleMessage(event("ev_followup", "om_followup", "follow up without mention"));
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(1);
    signals = await db.selectFrom("signals").selectAll().orderBy("seq").execute();
    expect(signals.map((signal) => signal.content)).toEqual(["@Lark Agent handle this", "follow up without mention"]);

    const activeFile = JSON.stringify({ file_key: "file_active", file_name: "active.txt" });
    details = { ...details, messageId: "om_active_file", messageType: "file", content: activeFile, rawContent: activeFile, mentions: [] };
    await router.handleMessage(event("ev_active_file", "om_active_file", activeFile, "ou_member", "file"));
    signals = await db.selectFrom("signals").selectAll().orderBy("seq").execute();
    expect(signals).toHaveLength(3);
    expect(signals[2]?.content).toBe("附件（1 个）：文件「active.txt」");
    expect(signals[2]?.content).not.toContain("file_active");
    expect(signals[2]?.attachments).toMatchObject([{ type: "file", fileName: "active.txt", resourceKey: "file_active" }]);

    const activeTask = await db.selectFrom("tasks").select("id").executeTakeFirstOrThrow();
    await new ControlPlaneRepository(db, 60).finishTask(activeTask.id, "completed", "done");
    expect((await db.selectFrom("conversations").select("active").where("id", "=", activatedConversation.id).executeTakeFirstOrThrow()).active).toBe(false);
    details = { ...details, messageId: "om_after", messageType: "text", content: "ordinary after completion", rawContent: undefined, mentions: [] };
    await router.handleMessage(event("ev_after", "om_after", "ordinary after completion"));
    expect(await db.selectFrom("signals").selectAll().execute()).toHaveLength(3);
    expect(await db.selectFrom("processed_events").select("event_id").where("event_id", "=", "ev_after").executeTakeFirst()).toBeUndefined();

    details = { ...details, messageId: "om_reactivate", messageType: "text", content: "@Lark Agent next task", rawContent: undefined, mentions: [{ id: "cli_bot", idType: "app_id", name: "Lark Agent" }] };
    await router.handleMessage(event("ev_reactivate", "om_reactivate", "@Lark Agent next task"));
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(2);
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(2);
  });

  it("routes a direct private image as an attachment task without requiring text", async () => {
    const rawContent = JSON.stringify({ image_key: "img_private" });
    const details: LarkMessageDetails = {
      messageId: "om_private_image", rootId: null, parentId: null, threadId: null, chatId: "oc_private_image",
      senderId: "ou_owner", senderType: "user", messageType: "image", content: rawContent, rawContent,
      createTime: "1", mentions: []
    };
    const router = new EventRouter(db, config, { getMessage: async () => details } as unknown as LarkGateway, new ControlPlaneRepository(db, 60));
    await router.handleMessage({
      type: "im.message.receive_v1", event_id: "ev_private_image", timestamp: "1", message_id: details.messageId,
      chat_id: details.chatId, chat_type: "p2p", sender_id: details.senderId, message_type: "image", content: rawContent, create_time: "1"
    });
    const stored = await db.selectFrom("signals").select(["content", "preview", "attachments"]).executeTakeFirstOrThrow();
    expect(stored.content).toBe("附件（1 个）：图片「image」");
    expect(stored.preview).toBe(stored.content);
    expect(stored.attachments).toMatchObject([{ type: "image", fileName: "image", resourceKey: "img_private" }]);
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(1);
  });

  it("pauses a newly activated group task when multiple executors are eligible but none is bound", async () => {
    await insertWorker();
    await db.updateTable("bots").set({
      attention_model: "attention-fast", attention_reasoning_effort: "low",
      execution_model: "execution-deep", execution_reasoning_effort: "high"
    }).where("id", "=", "00000000-0000-0000-0000-000000000001").execute();
    await db.insertInto("workers").values({
      executor_id: "worker-b", display_name: "Worker B", home_ref: "worker-b:home", codex_profile: "lark-agent",
      config_fingerprint: "b".repeat(64), codex_version: "test", capacity: 1,
      workspace_aliases: JSON.stringify(["repo"]), capabilities: JSON.stringify(["codex", "chat_context_v1"]), last_seen_at: new Date(), updated_at: new Date()
    }).execute();
    const details: LarkMessageDetails = {
      messageId: "om_route_ambiguous", rootId: null, parentId: null, threadId: null, chatId: "oc_test",
      senderId: "ou_owner", senderType: "user", messageType: "text", content: "@Lark Agent 测试路由",
      createTime: "1", mentions: [{ id: "cli_bot", idType: "app_id", name: "Lark Agent" }]
    };
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const router = new EventRouter(db, config, { getMessage: async () => details } as unknown as LarkGateway, new ControlPlaneRepository(db, 60), bot);
    await router.handleMessage({
      type: "im.message.receive_v1", event_id: "ev_route_ambiguous", timestamp: "1", message_id: details.messageId,
      chat_id: details.chatId, chat_type: "group", sender_id: details.senderId, message_type: "text", content: details.content, create_time: "1"
    });

    const task = await db.selectFrom("tasks").select(["state", "preferred_executor_id", "summary"]).executeTakeFirstOrThrow();
    expect(task).toMatchObject({ state: "waiting_input", preferred_executor_id: null });
    expect(task.summary).toContain("多个可用执行器");
    expect(await db.selectFrom("conversations").select(["attention_model_snapshot", "attention_reasoning_effort_snapshot", "execution_model_snapshot", "execution_reasoning_effort_snapshot"]).executeTakeFirstOrThrow())
      .toEqual({ attention_model_snapshot: "attention-fast", attention_reasoning_effort_snapshot: "low", execution_model_snapshot: "execution-deep", execution_reasoning_effort_snapshot: "high" });
    expect((await db.selectFrom("task_events").select(["event_type", "summary"]).where("event_type", "=", "task.created").executeTakeFirstOrThrow()).summary)
      .toContain("路由不明确");
  });

  it("keeps an awaiting group conversation active and creates the next turn on an ordinary message", async () => {
    await insertWorker();
    let details: LarkMessageDetails = {
      messageId: "om_one", rootId: null, parentId: null, threadId: null, chatId: "oc_test",
      senderId: "ou_owner", senderType: "user", messageType: "text", content: "@Lark Agent count, 1",
      createTime: "1", mentions: [{ id: "cli_bot", idType: "app_id", name: "Lark Agent" }]
    };
    const fakeLark = { getMessage: async () => details } as unknown as LarkGateway;
    const repository = new ControlPlaneRepository(db, 60);
    const router = new EventRouter(db, config, fakeLark, repository);
    const event = (eventId: string, messageId: string, senderId: string, content: string): LarkMessageEvent => ({
      type: "im.message.receive_v1", event_id: eventId, timestamp: "1", message_id: messageId,
      chat_id: "oc_test", chat_type: "group", sender_id: senderId, message_type: "text", content, create_time: "1"
    });

    await router.handleMessage(event("ev_one", "om_one", "ou_owner", details.content));
    const first = await db.selectFrom("tasks").selectAll().executeTakeFirstOrThrow();
    await db.updateTable("tasks").set({
      state: "running", executor_id: "worker-a", preferred_executor_id: "worker-a", codex_thread_id: "thread-count",
      resolved_workspace_alias: "repo", executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test"
    }).where("id", "=", first.id).execute();
    await repository.bindTaskThread(first.id, "thread-count");
    await repository.finishTask(first.id, "completed", "replied 2", {
      disposition: "awaiting_followup", processedRoomSeq: 1, reason: "counting has not reached 10"
    });
    const waitingConversation = await db.selectFrom("conversations").selectAll().where("id", "=", first.conversation_id).executeTakeFirstOrThrow();
    expect(waitingConversation.active).toBe(true);
    expect(waitingConversation.followup_expires_at).not.toBeNull();

    details = { ...details, messageId: "om_three", senderId: "ou_member", content: "3", mentions: [] };
    await router.handleMessage(event("ev_three", "om_three", "ou_member", "3"));
    const turns = await db.selectFrom("tasks").selectAll().orderBy("turn_index").execute();
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      turn_index: 2, trigger_message_id: "om_three", state: "waiting_worker", requester_id: "ou_member",
      requester_role: "member", executor_id: "worker-a", codex_thread_id: "thread-count",
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64)
    });
    expect((turns[1]?.authorization_grant as { repoWrite: boolean }).repoWrite).toBe(false);
    expect((await db.selectFrom("signals").selectAll().where("task_id", "=", turns[1]?.id as string).executeTakeFirstOrThrow()).message_id).toBe("om_three");

    await repository.finishTask(turns[1]?.id as string, "completed", "replied 4", {
      disposition: "complete", processedRoomSeq: 2, reason: "test ended"
    });
    expect((await db.selectFrom("conversations").select(["active", "followup_expires_at"]).where("id", "=", first.conversation_id).executeTakeFirstOrThrow()))
      .toMatchObject({ active: false, followup_expires_at: null });
  });

  it("moves a signal arriving after reply generation into an atomic next turn", async () => {
    await insertWorker();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_race", chat_type: "group", root_message_id: "om_start", thread_id: null,
      room_seq: 2, active: true, response_message_id: "om_reply", followup_expires_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_start", state: "running", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, resolved_workspace_alias: "repo", preferred_executor_id: "worker-a", executor_id: "worker-a", codex_thread_id: "thread-race",
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test",
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    await new ControlPlaneRepository(db, 60).bindTaskThread(task.id, "thread-race");
    await db.insertInto("processed_events").values({ event_id: "ev_late", event_type: "message", status: "processed", processed_at: new Date() }).execute();
    await db.insertInto("signals").values({
      conversation_id: conversation.id, task_id: task.id, event_id: "ev_late", seq: 2, message_id: "om_late", origin_message_id: "om_late",
      sender_id: "ou_member", sender_role: "member", message_type: "text", content: "late", preview: "late",
      priority: 50, decision: "pending", decision_rationale: null, decided_at: null
    }).execute();

    const result = await new ControlPlaneRepository(db, 60).finishTask(task.id, "completed", "first reply sent", {
      disposition: "awaiting_followup", processedRoomSeq: 1, reason: "awaiting response"
    });

    expect(result.nextTaskId).not.toBeNull();
    const next = await db.selectFrom("tasks").selectAll().where("id", "=", result.nextTaskId as string).executeTakeFirstOrThrow();
    expect(next).toMatchObject({ turn_index: 2, trigger_message_id: "om_late", state: "waiting_worker", codex_thread_id: "thread-race" });
    expect((await db.selectFrom("signals").select("task_id").where("message_id", "=", "om_late").executeTakeFirstOrThrow()).task_id).toBe(next.id);
  });

  it("expires an idle follow-up conversation without touching a running turn", async () => {
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_expire", chat_type: "group", root_message_id: "om_expire", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, followup_expires_at: new Date(Date.now() - 1_000), updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_expire", state: "completed", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, preferred_executor_id: null, executor_id: null, codex_thread_id: null,
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: "waiting", completed_at: new Date(), updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();

    expect(await new ControlPlaneRepository(db, 60).expireFollowupConversations()).toBe(1);
    expect((await db.selectFrom("conversations").select("active").where("id", "=", conversation.id).executeTakeFirstOrThrow()).active).toBe(false);
    expect((await db.selectFrom("task_events").select("event_type").where("task_id", "=", task.id).executeTakeFirstOrThrow()).event_type).toBe("conversation.followup_expired");
  });

  it("serializes concurrent group activation into one active task", async () => {
    const fakeLark = {
      getMessage: async (messageId: string): Promise<LarkMessageDetails> => ({
        messageId,
        rootId: null,
        parentId: null,
        threadId: "omt_external_topic",
        chatId: "oc_test",
        senderId: "ou_owner",
        senderType: "user",
        messageType: "text",
        content: `@Lark Agent ${messageId}`,
        createTime: "1",
        mentions: [{ id: "cli_bot", idType: "app_id", name: "Lark Agent" }]
      })
    } as unknown as LarkGateway;
    const router = new EventRouter(db, config, fakeLark, new ControlPlaneRepository(db, 60));
    const makeEvent = (eventId: string, messageId: string): LarkMessageEvent => ({
      type: "im.message.receive_v1",
      event_id: eventId,
      timestamp: "1",
      message_id: messageId,
      chat_id: "oc_test",
      chat_type: "group",
      sender_id: "ou_owner",
      message_type: "text",
      content: `@Lark Agent ${messageId}`,
      create_time: "1"
    });

    await Promise.all([
      router.handleMessage(makeEvent("ev_concurrent_1", "om_concurrent_1")),
      router.handleMessage(makeEvent("ev_concurrent_2", "om_concurrent_2"))
    ]);

    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("signals").selectAll().execute()).toHaveLength(2);
    expect((await db.selectFrom("conversations").select("thread_id").executeTakeFirstOrThrow()).thread_id).toBeNull();
  });

  it("serializes concurrent private top-level messages and keeps one durable chat context", async () => {
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const router = new MessageRouter(db);
    const message = (suffix: string) => ({
      eventId: `ev_private_${suffix}`, eventType: "im.message.receive_v1", messageId: `om_private_${suffix}`,
      chatId: "oc_private_serial", chatType: "p2p" as const, rootMessageId: `om_private_${suffix}`,
      senderId: "ou_owner", senderRole: "owner" as const, senderType: "user" as const, senderBotId: null,
      senderDisplayName: "主人", ingressSource: "lark" as const, originMessageId: `om_private_${suffix}`,
      botDialogueDepth: 0, messageType: "text", content: suffix, explicitlyActivated: true
    });

    await Promise.all([router.route(bot, message("one")), router.route(bot, message("two"))]);

    expect(await db.selectFrom("chat_contexts").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("signals").selectAll().execute()).toHaveLength(2);
  });

  it("keeps different private peers isolated and exposes one canonical display name", async () => {
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const router = new MessageRouter(db);
    const route = (suffix: string, peerId: string, peerName: string) => router.route(bot, {
      eventId: `ev_private_peer_${suffix}`, eventType: "im.message.receive_v1", messageId: `om_private_peer_${suffix}`,
      chatId: `oc_private_peer_${suffix}`, chatType: "p2p", rootMessageId: `om_private_peer_${suffix}`,
      senderId: peerId, senderRole: "member", senderType: "user", senderBotId: null, senderDisplayName: peerName,
      ingressSource: "lark", originMessageId: `om_private_peer_${suffix}`, botDialogueDepth: 0,
      messageType: "text", content: suffix, explicitlyActivated: true
    });
    await route("zhang", "ou_peer_zhang", "张三");
    await route("li", "ou_peer_li", "李四");

    const contexts = await db.selectFrom("chat_contexts").select(["id", "chat_id", "peer_open_id", "peer_display_name"]).orderBy("chat_id").execute();
    expect(contexts).toHaveLength(2);
    expect(new Set(contexts.map((item) => item.peer_open_id))).toEqual(new Set(["ou_peer_zhang", "ou_peer_li"]));

    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("private-peer-owner"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "private-peer-csrf",
      last_seen_at: now, expires_at: new Date(now.getTime() + 3_600_000)
    }).execute();
    const headers = { cookie: "lark_agent_admin_session=private-peer-owner" };
    const list = await app.inject({ method: "GET", url: "/v1/admin/chat-contexts?q=李四", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: Array<{ chatDisplayName: string; peerDisplayName: string; peerOpenId: string }> }>().items).toEqual([
      expect.objectContaining({ chatDisplayName: "与李四的私聊", peerDisplayName: "李四", peerOpenId: "ou_peer_li" })
    ]);
  });

  it("snapshots a fixed Thread with idempotent chunks, backward pagination, and failure fallback", async () => {
    await insertWorker();
    await db.updateTable("workers").set({
      capabilities: JSON.stringify(["codex", "chat_context_v1", "thread_snapshot_v1", "thread_turn_summary_v1"]),
      operational_mode: "maintenance",
      runner_version: "0.4.4",
      updated_at: new Date()
    }).where("executor_id", "=", "worker-a").execute();
    await db.updateTable("bots").set({
      attention_model: "attention-fast", attention_reasoning_effort: "low"
    }).where("id", "=", "00000000-0000-0000-0000-000000000001").execute();
    const context = await insertSkillContext("oc_thread_snapshot", "worker-a");
    await db.updateTable("chat_contexts").set({
      codex_thread_id: "thread-snapshot-test", state: "blocked", blocked_reason: "测试维护模式只读",
      updated_at: new Date()
    }).where("id", "=", context.id).execute();
    const credential = await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256("thread-snapshot-device"), last_used_at: null, revoked_at: null
    }).returning("id").executeTakeFirstOrThrow();
    const workerSession = await issueWorkerSession(config, {
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent",
      configFingerprint: "a".repeat(64), workspaceMappingFingerprint: null, credentialId: credential.id
    });
    const mismatchedWorkerSession = await issueWorkerSession(config, {
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "different-profile",
      configFingerprint: "a".repeat(64), workspaceMappingFingerprint: null, credentialId: credential.id
    });
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("thread-snapshot-owner"), open_id: "ou_owner", display_name: "owner", role: "owner",
      csrf_token: "thread-snapshot-csrf", last_seen_at: new Date(), expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const cookie = { cookie: "lark_agent_admin_session=thread-snapshot-owner" };
    const adminHeaders = { ...cookie, "x-csrf-token": "thread-snapshot-csrf" };
    const workerHeaders = { authorization: `Bearer ${workerSession.token}` };

    expect((await app.inject({ method: "GET", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: cookie })).statusCode).toBe(403);
    const enqueued = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: adminHeaders });
    expect(enqueued.statusCode).toBe(202);
    const duplicate = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: adminHeaders });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ jobId: enqueued.json<{ jobId: string }>().jobId, existing: true });
    const mismatchedClaim = await app.inject({
      method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim",
      headers: { authorization: `Bearer ${mismatchedWorkerSession.token}` }
    });
    expect(mismatchedClaim.statusCode).toBe(409);
    expect(mismatchedClaim.json<{ error: { code: string } }>().error.code).toBe("worker_config_changed");

    const claimed = await app.inject({ method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim", headers: workerHeaders });
    expect(claimed.statusCode).toBe(200);
    const job = claimed.json<{
      id: string; chatContextId: string; threadId: string; leaseToken: string; attempt: number;
      summaryEnabled: boolean; summaryModel: string | null; summaryReasoningEffort: string | null;
    }>();
    expect(job).toMatchObject({
      chatContextId: context.id, threadId: "thread-snapshot-test", attempt: 1,
      summaryEnabled: true, summaryModel: "attention-fast", summaryReasoningEffort: "low"
    });
    const leaseHeaders = { ...workerHeaders, "x-snapshot-lease-token": job.leaseToken };
    expect((await app.inject({ method: "POST", url: `/v1/workers/thread-snapshot-jobs/${job.id}/heartbeat`, headers: leaseHeaders })).statusCode).toBe(200);

    const summaryGeneratedAt = "2026-07-16T08:00:00.000Z";
    const turns = [0, 1, 2].map((turnIndex) => ({
      turnIndex, turnId: `turn-${turnIndex}`, status: "completed", startedAt: turnIndex * 1000,
      completedAt: turnIndex * 1000 + 900, durationMs: 900, error: null,
      raw: { id: `turn-${turnIndex}`, status: "completed" },
      summary: `处理主题 ${turnIndex}`,
      summarySource: turnIndex === 2 ? "fallback" : "ai",
      summaryModel: "attention-fast",
      summaryGeneratedAt
    }));
    const items = Array.from({ length: 61 }, (_, ordinal) => ({
      ordinal, turnId: ordinal < 30 ? "turn-0" : "turn-1", itemIndex: ordinal < 30 ? ordinal : ordinal - 30,
      itemId: `item-${ordinal}`, itemType: ordinal % 2 ? "agentMessage" : "userMessage",
      raw: { id: `item-${ordinal}`, type: ordinal % 2 ? "agentMessage" : "userMessage", text: `消息 ${ordinal}` }
    }));
    const upload = (payload: unknown) => app.inject({
      method: "POST", url: `/v1/workers/thread-snapshot-jobs/${job.id}/chunks`, headers: leaseHeaders, payload
    });
    expect((await upload({ chunkIndex: 1, turns: [], items: items.slice(50) })).statusCode).toBe(200);
    expect((await upload({ chunkIndex: 0, turns, items: items.slice(0, 50) })).statusCode).toBe(200);
    expect((await upload({ chunkIndex: 0, turns, items: items.slice(0, 50) })).statusCode).toBe(200);
    const conflicting = await upload({ chunkIndex: 9, turns: [], items: [{ ...items[0], raw: { ...items[0]?.raw, text: "冲突" } }] });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json<{ error: { code: string } }>().error.code).toBe("thread_snapshot_chunk_conflict");

    const completed = await app.inject({
      method: "POST", url: `/v1/workers/thread-snapshot-jobs/${job.id}/complete`, headers: leaseHeaders,
      payload: { threadMetadata: { id: "thread-snapshot-test", cwd: "/private/workspace" }, protocolSource: "thread/read+thread/items/list", turnCount: 3, itemCount: 61 }
    });
    expect(completed.statusCode).toBe(200);
    const latest = await app.inject({ method: "GET", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot?limit=50`, headers: cookie });
    expect(latest.statusCode).toBe(200);
    const firstPage = latest.json<{
      snapshot: { itemCount: number; thread: Record<string, unknown> }; refresh: unknown;
      items: Array<{ ordinal: number; raw: Record<string, unknown> }>;
      turns: Array<{ turnId: string; summary: string | null; summarySource: string | null; summaryModel: string | null; summaryGeneratedAt: string | null }>;
      nextCursor: string;
    }>();
    expect(firstPage.snapshot).toMatchObject({ itemCount: 61, thread: { id: "thread-snapshot-test", cwd: "/private/workspace" } });
    expect(firstPage.refresh).toBeNull();
    expect(firstPage.items.map((item) => item.ordinal)).toEqual(Array.from({ length: 50 }, (_, index) => index + 11));
    expect(firstPage.items.at(-1)?.raw).toMatchObject({ text: "消息 60" });
    expect(firstPage.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: "turn-0", summary: "处理主题 0", summarySource: "ai", summaryModel: "attention-fast", summaryGeneratedAt }),
      expect.objectContaining({ turnId: "turn-1", summary: "处理主题 1", summarySource: "ai", summaryModel: "attention-fast", summaryGeneratedAt })
    ]));
    const earlier = await app.inject({ method: "GET", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot?limit=50&before=${encodeURIComponent(firstPage.nextCursor)}`, headers: cookie });
    expect(earlier.json<{ items: Array<{ ordinal: number }>; nextCursor: null }>().items.map((item) => item.ordinal)).toEqual(Array.from({ length: 11 }, (_, index) => index));
    expect(earlier.json<{ nextCursor: null }>().nextCursor).toBeNull();

    const refresh = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: adminHeaders });
    expect(refresh.statusCode).toBe(202);
    const refreshClaim = await app.inject({ method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim", headers: workerHeaders });
    const failedJob = refreshClaim.json<{ id: string; leaseToken: string }>();
    const summaryUrl = `/v1/workers/thread-snapshot-jobs/${failedJob.id}/turn-summaries`;
    await db.insertInto("workers").values({
      executor_id: "worker-b", display_name: "Worker B", home_ref: "worker-b:home", codex_profile: "lark-agent",
      config_fingerprint: "b".repeat(64), codex_version: "test", capacity: 1,
      workspace_aliases: JSON.stringify(["repo"]), capabilities: JSON.stringify(["codex", "thread_snapshot_v1"]),
      last_seen_at: new Date(), updated_at: new Date()
    }).execute();
    const otherCredential = await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-b", credential_hash: sha256("thread-snapshot-other-device"), last_used_at: null, revoked_at: null
    }).returning("id").executeTakeFirstOrThrow();
    const otherWorkerSession = await issueWorkerSession(config, {
      executorId: "worker-b", homeRef: "worker-b:home", codexProfile: "lark-agent",
      configFingerprint: "b".repeat(64), workspaceMappingFingerprint: null, credentialId: otherCredential.id
    });
    expect((await app.inject({ method: "GET", url: summaryUrl, headers: workerHeaders })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET", url: summaryUrl, headers: { ...workerHeaders, "x-snapshot-lease-token": "wrong" }
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "GET", url: summaryUrl,
      headers: { authorization: `Bearer ${otherWorkerSession.token}`, "x-snapshot-lease-token": failedJob.leaseToken }
    })).statusCode).toBe(409);
    const summaryHeaders = { ...workerHeaders, "x-snapshot-lease-token": failedJob.leaseToken };
    const summaryPage = await app.inject({ method: "GET", url: `${summaryUrl}?limit=1`, headers: summaryHeaders });
    expect(summaryPage.statusCode).toBe(200);
    const recentSummary = summaryPage.json<{
      summaries: Array<{ turnId: string; summary: string; summaryModel: string | null; summaryGeneratedAt: string | null }>;
      nextCursor: string;
    }>();
    expect(recentSummary.summaries).toEqual([{
      turnId: "turn-1", summary: "处理主题 1", summaryModel: "attention-fast", summaryGeneratedAt
    }]);
    const olderSummary = (await app.inject({
      method: "GET", url: `${summaryUrl}?limit=1&before=${encodeURIComponent(recentSummary.nextCursor)}`, headers: summaryHeaders
    })).json<{ summaries: Array<{ turnId: string }>; nextCursor: null }>();
    expect(olderSummary).toEqual({
      summaries: [{ turnId: "turn-0", summary: "处理主题 0", summaryModel: "attention-fast", summaryGeneratedAt }],
      nextCursor: null
    });
    const invalidSummaryCursor = await app.inject({
      method: "GET", url: `${summaryUrl}?before=invalid`, headers: summaryHeaders
    });
    expect(invalidSummaryCursor.statusCode).toBe(400);
    expect(invalidSummaryCursor.json<{ error: { code: string } }>().error.code).toBe("invalid_thread_summary_cursor");
    expect((await app.inject({
      method: "POST", url: `/v1/workers/thread-snapshot-jobs/${failedJob.id}/fail`,
      headers: { ...workerHeaders, "x-snapshot-lease-token": failedJob.leaseToken }, payload: { summary: "Codex 协议读取失败" }
    })).statusCode).toBe(200);
    const fallback = (await app.inject({ method: "GET", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: cookie })).json<{
      snapshot: { id: string; itemCount: number }; refresh: { state: string; error: string }; items: Array<{ ordinal: number }>
    }>();
    expect(fallback.snapshot).toMatchObject({ id: job.id, itemCount: 61 });
    expect(fallback.refresh).toEqual(expect.objectContaining({ state: "failed", error: "Codex 协议读取失败" }));
    expect(fallback.items).toHaveLength(50);

    expect((await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: adminHeaders })).statusCode).toBe(202);
    const replacementClaim = (await app.inject({ method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim", headers: workerHeaders }))
      .json<{ id: string; leaseToken: string }>();
    const replacementHeaders = { ...workerHeaders, "x-snapshot-lease-token": replacementClaim.leaseToken };
    expect((await app.inject({
      method: "POST", url: `/v1/workers/thread-snapshot-jobs/${replacementClaim.id}/chunks`, headers: replacementHeaders,
      payload: { chunkIndex: 0, turns: [turns[0]], items: [items[0]] }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST", url: `/v1/workers/thread-snapshot-jobs/${replacementClaim.id}/complete`, headers: replacementHeaders,
      payload: { threadMetadata: { id: "thread-snapshot-test" }, protocolSource: "thread/read", turnCount: 1, itemCount: 1 }
    })).statusCode).toBe(200);
    const replaced = (await app.inject({ method: "GET", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: cookie }))
      .json<{ snapshot: { id: string; itemCount: number }; items: Array<{ ordinal: number }> }>();
    expect(replaced).toMatchObject({ snapshot: { id: replacementClaim.id, itemCount: 1 }, items: [{ ordinal: 0 }] });
    expect(await db.selectFrom("chat_thread_snapshot_jobs").select("id").where("id", "=", job.id).executeTakeFirst()).toBeUndefined();
  });

  it("explains unsupported and offline fixed runners before Thread snapshot execution", async () => {
    await insertWorker();
    const context = await insertSkillContext("oc_thread_snapshot_compatibility", "worker-a");
    await db.updateTable("chat_contexts").set({
      codex_thread_id: "thread-compatibility", state: "ready", updated_at: new Date()
    }).where("id", "=", context.id).execute();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("thread-compatibility-owner"), open_id: "ou_owner", display_name: "owner", role: "owner",
      csrf_token: "thread-compatibility-csrf", last_seen_at: new Date(), expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const headers = {
      cookie: "lark_agent_admin_session=thread-compatibility-owner",
      "x-csrf-token": "thread-compatibility-csrf"
    };

    const unsupported = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: "thread_snapshot_unsupported", message: expect.stringContaining("升级 Runner")
    });

    await db.updateTable("workers").set({
      capabilities: JSON.stringify(["codex", "chat_context_v1", "thread_snapshot_v1"]),
      runner_version: "0.4.2", last_seen_at: new Date(Date.now() - 5 * 60_000), updated_at: new Date()
    }).where("executor_id", "=", "worker-a").execute();
    const credential = await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256("thread-compatibility-device"), last_used_at: null, revoked_at: null
    }).returning("id").executeTakeFirstOrThrow();
    const session = await issueWorkerSession(config, {
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent",
      configFingerprint: "a".repeat(64), workspaceMappingFingerprint: null, credentialId: credential.id
    });
    expect((await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers })).statusCode).toBe(202);
    const view = (await app.inject({
      method: "GET", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: { cookie: headers.cookie }
    })).json<{ refresh: { state: string; executorAvailability: string; executorLastSeenAt: string; runnerVersion: string } }>();
    expect(view.refresh).toMatchObject({ state: "queued", executorAvailability: "offline", runnerVersion: "0.4.2" });
    expect(view.refresh.executorLastSeenAt).toEqual(expect.any(String));
    const oldRunnerClaim = await app.inject({
      method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim",
      headers: { authorization: `Bearer ${session.token}` }
    });
    expect(oldRunnerClaim.statusCode).toBe(200);
    expect(oldRunnerClaim.json()).toMatchObject({
      summaryEnabled: false, summaryModel: null, summaryReasoningEffort: null
    });
  });

  it("retries expired Thread snapshot leases three times, clears partial chunks, and times out stale queues", async () => {
    await insertWorker();
    await db.updateTable("workers").set({
      capabilities: JSON.stringify(["codex", "chat_context_v1", "thread_snapshot_v1"]),
      runner_version: "0.4.2", updated_at: new Date()
    }).where("executor_id", "=", "worker-a").execute();
    const context = await insertSkillContext("oc_thread_snapshot_retry", "worker-a");
    await db.updateTable("chat_contexts").set({ codex_thread_id: "thread-retry", state: "ready", updated_at: new Date() })
      .where("id", "=", context.id).execute();
    const credential = await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256("thread-retry-device"), last_used_at: null, revoked_at: null
    }).returning("id").executeTakeFirstOrThrow();
    const session = await issueWorkerSession(config, {
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent",
      configFingerprint: "a".repeat(64), workspaceMappingFingerprint: null, credentialId: credential.id
    });
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("thread-retry-owner"), open_id: "ou_owner", display_name: "owner", role: "owner",
      csrf_token: "thread-retry-csrf", last_seen_at: new Date(), expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const adminHeaders = { cookie: "lark_agent_admin_session=thread-retry-owner", "x-csrf-token": "thread-retry-csrf" };
    const workerHeaders = { authorization: `Bearer ${session.token}` };
    expect((await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: adminHeaders })).statusCode).toBe(202);

    const first = (await app.inject({ method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim", headers: workerHeaders }))
      .json<{ id: string; leaseToken: string; attempt: number }>();
    expect(first.attempt).toBe(1);
    expect((await app.inject({
      method: "POST", url: `/v1/workers/thread-snapshot-jobs/${first.id}/chunks`,
      headers: { ...workerHeaders, "x-snapshot-lease-token": first.leaseToken },
      payload: { chunkIndex: 0, turns: [], items: [{ ordinal: 0, turnId: null, itemIndex: null, itemId: "partial", itemType: "agentMessage", raw: { id: "partial", type: "agentMessage" } }] }
    })).statusCode).toBe(200);
    await db.updateTable("chat_thread_snapshot_jobs").set({ lease_expires_at: new Date(Date.now() - 1_000) }).where("id", "=", first.id).execute();

    const second = (await app.inject({ method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim", headers: workerHeaders }))
      .json<{ id: string; attempt: number }>();
    expect(second).toMatchObject({ id: first.id, attempt: 2 });
    expect((await db.selectFrom("chat_thread_snapshot_items").select(sql<number>`count(*)::int`.as("count")).where("job_id", "=", first.id).executeTakeFirstOrThrow()).count).toBe(0);
    await db.updateTable("chat_thread_snapshot_jobs").set({ lease_expires_at: new Date(Date.now() - 1_000) }).where("id", "=", first.id).execute();

    const third = (await app.inject({ method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim", headers: workerHeaders }))
      .json<{ id: string; attempt: number }>();
    expect(third).toMatchObject({ id: first.id, attempt: 3 });
    await db.updateTable("chat_thread_snapshot_jobs").set({ lease_expires_at: new Date(Date.now() - 1_000) }).where("id", "=", first.id).execute();
    expect((await app.inject({ method: "POST", url: "/v1/workers/thread-snapshot-jobs/claim", headers: workerHeaders })).statusCode).toBe(204);
    expect(await db.selectFrom("chat_thread_snapshot_jobs").select(["state", "attempt", "last_error"]).where("id", "=", first.id).executeTakeFirstOrThrow())
      .toEqual({ state: "failed", attempt: 3, last_error: "Thread 快照连续 3 次租约过期" });

    expect((await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: adminHeaders })).statusCode).toBe(202);
    await db.updateTable("chat_thread_snapshot_jobs").set({ requested_at: new Date(Date.now() - 11 * 60_000) })
      .where("chat_context_id", "=", context.id).where("state", "=", "queued").execute();
    const timedOut = (await app.inject({
      method: "GET", url: `/v1/admin/chat-contexts/${context.id}/thread-snapshot`, headers: { cookie: adminHeaders.cookie }
    })).json<{ refresh: { state: string; error: string } }>();
    expect(timedOut.refresh).toMatchObject({ state: "failed", error: "等待原执行器读取 Thread 超过 10 分钟" });
  });

  it("backfills historical private peer ids and invalidates the old permission policy cache", async () => {
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const routed = await new MessageRouter(db).route(bot, {
      eventId: "ev_private_migration", eventType: "im.message.receive_v1", messageId: "om_private_migration",
      chatId: "oc_private_migration", chatType: "p2p", rootMessageId: "om_private_migration",
      senderId: "ou_historical_peer", senderRole: "member", senderType: "user", senderBotId: null, senderDisplayName: null,
      ingressSource: "lark", originMessageId: "om_private_migration", botDialogueDepth: 0,
      messageType: "text", content: "migration", explicitlyActivated: true
    });
    const contextId = routed.chatContextId as string;
    await db.updateTable("chat_contexts").set({ peer_open_id: null, peer_identity_checked_at: null }).where("id", "=", contextId).execute();
    await db.updateTable("bots").set({ permission_state: "valid", permission_check: JSON.stringify({ policyVersion: 1 }), permission_checked_at: new Date() }).where("id", "=", bot.id).execute();

    const migration = await readFile(fileURLToPath(new URL("../db/migrations/021_chat_context_identity.sql", import.meta.url)), "utf8");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(migration);
    await client.end();

    expect((await db.selectFrom("chat_contexts").select("peer_open_id").where("id", "=", contextId).executeTakeFirstOrThrow()).peer_open_id).toBe("ou_historical_peer");
    expect(await db.selectFrom("bots").select(["permission_state", "permission_check", "permission_checked_at"]).where("id", "=", bot.id).executeTakeFirstOrThrow())
      .toEqual({ permission_state: "unchecked", permission_check: null, permission_checked_at: null });
  });

  it("caches resolved peer names and keeps lookup failures non-blocking", async () => {
    const success = await insertSkillContext("oc_identity_success");
    const failed = await insertSkillContext("oc_identity_failure");
    await db.updateTable("chat_contexts").set({ peer_open_id: "ou_identity_success" }).where("id", "=", success.id).execute();
    await db.updateTable("chat_contexts").set({ peer_open_id: "ou_identity_failure" }).where("id", "=", failed.id).execute();
    const gateway = {
      getUserDisplayName: vi.fn(async (peerId: string) => {
        if (peerId === "ou_identity_failure") throw new Error("temporary contact outage");
        return "王五";
      })
    } as unknown as LarkGateway;
    const service = new ChatIdentityService(
      db,
      { gateway: vi.fn(async () => gateway) } as unknown as BotGatewayRegistry,
      new AdminEventBus(),
      { info: vi.fn(), error: vi.fn() }
    );

    await service.refresh(success.id);
    await service.refresh(success.id);
    await expect(service.refresh(failed.id)).resolves.toBeUndefined();

    expect(gateway.getUserDisplayName).toHaveBeenCalledTimes(2);
    expect(await db.selectFrom("chat_contexts").select(["peer_display_name", "peer_identity_checked_at"]).where("id", "=", success.id).executeTakeFirstOrThrow())
      .toEqual({ peer_display_name: "王五", peer_identity_checked_at: expect.any(Date) });
    expect((await db.selectFrom("chat_contexts").select(["peer_display_name", "peer_identity_checked_at"]).where("id", "=", failed.id).executeTakeFirstOrThrow()).peer_identity_checked_at)
      .toEqual(expect.any(Date));
  });

  it("reuses one private chat Thread across separate top-level conversations", async () => {
    await insertWorker();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const router = new MessageRouter(db);
    const repository = new ControlPlaneRepository(db, 60);
    const message = (suffix: string) => ({
      eventId: `ev_private_reuse_${suffix}`, eventType: "im.message.receive_v1", messageId: `om_private_reuse_${suffix}`,
      chatId: "oc_private_reuse", chatType: "p2p" as const, rootMessageId: `om_private_reuse_${suffix}`,
      senderId: "ou_owner", senderRole: "owner" as const, senderType: "user" as const, senderBotId: null,
      senderDisplayName: "主人", ingressSource: "lark" as const, originMessageId: `om_private_reuse_${suffix}`,
      botDialogueDepth: 0, messageType: "text", content: suffix, explicitlyActivated: true
    });

    const firstRoute = await router.route(bot, message("one"));
    const firstClaim = await repository.claimTask({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64) });
    expect(firstClaim?.task.id).toBe(firstRoute.taskId);
    expect((await repository.bindTaskThread(firstRoute.taskId as string, "thread-private-stable")).status).toBe("bound");
    await repository.finishTask(firstRoute.taskId as string, "completed", "done", { disposition: "complete", processedRoomSeq: 1, reason: "done" });

    const secondRoute = await router.route(bot, message("two"));
    const tasks = await db.selectFrom("tasks").selectAll().orderBy("created_at").execute();
    const conversations = await db.selectFrom("conversations").selectAll().orderBy("created_at").execute();
    expect(secondRoute.taskId).not.toBe(firstRoute.taskId);
    expect(conversations).toHaveLength(2);
    expect(new Set(conversations.map((item) => item.chat_context_id))).toEqual(new Set([conversations[0]?.chat_context_id]));
    expect(tasks[1]).toMatchObject({ state: "waiting_worker", executor_id: "worker-a", codex_thread_id: "thread-private-stable" });
    expect((await db.selectFrom("chat_contexts").selectAll().executeTakeFirstOrThrow()).codex_thread_id).toBe("thread-private-stable");
  });

  it("keeps a group Thread after follow-up expiry and a new explicit activation", async () => {
    await insertWorker();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const router = new MessageRouter(db);
    const repository = new ControlPlaneRepository(db, 60);
    const message = (suffix: string) => ({
      eventId: `ev_group_reuse_${suffix}`, eventType: "im.message.receive_v1", messageId: `om_group_reuse_${suffix}`,
      chatId: "oc_test", chatType: "group" as const, rootMessageId: `om_group_reuse_${suffix}`,
      senderId: "ou_owner", senderRole: "owner" as const, senderType: "user" as const, senderBotId: null,
      senderDisplayName: "主人", ingressSource: "lark" as const, originMessageId: `om_group_reuse_${suffix}`,
      botDialogueDepth: 0, messageType: "text", content: `@Lark Agent ${suffix}`, explicitlyActivated: true
    });

    const first = await router.route(bot, message("one"));
    await repository.claimTask({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64) });
    await repository.bindTaskThread(first.taskId as string, "thread-group-stable");
    await repository.finishTask(first.taskId as string, "completed", "waiting", { disposition: "awaiting_followup", processedRoomSeq: 1, reason: "waiting" });
    await db.updateTable("conversations").set({ followup_expires_at: new Date(Date.now() - 1_000) }).where("id", "=", (await db.selectFrom("tasks").select("conversation_id").where("id", "=", first.taskId as string).executeTakeFirstOrThrow()).conversation_id).execute();
    expect(await repository.expireFollowupConversations()).toBe(1);

    const second = await router.route(bot, message("two"));
    expect(second.taskId).not.toBe(first.taskId);
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(2);
    expect(await db.selectFrom("chat_contexts").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("tasks").select(["codex_thread_id", "executor_id"]).where("id", "=", second.taskId as string).executeTakeFirstOrThrow())
      .toEqual({ codex_thread_id: "thread-group-stable", executor_id: "worker-a" });
  });

  it("isolates chat contexts for two bots in the same group", async () => {
    const secondBot = await db.insertInto("bots").values({
      app_id: "cli_bot_second", profile_name: null, bot_open_id: "ou_bot_second", display_name: "Second Agent",
      role_instructions: "", owner_open_id: "ou_owner", default_executor_id: null, default_workspace_alias: null,
      enabled: true, is_system: false, credential_state: "verified", credential_error: null,
      permission_state: "valid", permission_check: JSON.stringify({ ok: true }), permission_checked_at: new Date(), deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("bot_chat_bindings").values({ bot_id: secondBot.id, chat_id: "oc_test", chat_name: "测试群", enabled: true, preferred_executor_id: null, workspace_alias: null, updated_at: new Date() }).execute();
    const firstBot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const route = (bot: typeof firstBot, suffix: string) => new MessageRouter(db).route(bot, {
      eventId: `ev_two_bots_${suffix}`, eventType: "im.message.receive_v1", messageId: `om_two_bots_${suffix}`,
      chatId: "oc_test", chatType: "group", rootMessageId: `om_two_bots_${suffix}`,
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: `om_two_bots_${suffix}`, botDialogueDepth: 0,
      messageType: "text", content: suffix, explicitlyActivated: true
    });
    await route(firstBot, "first");
    await route(secondBot, "second");

    const contexts = await db.selectFrom("chat_contexts").select(["id", "bot_id", "chat_id"]).orderBy("bot_id").execute();
    expect(contexts).toHaveLength(2);
    expect(new Set(contexts.map((item) => item.bot_id))).toEqual(new Set([firstBot.id, secondBot.id]));
    expect(new Set(contexts.map((item) => item.id)).size).toBe(2);
  });

  it("binds a Thread idempotently, blocks conflicts, and deduplicates native compaction", async () => {
    await insertWorker();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const repository = new ControlPlaneRepository(db, 60);
    const routed = await new MessageRouter(db).route(bot, {
      eventId: "ev_bind_context", eventType: "im.message.receive_v1", messageId: "om_bind_context",
      chatId: "oc_bind_context", chatType: "p2p", rootMessageId: "om_bind_context",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_bind_context", botDialogueDepth: 0,
      messageType: "text", content: "bind", explicitlyActivated: true
    });
    await repository.claimTask({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64) });

    expect((await repository.bindTaskThread(routed.taskId as string, "thread-a")).status).toBe("bound");
    expect((await repository.bindTaskThread(routed.taskId as string, "thread-a")).status).toBe("unchanged");
    expect((await repository.recordContextCompaction(routed.taskId as string, { threadId: "thread-a", turnId: "turn-compact", itemId: "item-compact", source: "item/completed" })).recorded).toBe(true);
    expect((await repository.recordContextCompaction(routed.taskId as string, { threadId: "thread-a", turnId: "turn-compact", itemId: "item-compact", source: "item/completed" })).recorded).toBe(false);
    expect((await repository.recordContextCompaction(routed.taskId as string, { threadId: "thread-a", turnId: "turn-compact", itemId: "item-compact-second", source: "item/completed" })).recorded).toBe(true);
    expect((await repository.recordContextCompaction(routed.taskId as string, { threadId: "thread-a", turnId: "turn-compact", itemId: null, source: "thread/compacted" })).recorded).toBe(false);
    expect((await repository.recordContextCompaction(routed.taskId as string, { threadId: "thread-a", turnId: "turn-legacy", itemId: null, source: "thread/compacted" })).recorded).toBe(true);
    expect((await repository.recordContextCompaction(routed.taskId as string, { threadId: "thread-a", turnId: "turn-legacy", itemId: "item-legacy-upgraded", source: "item/completed" })).recorded).toBe(false);
    const compactions = await db.selectFrom("chat_context_compactions").selectAll().orderBy("codex_turn_id").orderBy("codex_item_id").execute();
    expect(compactions).toHaveLength(3);
    expect(compactions.find((item) => item.codex_turn_id === "turn-legacy")?.codex_item_id).toBe("item-legacy-upgraded");
    expect(await db.selectFrom("chat_contexts").select(["codex_thread_id", "auto_compaction_count"]).executeTakeFirstOrThrow())
      .toEqual({ codex_thread_id: "thread-a", auto_compaction_count: 3 });

    expect((await repository.bindTaskThread(routed.taskId as string, "thread-b")).status).toBe("blocked");
    expect(await db.selectFrom("chat_contexts").select(["codex_thread_id", "state"]).executeTakeFirstOrThrow())
      .toEqual({ codex_thread_id: "thread-a", state: "blocked" });
    expect(await db.selectFrom("tasks").select(["codex_thread_id", "state", "lease_token_hash"]).where("id", "=", routed.taskId as string).executeTakeFirstOrThrow())
      .toEqual({ codex_thread_id: "thread-b", state: "waiting_input", lease_token_hash: null });
  });

  it("does not let an old runner claim chat-context tasks", async () => {
    await insertWorker();
    await db.updateTable("workers").set({ capabilities: JSON.stringify(["codex"]) }).where("executor_id", "=", "worker-a").execute();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    await new MessageRouter(db).route(bot, {
      eventId: "ev_old_runner", eventType: "im.message.receive_v1", messageId: "om_old_runner",
      chatId: "oc_old_runner", chatType: "p2p", rootMessageId: "om_old_runner",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_old_runner", botDialogueDepth: 0,
      messageType: "text", content: "old", explicitlyActivated: true
    });
    await expect(new ControlPlaneRepository(db, 60).claimTask({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64) })).resolves.toBeNull();
    expect(await db.selectFrom("tasks").select(["state", "preferred_executor_id"]).where("trigger_message_id", "=", "om_old_runner").executeTakeFirstOrThrow())
      .toEqual({ state: "queued", preferred_executor_id: null });

    await new MessageRouter(db).route({ ...bot, default_executor_id: "worker-a" }, {
      eventId: "ev_old_runner_preferred", eventType: "im.message.receive_v1", messageId: "om_old_runner_preferred",
      chatId: "oc_old_runner_preferred", chatType: "p2p", rootMessageId: "om_old_runner_preferred",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_old_runner_preferred", botDialogueDepth: 0,
      messageType: "text", content: "old preferred", explicitlyActivated: true
    });
    expect(await db.selectFrom("tasks").select(["state", "preferred_executor_id", "summary"]).where("trigger_message_id", "=", "om_old_runner_preferred").executeTakeFirstOrThrow())
      .toMatchObject({ state: "waiting_input", preferred_executor_id: "worker-a", summary: "指定执行器尚未升级，不支持永久聊天记忆" });
  });

  it("keeps managed-skill tasks queued until the executor inventory is complete", async () => {
    await insertWorker();
    await db.updateTable("workers").set({
      capabilities: JSON.stringify(["codex", "chat_context_v1", "skillhub_skills_v1", "user_skills_inventory_v1", "workspace_mapping_v1"]),
      workspace_mapping_fingerprint: workspaceMappingFingerprint,
      user_skills_scan_status: "unknown", user_skills_truncated: false
    }).where("executor_id", "=", "worker-a").execute();
    const pkg = await insertSkillPackage("inventory", "ready-gate");
    await db.insertInto("bot_skill_bindings").values({
      bot_id: "00000000-0000-0000-0000-000000000001", chat_context_id: null, package_id: pkg.id,
      namespace: pkg.namespace, slug: pkg.slug, created_by: "ou_owner", deleted_at: null, updated_at: new Date()
    }).execute();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const routed = await new MessageRouter(db).route(bot, {
      eventId: "ev_inventory_ready_gate", eventType: "im.message.receive_v1", messageId: "om_inventory_ready_gate",
      chatId: "oc_inventory_ready_gate", chatType: "p2p", rootMessageId: "om_inventory_ready_gate",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_inventory_ready_gate", botDialogueDepth: 0,
      messageType: "text", content: "run skill", explicitlyActivated: true
    });
    const repository = new ControlPlaneRepository(db, 60);
    const principal = { executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64), workspaceMappingFingerprint };

    await expect(repository.claimTask(principal)).resolves.toBeNull();
    expect((await db.selectFrom("tasks").select("state").where("id", "=", routed.taskId as string).executeTakeFirstOrThrow()).state).toBe("queued");
    await db.updateTable("workers").set({ user_skills_scan_status: "ready", user_skills_truncated: true }).where("executor_id", "=", "worker-a").execute();
    await expect(repository.claimTask(principal)).resolves.toBeNull();
    await db.updateTable("workers").set({ user_skills_truncated: false }).where("executor_id", "=", "worker-a").execute();
    await expect(repository.claimTask(principal)).resolves.toMatchObject({ task: { id: routed.taskId } });
  });

  it("blocks a fixed chat context when its runner loses chat_context_v1", async () => {
    await insertWorker();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const repository = new ControlPlaneRepository(db, 60);
    const first = await new MessageRouter(db).route(bot, {
      eventId: "ev_capability_fixed_1", eventType: "im.message.receive_v1", messageId: "om_capability_fixed_1",
      chatId: "oc_capability_fixed", chatType: "p2p", rootMessageId: "om_capability_fixed_1",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_capability_fixed_1", botDialogueDepth: 0,
      messageType: "text", content: "first", explicitlyActivated: true
    });
    await repository.claimTask({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64) });
    await repository.bindTaskThread(first.taskId as string, "thread-capability-fixed");
    await repository.finishTask(first.taskId as string, "completed", "done", { disposition: "complete", processedRoomSeq: 1, reason: "done" });
    await db.updateTable("workers").set({ capabilities: JSON.stringify(["codex"]) }).where("executor_id", "=", "worker-a").execute();

    const second = await new MessageRouter(db).route(bot, {
      eventId: "ev_capability_fixed_2", eventType: "im.message.receive_v1", messageId: "om_capability_fixed_2",
      chatId: "oc_capability_fixed", chatType: "p2p", rootMessageId: "om_capability_fixed_2",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_capability_fixed_2", botDialogueDepth: 0,
      messageType: "text", content: "second", explicitlyActivated: true
    });
    expect(await db.selectFrom("chat_contexts").select(["state", "codex_thread_id"]).where("chat_id", "=", "oc_capability_fixed").executeTakeFirstOrThrow())
      .toEqual({ state: "blocked", codex_thread_id: "thread-capability-fixed" });
    expect(await db.selectFrom("tasks").select(["state", "codex_thread_id"]).where("id", "=", second.taskId as string).executeTakeFirstOrThrow())
      .toEqual({ state: "waiting_input", codex_thread_id: "thread-capability-fixed" });
  });

  it("allows only one concurrent claim to lock a task and its chat context", async () => {
    await insertWorker();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const routed = await new MessageRouter(db).route(bot, {
      eventId: "ev_claim_lock", eventType: "im.message.receive_v1", messageId: "om_claim_lock",
      chatId: "oc_claim_lock", chatType: "p2p", rootMessageId: "om_claim_lock",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_claim_lock", botDialogueDepth: 0,
      messageType: "text", content: "claim", explicitlyActivated: true
    });
    const principal = { executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64) };
    const claims = await Promise.all([new ControlPlaneRepository(db, 60).claimTask(principal), new ControlPlaneRepository(db, 60).claimTask(principal)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.task.id).toBe(routed.taskId);
    expect(await db.selectFrom("tasks").select(["state", "attempt", "revision"]).where("id", "=", routed.taskId as string).executeTakeFirstOrThrow())
      .toMatchObject({ state: "running", attempt: 1, revision: 1 });
    expect(await db.selectFrom("task_events").selectAll().where("task_id", "=", routed.taskId as string).where("event_type", "=", "task.claimed").execute()).toHaveLength(1);
  });

  it("enforces executor capacity across concurrent task claims for different chat contexts", async () => {
    await insertWorker();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const routeTask = async (suffix: string) => new MessageRouter(db).route(bot, {
      eventId: `ev_capacity_${suffix}`, eventType: "im.message.receive_v1", messageId: `om_capacity_${suffix}`,
      chatId: `oc_capacity_${suffix}`, chatType: "p2p", rootMessageId: `om_capacity_${suffix}`,
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: `om_capacity_${suffix}`, botDialogueDepth: 0,
      messageType: "text", content: suffix, explicitlyActivated: true
    });
    const [first, second] = await Promise.all([routeTask("first"), routeTask("second")]);
    const principal = { executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64) };
    const claims = await Promise.all([new ControlPlaneRepository(db, 60).claimTask(principal), new ControlPlaneRepository(db, 60).claimTask(principal)]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect([first.taskId, second.taskId]).toContain(claims.find(Boolean)?.task.id);
    const states = await db.selectFrom("tasks").select(["id", "state"]).where("id", "in", [first.taskId as string, second.taskId as string]).execute();
    expect(states.filter((task) => task.state === "running")).toHaveLength(1);
    expect(states.filter((task) => task.state === "queued" || task.state === "waiting_worker")).toHaveLength(1);
  });

  it("lets only one concurrent task or workspace sync consume a capacity-one executor", async () => {
    await insertWorker();
    await enableWorkerWorkspaceMapping();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const routed = await new MessageRouter(db).route(bot, {
      eventId: "ev_task_sync_capacity", eventType: "im.message.receive_v1", messageId: "om_task_sync_capacity",
      chatId: "oc_task_sync_capacity", chatType: "p2p", rootMessageId: "om_task_sync_capacity",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_task_sync_capacity", botDialogueDepth: 0,
      messageType: "text", content: "task", explicitlyActivated: true
    });
    const syncContext = await insertSkillContext("oc_sync_capacity", "worker-a");
    const syncJob = await db.insertInto("skill_file_sync_jobs").values({
      chat_context_id: syncContext.id, executor_id: "worker-a", desired_fingerprint: "1".repeat(64),
      payload: JSON.stringify({ botAppId: "cli_bot", resolvedWorkspaceAlias: "repo", skills: [], skillSetFingerprint: "2".repeat(64), runtimeConfig: { fingerprint: "3".repeat(64), files: [] } }),
      state: "queued", updated_at: new Date()
    }).returning("id").executeTakeFirstOrThrow();
    const principal = { executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64), workspaceMappingFingerprint };
    const runtime = new SkillRuntimeService(db, config, services.adminEvents);
    const [taskClaim, syncClaim] = await Promise.all([
      new ControlPlaneRepository(db, 60).claimTask(principal),
      runtime.claimSyncJob(principal, 60)
    ]);

    expect([taskClaim, syncClaim].filter(Boolean)).toHaveLength(1);
    const taskState = await db.selectFrom("tasks").select("state").where("id", "=", routed.taskId as string).executeTakeFirstOrThrow();
    const syncState = await db.selectFrom("skill_file_sync_jobs").select("state").where("id", "=", syncJob.id).executeTakeFirstOrThrow();
    expect(Number(taskState.state === "running") + Number(syncState.state === "running")).toBe(1);
  });

  it("does not let an expired workspace-sync lease permanently consume executor capacity", async () => {
    await insertWorker();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const routed = await new MessageRouter(db).route(bot, {
      eventId: "ev_expired_sync_capacity", eventType: "im.message.receive_v1", messageId: "om_expired_sync_capacity",
      chatId: "oc_expired_sync_capacity", chatType: "p2p", rootMessageId: "om_expired_sync_capacity",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_expired_sync_capacity", botDialogueDepth: 0,
      messageType: "text", content: "task", explicitlyActivated: true
    });
    const syncContext = await insertSkillContext("oc_expired_sync_lease", "worker-a");
    await db.insertInto("skill_file_sync_jobs").values({
      chat_context_id: syncContext.id, executor_id: "worker-a", desired_fingerprint: "7".repeat(64), leased_fingerprint: "7".repeat(64),
      payload: JSON.stringify({}), leased_payload: JSON.stringify({}), state: "running", lease_token_hash: sha256("expired-sync-lease"),
      lease_expires_at: new Date(Date.now() - 60_000), attempt: 1, updated_at: new Date()
    }).execute();

    const claimed = await new ControlPlaneRepository(db, 60).claimTask({
      executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64)
    });
    expect(claimed?.task.id).toBe(routed.taskId);
  });

  it("rejects late Thread and result writes after the worker lease is cancelled", async () => {
    await insertWorker();
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const repository = new ControlPlaneRepository(db, 60);
    const routed = await new MessageRouter(db).route(bot, {
      eventId: "ev_late_lease", eventType: "im.message.receive_v1", messageId: "om_late_lease",
      chatId: "oc_late_lease", chatType: "p2p", rootMessageId: "om_late_lease",
      senderId: "ou_owner", senderRole: "owner", senderType: "user", senderBotId: null, senderDisplayName: "主人",
      ingressSource: "lark", originMessageId: "om_late_lease", botDialogueDepth: 0,
      messageType: "text", content: "late", explicitlyActivated: true
    });
    const claimed = await repository.claimTask({ executorId: "worker-a", homeRef: "worker-a:home", codexProfile: "lark-agent", configFingerprint: "a".repeat(64) });
    expect(claimed?.task.id).toBe(routed.taskId);
    await db.updateTable("tasks").set({ state: "cancelled", lease_token_hash: null, lease_expires_at: null, revision: sql`revision + 1`, updated_at: new Date() })
      .where("id", "=", routed.taskId as string).execute();
    const lease = { executorId: "worker-a", leaseToken: claimed?.leaseToken as string };

    await expect(repository.bindTaskThread(routed.taskId as string, "thread-too-late", lease))
      .rejects.toMatchObject({ code: "invalid_lease" });
    await expect(repository.finishTask(routed.taskId as string, "completed", "too late", undefined, lease))
      .rejects.toMatchObject({ code: "invalid_lease" });
    expect(await db.selectFrom("chat_contexts").select(["codex_thread_id", "state"]).where("chat_id", "=", "oc_late_lease").executeTakeFirstOrThrow())
      .toEqual({ codex_thread_id: null, state: "uninitialized" });
    expect(await db.selectFrom("tasks").select(["state", "codex_thread_id"]).where("id", "=", routed.taskId as string).executeTakeFirstOrThrow())
      .toEqual({ state: "cancelled", codex_thread_id: null });
  });

  it("reconciles unseen group main-stream messages before sending a draft", async () => {
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_test", chat_type: "group", root_message_id: "om_root", thread_id: null,
      room_seq: 1, active: true, response_message_id: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_root", state: "running", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, preferred_executor_id: null, executor_id: null, codex_thread_id: null,
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("processed_events").values({ event_id: "ev_root", event_type: "message", status: "processed", processed_at: new Date() }).execute();
    await db.insertInto("signals").values({
      conversation_id: conversation.id, task_id: task.id, event_id: "ev_root", seq: 1, message_id: "om_root", origin_message_id: "om_root",
      sender_id: "ou_owner", sender_role: "owner", message_type: "text", content: "start", preview: "start",
      priority: 90, decision: "consume", decision_rationale: null, decided_at: new Date()
    }).execute();
    const fakeLark = {
      listChatMessages: async () => ({
        messages: [{
          messageId: "om_unseen", rootId: null, parentId: null, threadId: null, chatId: "oc_test",
          senderId: "ou_owner", senderType: "user", messageType: "text", content: "late follow up",
          createTime: "2", mentions: []
        }],
        hasMore: false,
        pageToken: null
      })
    } as unknown as LarkGateway;

    const outputService = new TaskOutputService(db, { ...config, larkEnabled: true }, fakeLark);
    const result = await new DraftService(db, { ...config, larkEnabled: true }, fakeLark, outputService).submit(task.id, "answer", 1, false);

    expect(result.held).toBe(true);
    expect((await db.selectFrom("conversations").select("room_seq").where("id", "=", conversation.id).executeTakeFirstOrThrow()).room_seq).toBe(2);
    expect((await db.selectFrom("signals").select("content").where("message_id", "=", "om_unseen").executeTakeFirstOrThrow()).content).toBe("late follow up");
  });

  it("only allows the owner and protects simplified task commands with revision checks", async () => {
    const now = new Date();
    const session = async (token: string, openId: string, csrf: string) => {
      await db.insertInto("admin_sessions").values({
        token_hash: sha256(token), open_id: openId, display_name: "owner", role: "owner", csrf_token: csrf,
        last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
      }).execute();
    };
    await session("owner-token", "ou_owner", "owner-csrf");
    await session("operator-token", "ou_operator", "operator-csrf");
    await db.insertInto("workers").values({
      executor_id: "worker-a", display_name: "Worker A", home_ref: "worker-a:home", codex_profile: "lark-agent",
      config_fingerprint: "a".repeat(64), codex_version: "test", capacity: 1,
      workspace_aliases: JSON.stringify(["repo"]), capabilities: JSON.stringify(["codex", "app_handoff"]), last_seen_at: now, updated_at: now
    }).execute();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_test", chat_type: "group", root_message_id: "om_admin", thread_id: "omt_admin", room_seq: 1,
      active: true, response_message_id: null, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_admin", state: "failed", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: true, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo", preferred_executor_id: "worker-a", executor_id: "worker-a", codex_thread_id: "thread-1",
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test",
      lease_token_hash: null, lease_expires_at: null, summary: "sensitive summary", completed_at: now, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();

    const operatorDisable = await app.inject({
      method: "POST", url: "/v1/admin/workers/worker-a/commands",
      headers: { cookie: "lark_agent_admin_session=operator-token", "x-csrf-token": "operator-csrf" },
      payload: { command: "disable" }
    });
    expect(operatorDisable.statusCode).toBe(403);

    const retryPayload = { command: "retry", expectedRevision: task.revision };
    const retried = await app.inject({ method: "POST", url: `/v1/admin/tasks/${task.id}/commands`, headers: { cookie: "lark_agent_admin_session=owner-token", "x-csrf-token": "owner-csrf" }, payload: retryPayload });
    expect(retried.statusCode).toBe(200);
    expect(retried.json<{ state: string }>().state).toBe("waiting_worker");
    const duplicate = await app.inject({ method: "POST", url: `/v1/admin/tasks/${task.id}/commands`, headers: { cookie: "lark_agent_admin_session=owner-token", "x-csrf-token": "owner-csrf" }, payload: retryPayload });
    expect(duplicate.statusCode).toBe(409);
    const updated = await db.selectFrom("tasks").selectAll().where("id", "=", task.id).executeTakeFirstOrThrow();
    expect(updated.executor_home_ref).toBe("worker-a:home");
    expect(updated.executor_profile).toBe("lark-agent");
    expect(updated.codex_thread_id).toBe("thread-1");
    expect(updated.summary).toBe("后台操作：retry");
  });

  it("rejects retry for a task whose durable chat context is blocked", async () => {
    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("blocked-owner-token"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "blocked-owner-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_blocked_retry", chat_type: "p2p", root_message_id: "om_blocked_retry", thread_id: null, room_seq: 1,
      active: true, response_message_id: null, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
    await db.updateTable("chat_contexts").set({ state: "blocked", blocked_reason: "固定环境已变化", updated_at: now })
      .where("id", "=", conversation.chat_context_id).execute();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_blocked_retry", state: "waiting_input", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo", resolved_workspace_alias: "repo", preferred_executor_id: null, executor_id: null, codex_thread_id: "thread-blocked",
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: "固定环境已变化", completed_at: null, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/tasks/${task.id}/commands`,
      headers: { cookie: "lark_agent_admin_session=blocked-owner-token", "x-csrf-token": "blocked-owner-csrf" },
      payload: { command: "retry", expectedRevision: task.revision }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: "chat_context_blocked",
      message: expect.stringContaining("普通重试不会解除长期绑定")
    });
    expect(await db.selectFrom("tasks").select(["state", "revision"]).where("id", "=", task.id).executeTakeFirstOrThrow())
      .toEqual({ state: "waiting_input", revision: task.revision });

    const invalidId = await app.inject({
      method: "GET",
      url: "/v1/admin/chat-contexts/not-a-uuid",
      headers: { cookie: "lark_agent_admin_session=blocked-owner-token" }
    });
    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json<{ error: { code: string } }>().error.code).toBe("invalid_chat_context_id");

    const relatedTasks = await app.inject({
      method: "GET",
      url: `/v1/admin/tasks?chatContextId=${conversation.chat_context_id}`,
      headers: { cookie: "lark_agent_admin_session=blocked-owner-token" }
    });
    expect(relatedTasks.statusCode).toBe(200);
    expect(relatedTasks.json<{ items: Array<{ id: string; chat_context_id: string }> }>().items)
      .toEqual([expect.objectContaining({ id: task.id, chat_context_id: conversation.chat_context_id })]);

    const invalidRelatedTasks = await app.inject({
      method: "GET",
      url: "/v1/admin/tasks?chatContextId=not-a-uuid",
      headers: { cookie: "lark_agent_admin_session=blocked-owner-token" }
    });
    expect(invalidRelatedTasks.statusCode).toBe(400);
    expect(invalidRelatedTasks.json<{ error: { code: string } }>().error.code).toBe("invalid_chat_context_filter");
  });

  it("filters chat contexts before calculating a summary that is independent of the item limit", async () => {
    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("context-summary-owner"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "context-summary-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const createContext = async (chatId: string, chatType: "group" | "p2p", state: "uninitialized" | "ready" | "blocked") => {
      const conversation = await db.insertInto("conversations").values({
        chat_id: chatId, chat_type: chatType, root_message_id: `om_${chatId}`, thread_id: null, room_seq: 1,
        active: true, response_message_id: null, updated_at: now
      }).returning("chat_context_id").executeTakeFirstOrThrow();
      await db.updateTable("chat_contexts").set({ state, updated_at: now }).where("id", "=", conversation.chat_context_id).execute();
    };
    await createContext("oc_summary_blocked_group", "group", "blocked");
    await createContext("oc_summary_blocked_p2p", "p2p", "blocked");
    await createContext("oc_summary_ready_group", "group", "ready");
    await createContext("oc_summary_uninitialized_group", "group", "uninitialized");
    const headers = { cookie: "lark_agent_admin_session=context-summary-owner" };

    const blocked = await app.inject({ method: "GET", url: "/v1/admin/chat-contexts?state=blocked&limit=1", headers });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json<{ items: Array<{ state: string }>; summary: Record<string, number | string | null> }>()).toMatchObject({
      items: [{ state: "blocked" }],
      summary: { total: 2, ready: 0, blocked: 2, uninitialized: 0 }
    });

    const filtered = await app.inject({
      method: "GET",
      url: "/v1/admin/chat-contexts?bot=00000000-0000-0000-0000-000000000001&chatType=group&q=summary&limit=1",
      headers
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json<{ items: unknown[]; summary: Record<string, number | string | null> }>()).toMatchObject({
      items: [expect.any(Object)],
      summary: { total: 3, ready: 1, blocked: 1, uninitialized: 1, lastActivityAt: expect.any(String) }
    });
  });

  it("recovers a blocked chat context only after every fixed-environment check passes", async () => {
    const now = new Date();
    const fingerprint = "a".repeat(64);
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("context-recovery-owner"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "context-recovery-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    await insertWorker();
    await enableWorkerWorkspaceMapping();
    const createContext = async (chatId: string, expectedFingerprint: string | null, expectedMapping = workspaceMappingFingerprint) => {
      const conversation = await db.insertInto("conversations").values({
        chat_id: chatId, chat_type: "p2p", root_message_id: `om_${chatId}`, thread_id: null, room_seq: 1,
        active: true, response_message_id: null, updated_at: now
      }).returning(["id", "chat_context_id"]).executeTakeFirstOrThrow();
      if (expectedFingerprint !== null) {
        await db.updateTable("chat_contexts").set({
          codex_thread_id: `thread-${chatId}`,
          executor_id: "worker-a",
          executor_home_ref: "worker-a:home",
          executor_profile: "lark-agent",
          executor_config_fingerprint: expectedFingerprint,
          executor_workspace_mapping_fingerprint: expectedMapping,
          workspace_root_alias: "repo",
          state: "blocked",
          blocked_reason: "恢复前保持阻塞",
          updated_at: now
        }).where("id", "=", conversation.chat_context_id).execute();
      }
      return { contextId: conversation.chat_context_id, conversationId: conversation.id };
    };
    const recoverable = await createContext("oc_recoverable", fingerprint);
    const mismatched = await createContext("oc_recovery_mismatch", "b".repeat(64), "d".repeat(64));
    const replaced = await createContext("oc_recovery_replaced", fingerprint);
    const uninitializedContext = await createContext("oc_recovery_uninitialized", null);
    const recoverableId = recoverable.contextId;
    const mismatchedId = mismatched.contextId;
    const replacedId = replaced.contextId;
    const uninitializedId = uninitializedContext.contextId;
    const insertDifferentThreadTask = async (conversationId: string, triggerMessageId: string, createdAt: Date) => {
      await db.insertInto("tasks").values({
        conversation_id: conversationId,
        state: "completed",
        trigger_message_id: triggerMessageId,
        requester_id: "ou_owner",
        requester_role: "owner",
        authorization_grant: JSON.stringify({}),
        requested_workspace_alias: "repo",
        resolved_workspace_alias: "repo",
        preferred_executor_id: "worker-a",
        executor_id: "worker-a",
        codex_thread_id: `different-${triggerMessageId}`,
        executor_home_ref: "worker-a:home",
        executor_profile: "lark-agent",
        executor_config_fingerprint: fingerprint,
        codex_version: "test",
        lease_token_hash: null,
        lease_expires_at: null,
        summary: "historical task",
        created_at: createdAt,
        updated_at: createdAt,
        completed_at: createdAt
      }).execute();
    };
    await insertDifferentThreadTask(recoverable.conversationId, "om_legacy_thread", new Date(now.getTime() - 60_000));
    await insertDifferentThreadTask(replaced.conversationId, "om_replaced_thread", new Date(now.getTime() + 60_000));
    const cookie = { cookie: "lark_agent_admin_session=context-recovery-owner" };
    const headers = { ...cookie, "x-csrf-token": "context-recovery-csrf" };

    const missingCsrf = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${mismatchedId}/recover`, headers: cookie });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json<{ error: { code: string } }>().error.code).toBe("invalid_csrf");
    expect((await db.selectFrom("chat_context_recovery_attempts").select(sql<number>`count(*)::int`.as("count")).executeTakeFirstOrThrow()).count).toBe(0);

    const failed = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${mismatchedId}/recover`, headers });
    expect(failed.statusCode).toBe(200);
    const failedBody = failed.json<{ state: string; recovered: boolean; checks: Array<{ key: string; state: string }> }>();
    expect(failedBody).toMatchObject({ state: "blocked", recovered: false });
    expect(failedBody.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "workspaceMapping", state: "fail" }),
      expect.objectContaining({ key: "configFingerprint", state: "fail" })
    ]));
    expect(await db.selectFrom("chat_contexts").select(["state", "blocked_reason"]).where("id", "=", mismatchedId).executeTakeFirstOrThrow())
      .toEqual({ state: "blocked", blocked_reason: "恢复前保持阻塞" });
    expect(await db.selectFrom("chat_context_recovery_attempts").select(["actor_open_id", "result", "failed_check_keys"]).where("chat_context_id", "=", mismatchedId).executeTakeFirstOrThrow())
      .toEqual({ actor_open_id: "ou_owner", result: "check_failed", failed_check_keys: ["workspaceMapping", "configFingerprint"] });

    const replacedThread = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${replacedId}/recover`, headers });
    expect(replacedThread.statusCode).toBe(200);
    expect(replacedThread.json<{ state: string; recovered: boolean; checks: Array<{ key: string; state: string }> }>()).toMatchObject({
      state: "blocked",
      recovered: false,
      checks: expect.arrayContaining([expect.objectContaining({ key: "thread", state: "fail" })])
    });

    const recoveryEvents: Array<{ type: string; id?: string }> = [];
    const captureRecoveryEvent = (event: { type: string; id?: string }) => recoveryEvents.push(event);
    services.adminEvents.on("change", captureRecoveryEvent);
    const recovered = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${recoverableId}/recover`, headers });
    services.adminEvents.off("change", captureRecoveryEvent);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<{ state: string; recovered: boolean; checkedAt: string; checks: Array<{ state: string }> }>()).toMatchObject({
      state: "ready", recovered: true, checkedAt: expect.any(String), checks: expect.any(Array)
    });
    expect(recovered.json<{ checks: Array<{ state: string }> }>().checks.every((item) => item.state === "pass")).toBe(true);
    expect(recovered.body).not.toContain(fingerprint);
    expect(recovered.body).not.toContain("worker-a:home");
    expect(await db.selectFrom("chat_contexts").select(["state", "blocked_reason"]).where("id", "=", recoverableId).executeTakeFirstOrThrow())
      .toEqual({ state: "ready", blocked_reason: null });
    expect(recoveryEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "chat_context", id: recoverableId }),
      expect.objectContaining({ type: "task" })
    ]));
    const detail = await app.inject({ method: "GET", url: `/v1/admin/chat-contexts/${recoverableId}`, headers: cookie });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ executorConfigFingerprint: "已记录（值已隐藏）" });
    expect(detail.body).not.toContain(fingerprint);

    const idempotent = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${recoverableId}/recover`, headers });
    expect(idempotent.statusCode).toBe(200);
    expect(idempotent.json()).toMatchObject({ state: "ready", recovered: false });
    expect((await db.selectFrom("chat_context_recovery_attempts").select("result").where("chat_context_id", "=", recoverableId).orderBy("checked_at", "desc").execute()).map((item) => item.result))
      .toEqual(["already_ready", "recovered"]);

    const uninitialized = await app.inject({ method: "POST", url: `/v1/admin/chat-contexts/${uninitializedId}/recover`, headers });
    expect(uninitialized.statusCode).toBe(409);
    expect(uninitialized.json<{ error: { code: string } }>().error.code).toBe("chat_context_uninitialized");
    expect((await db.selectFrom("chat_context_recovery_attempts").select("result").where("chat_context_id", "=", uninitializedId).executeTakeFirstOrThrow()).result)
      .toBe("uninitialized");
  });

  it("serializes admin task commands on the bot and chat advisory lock and rereads revision", async () => {
    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("lock-owner-token"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "lock-owner-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_admin_lock", chat_type: "p2p", root_message_id: "om_admin_lock", thread_id: null, room_seq: 1,
      active: true, response_message_id: null, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_admin_lock", state: "failed", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo", resolved_workspace_alias: "repo", preferred_executor_id: null, executor_id: null, codex_thread_id: null,
      executor_home_ref: null, executor_profile: null, executor_config_fingerprint: null, codex_version: null,
      lease_token_hash: null, lease_expires_at: null, summary: "failed", completed_at: now, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${conversation.bot_id}:${conversation.chat_id}`]);
      let settled = false;
      const command = app.inject({
        method: "POST",
        url: `/v1/admin/tasks/${task.id}/commands`,
        headers: { cookie: "lark_agent_admin_session=lock-owner-token", "x-csrf-token": "lock-owner-csrf" },
        payload: { command: "retry", expectedRevision: task.revision }
      }).then((response) => { settled = true; return response; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      await client.query("UPDATE tasks SET revision = revision + 1, updated_at = now() WHERE id = $1", [task.id]);
      await client.query("COMMIT");
      transactionOpen = false;
      const response = await command;
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("revision_conflict");
    } finally {
      if (transactionOpen) await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("serializes task card actions and rejects a stale handoff after the worker has completed", async () => {
    const now = new Date();
    await db.insertInto("workers").values({
      executor_id: "worker-card-lock", display_name: "Worker Card Lock", home_ref: "worker-card-lock:home", codex_profile: "lark-agent",
      config_fingerprint: "c".repeat(64), codex_version: "test", capacity: 1,
      workspace_aliases: JSON.stringify(["repo"]), capabilities: JSON.stringify(["codex", "chat_context_v1", "app_handoff"]), last_seen_at: now, updated_at: now
    }).execute();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_card_lock", chat_type: "p2p", root_message_id: "om_card_lock", thread_id: null, room_seq: 1,
      active: true, response_message_id: null, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_card_lock", state: "running", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: "repo", resolved_workspace_alias: "repo", preferred_executor_id: "worker-card-lock", executor_id: "worker-card-lock", codex_thread_id: "thread-card-lock",
      executor_home_ref: "worker-card-lock:home", executor_profile: "lark-agent", executor_config_fingerprint: "c".repeat(64), codex_version: "test",
      lease_token_hash: sha256("card-lock-lease"), lease_expires_at: new Date(Date.now() + 60_000), summary: null, completed_at: null, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${conversation.bot_id}:${conversation.chat_id}`]);
      let settled = false;
      const cardAction = services.router.handleCardAction({
        type: "card.action.trigger",
        event_id: "event-card-lock",
        timestamp: String(Date.now()),
        operator_id: "ou_owner",
        message_id: "om_card_control",
        chat_id: conversation.chat_id,
        action_tag: "button",
        action_value: JSON.stringify({ action: "handoff", taskId: task.id }),
        token: "card-token"
      }).then(() => null, (error: unknown) => error).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      await client.query("UPDATE tasks SET state = 'completed', revision = revision + 1, completed_at = now(), lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1", [task.id]);
      await client.query("COMMIT");
      transactionOpen = false;
      const error = await cardAction;
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("handoff_unavailable");
      expect(await db.selectFrom("tasks").select(["state", "revision"]).where("id", "=", task.id).executeTakeFirstOrThrow())
        .toEqual({ state: "completed", revision: task.revision + 1 });
    } finally {
      if (transactionOpen) await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("aggregates inbox, task, draft and outbox data and diagnoses broken links", async () => {
    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("owner-flow-token"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "flow-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    await insertWorker();
    await db.updateTable("workers").set({ display_alias: "阿朱执行器" }).where("executor_id", "=", "worker-a").execute();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_test", chat_type: "group", root_message_id: "om_flow", thread_id: null, room_seq: 2,
      active: false, response_message_id: "om_reply", updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
    await db.updateTable("chat_contexts").set({ executor_id: "worker-a", updated_at: now }).where("id", "=", conversation.chat_context_id).execute();
    const task = await db.insertInto("tasks").values({
      conversation_id: conversation.id, trigger_message_id: "om_flow", state: "completed", requester_id: "ou_owner", requester_role: "owner",
      authorization_grant: JSON.stringify({ read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }),
      requested_workspace_alias: null, resolved_workspace_alias: "repo", preferred_executor_id: "worker-a", executor_id: "worker-a", codex_thread_id: null,
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test",
      lease_token_hash: null, lease_expires_at: null, summary: "flow complete", conversation_disposition: "complete", completed_at: now, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("processed_events").values({ event_id: "ev_flow", event_type: "im.message.receive_v1", status: "processed", received_at: now, processed_at: now }).execute();
    await db.insertInto("signals").values({
      conversation_id: conversation.id, task_id: task.id, event_id: "ev_flow", seq: 1, message_id: "om_flow", origin_message_id: "om_flow", sender_id: "ou_owner", sender_role: "owner",
      message_type: "text", content: "请检查完整链路", preview: "请检查完整链路", priority: 90, decision: "consume", decision_rationale: "主人明确请求", decided_at: now
    }).execute();
    const draft = await db.insertInto("drafts").values({
      task_id: task.id, conversation_id: conversation.id, base_room_seq: 1, observed_room_seq: 2, content: "检查完成", state: "sent", sent_at: now, updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("outbox_messages").values({
      task_id: task.id, draft_id: draft.id, target_message_id: "om_flow", content: "检查完成", idempotency_key: "flow-outbox-1", state: "sent",
      platform_message_id: null, attempt: 1, sent_at: now, updated_at: now
    }).execute();
    await db.insertInto("task_events").values([
      { task_id: task.id, event_type: "execution.started", summary: "开始正式执行", created_at: new Date(now.getTime() - 1_000) },
      { task_id: task.id, event_type: "execution.completed", summary: "正式执行完成", created_at: now }
    ]).execute();

    const headers = { cookie: "lark_agent_admin_session=owner-flow-token" };
    const inbox = await app.inject({ method: "GET", url: "/v1/admin/flow/items?view=inbox&range=all", headers });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json<{ items: Array<{ content: string; executor_display_name: string }> }>().items[0]).toMatchObject({ content: "请检查完整链路", executor_display_name: "阿朱执行器" });
    const flow = await app.inject({ method: "GET", url: "/v1/admin/flow/items?view=flow&range=all", headers });
    expect(flow.statusCode).toBe(200);
    expect(flow.json<{ items: Array<{ resolved_workspace_alias: string; executor_display_name: string }> }>().items[0]).toMatchObject({ resolved_workspace_alias: "repo", executor_display_name: "阿朱执行器" });
    const outbox = await app.inject({ method: "GET", url: "/v1/admin/flow/items?view=outbox&range=all", headers });
    expect(outbox.json<{ items: Array<{ content: string; executor_display_name: string }> }>().items[0]).toMatchObject({ content: "检查完成", executor_display_name: "阿朱执行器" });
    const tasks = await app.inject({ method: "GET", url: "/v1/admin/tasks", headers });
    expect(tasks.json<{ items: Array<{ executor_display_name: string }> }>().items[0]?.executor_display_name).toBe("阿朱执行器");
    const taskDetail = await app.inject({ method: "GET", url: `/v1/admin/tasks/${task.id}`, headers });
    expect(taskDetail.json()).toMatchObject({ executor_display_name: "阿朱执行器", worker: { display_name: "阿朱执行器", display_alias: "阿朱执行器", reported_display_name: "Worker A" } });
    const contextDetail = await app.inject({ method: "GET", url: `/v1/admin/chat-contexts/${conversation.chat_context_id}`, headers });
    expect(contextDetail.json()).toMatchObject({ executorId: "worker-a", executorDisplayName: "阿朱执行器" });
    const trace = await app.inject({ method: "GET", url: `/v1/admin/tasks/${task.id}/trace`, headers });
    expect(trace.statusCode).toBe(200);
    const traceBody = trace.json<{ task: { executor_display_name: string }; checks: Array<{ key: string; state: string; detail: string }>; stageTimings: Array<{ key: string; state: string }> }>();
    const checks = traceBody.checks;
    expect(checks.find((item) => item.key === "codex")?.state).toBe("错误");
    expect(checks.find((item) => item.key === "platform")?.state).toBe("错误");
    expect(checks.find((item) => item.key === "executor")?.detail).toContain("阿朱执行器（worker-a）");
    expect(traceBody.task.executor_display_name).toBe("阿朱执行器");
    expect(traceBody.stageTimings.find((item) => item.key === "first_commentary")?.state).toBe("skipped");
    expect(trace.body).not.toContain("lease_token_hash");
    expect(trace.body).not.toContain("authorization_grant");
  });

  it("turns the exact private /连接控制台 command into a one-time fragment link without creating a task", async () => {
    const replies: string[] = [];
    const details: LarkMessageDetails = {
      messageId: "om_connect", rootId: null, parentId: null, threadId: null, chatId: "oc_private", senderId: "ou_owner",
      senderType: "user", messageType: "text", content: "/连接控制台", createTime: "1", mentions: []
    };
    const replyChats: string[] = [];
    const fakeLark = {
      getMessage: async () => details,
      sendMarkdownToChat: async (chatId: string, markdown: string) => { replyChats.push(chatId); replies.push(markdown); return "om_reply"; }
    } as unknown as LarkGateway;
    const router = new EventRouter(db, { ...config, larkEnabled: true }, fakeLark, new ControlPlaneRepository(db, 60));
    await router.handleMessage({
      type: "im.message.receive_v1", event_id: "ev_connect", timestamp: "1", message_id: "om_connect", chat_id: "oc_private",
      chat_type: "p2p", sender_id: "ou_owner", message_type: "text", content: "/连接控制台", create_time: "1"
    });
    expect(await db.selectFrom("admin_login_tokens").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("processed_events").select("status").where("event_id", "=", "ev_connect").executeTakeFirst()).toEqual({ status: "admin_login" });
    expect(replies).toHaveLength(1);
    expect(replyChats).toEqual(["oc_private"]);
    expect(replies[0]).toContain("https://agent.example.test/lark-agent/admin/login#token=");
    expect(replies[0]).toContain("仅可使用一次");
  });

  it("handles /help and /帮助 directly without creating tasks", async () => {
    const replies: string[] = [];
    const commands = new Map([["om_help_en", "/help"], ["om_help_zh", "/帮助"]]);
    const fakeLark = {
      getMessage: async (messageId: string) => ({
        messageId, rootId: null, parentId: null, threadId: null, chatId: "oc_private", senderId: "ou_owner",
        senderType: "user", messageType: "text", content: commands.get(messageId) as string, createTime: "1", mentions: []
      }),
      sendMarkdownToChat: async (_chatId: string, markdown: string) => { replies.push(markdown); return `om_reply_${replies.length}`; }
    } as unknown as LarkGateway;
    const router = new EventRouter(db, { ...config, larkEnabled: true }, fakeLark, new ControlPlaneRepository(db, 60));
    for (const [messageId, content] of commands) {
      await router.handleMessage({
        type: "im.message.receive_v1", event_id: `ev_${messageId}`, timestamp: "1", message_id: messageId, chat_id: "oc_private",
        chat_type: "p2p", sender_id: "ou_owner", message_type: "text", content, create_time: "1"
      });
    }
    expect(replies).toHaveLength(2);
    expect(replies.every((reply) => reply.includes("/连接控制台") && reply.includes("/帮助") && reply.includes("/help"))).toBe(true);
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("admin_login_tokens").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("processed_events").select("status").where("status", "=", "command_help").execute()).toHaveLength(2);
  });

  it("consumes a Feishu-confirmed control token once and creates the long-lived admin session", async () => {
    const token = "one-time-control-token-0123456789abcdef";
    await db.insertInto("admin_login_tokens").values({
      token_hash: sha256(token), open_id: "ou_owner", role: "owner", expires_at: new Date(Date.now() + 120_000), consumed_at: null
    }).execute();
    const connected = await app.inject({ method: "POST", url: "/auth/lark/consume", payload: { token } });
    expect(connected.statusCode).toBe(200);
    const cookie = connected.headers["set-cookie"] as string;
    expect(cookie).toContain("lark_agent_admin_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/lark-agent");
    const me = await app.inject({ method: "GET", url: "/v1/admin/me", headers: { cookie: cookie.split(";")[0] as string } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ role: string }>().role).toBe("owner");
    expect((await app.inject({ method: "POST", url: "/auth/lark/consume", payload: { token } })).statusCode).toBe(401);
  });

  it("isolates the same group event by bot and fans ordinary follow-ups into every active bot inbox", async () => {
    const second = await db.insertInto("bots").values({
      app_id: "cli_bot_two", profile_name: "bot-two", bot_open_id: "cli_bot_two", display_name: "第二机器人",
      role_instructions: "以第二角色回答", owner_open_id: "ou_owner", default_executor_id: null, default_workspace_alias: null,
      enabled: true, is_system: false, config_revision: 1, credential_state: "verified", credential_error: null, deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("bot_chat_bindings").values({ bot_id: second.id, chat_id: "oc_test", chat_name: "测试群", enabled: true, preferred_executor_id: null, workspace_alias: null, updated_at: new Date() }).execute();
    const first = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    let details: LarkMessageDetails = {
      messageId: "om_both", rootId: null, parentId: null, threadId: null, chatId: "oc_test", senderId: "ou_owner", senderType: "user",
      messageType: "text", content: "@两个机器人 一起开始", createTime: "1",
      mentions: [{ id: "cli_bot", idType: "app_id", name: "Lark Agent" }, { id: "cli_bot_two", idType: "app_id", name: "第二机器人" }]
    };
    const fakeLark = { getMessage: async () => details } as unknown as LarkGateway;
    const firstRouter = new EventRouter(db, config, fakeLark, new ControlPlaneRepository(db, 60), first);
    const secondRouter = new EventRouter(db, config, fakeLark, new ControlPlaneRepository(db, 60), second);
    const event = (eventId: string, messageId: string): LarkMessageEvent => ({
      type: "im.message.receive_v1", event_id: eventId, timestamp: "1", message_id: messageId, chat_id: "oc_test", chat_type: "group",
      sender_id: "ou_owner", message_type: "text", content: details.content, create_time: "1"
    });

    await Promise.all([firstRouter.handleMessage(event("ev_shared", "om_both")), secondRouter.handleMessage(event("ev_shared", "om_both"))]);
    expect(await db.selectFrom("processed_events").selectAll().where("event_id", "=", "ev_shared").execute()).toHaveLength(2);
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(2);

    details = { ...details, messageId: "om_followup_all", content: "没有 at 的普通续聊", mentions: [] };
    await Promise.all([firstRouter.handleMessage(event("ev_followup_all", "om_followup_all")), secondRouter.handleMessage(event("ev_followup_all", "om_followup_all"))]);

    details = { ...details, messageId: "om_first_only", content: "@Lark Agent 只问你", mentions: [{ id: "cli_bot", idType: "app_id", name: "Lark Agent" }] };
    await Promise.all([firstRouter.handleMessage(event("ev_first_only", "om_first_only")), secondRouter.handleMessage(event("ev_first_only", "om_first_only"))]);
    const counts = await db.selectFrom("signals").select(["bot_id", sql<number>`count(*)::int`.as("count")]).groupBy("bot_id").orderBy("bot_id").execute();
    expect(counts).toEqual(expect.arrayContaining([{ bot_id: first.id, count: 3 }, { bot_id: second.id, count: 2 }]));
    expect(await db.selectFrom("processed_events").selectAll().where("bot_id", "=", second.id).where("event_id", "=", "ev_first_only").execute()).toHaveLength(0);
  });

  it("routes native registered-bot events by canonical app id, deduplicates them, and enforces the causal depth guard", async () => {
    const second = await db.insertInto("bots").values({
      app_id: "cli_bot_two", profile_name: "bot-two", bot_open_id: "cli_bot_two", display_name: "第二机器人",
      role_instructions: "以第二角色回答", owner_open_id: "ou_owner", default_executor_id: null, default_workspace_alias: null,
      enabled: true, is_system: false, config_revision: 1, credential_state: "verified", credential_error: null, deleted_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("bot_chat_bindings").values({ bot_id: second.id, chat_id: "oc_test", chat_name: "测试群", enabled: true, preferred_executor_id: null, workspace_alias: null, updated_at: new Date() }).execute();
    const first = await db.selectFrom("bots").selectAll().where("id", "=", "00000000-0000-0000-0000-000000000001").executeTakeFirstOrThrow();
    const details: LarkMessageDetails = {
      messageId: "om_human_origin", rootId: null, parentId: null, threadId: null, chatId: "oc_test", senderId: "ou_owner", senderType: "user",
      messageType: "text", content: "@Lark Agent @第二机器人 开始", createTime: "1",
      mentions: [{ id: first.app_id, idType: "app_id", name: first.display_name }, { id: second.app_id, idType: "app_id", name: second.display_name }]
    };
    const fakeLark = { getMessage: async () => details } as unknown as LarkGateway;
    const humanEvent: LarkMessageEvent = {
      type: "im.message.receive_v1", event_id: "ev_human_origin", timestamp: "1", message_id: details.messageId, chat_id: details.chatId,
      chat_type: "group", sender_id: details.senderId, message_type: "text", content: details.content, create_time: "1"
    };
    await Promise.all([
      new EventRouter(db, config, fakeLark, new ControlPlaneRepository(db, 60), first).handleMessage(humanEvent),
      new EventRouter(db, config, fakeLark, new ControlPlaneRepository(db, 60), second).handleMessage(humanEvent)
    ]);
    const sourceTask = await db.selectFrom("tasks").selectAll().where("bot_id", "=", first.id).executeTakeFirstOrThrow();
    await db.insertInto("task_outputs").values({
      task_id: sourceTask.id, conversation_id: sourceTask.conversation_id, card_id: "card-native", message_id: "om_bot_reply_1",
      visible_phase: "final", current_content: "1", current_content_hash: null, last_item_id: null,
      last_error: null, opened_at: new Date(), closed_at: new Date()
    }).execute();
    const guardMessages: string[] = [];
    const outbound = { sendMarkdownToChat: async (_chatId: string, content: string) => { guardMessages.push(content); return "om_guard_notice"; } } as unknown as LarkGateway;
    const guard = new BotDialogueGuardService(db, new BotGatewayRegistry(db, "lark-cli", outbound));
    const cardContent = (content: string) => JSON.stringify({
      body: { elements: [{ tag: "markdown", element_id: "answer", content }] },
      config: { summary: { content } },
      schema: "2.0"
    });
    const compatibilityPlaceholder = JSON.stringify({ title: null, elements: [[
      { tag: "img", image_key: "img_placeholder" },
      { tag: "text", text: "请升级至最新版本客户端，以查看内容" }
    ]] });
    let botDetails: LarkMessageDetails = {
      messageId: "om_bot_reply_1", rootId: null, parentId: null, threadId: null, chatId: "oc_test",
      senderId: first.app_id, senderType: "app", messageType: "interactive", content: cardContent("1"), rawContent: cardContent("1"),
      createTime: "2", mentions: []
    };
    const nativeLark = { getMessage: async () => botDetails } as unknown as LarkGateway;
    const secondRouter = new EventRouter(db, config, nativeLark, new ControlPlaneRepository(db, 60), second, new MessageRouter(db), guard);
    const botEvent = (eventId: string, messageId: string, content: string): LarkMessageEvent => ({
      type: "im.message.receive_v1", event_id: eventId, timestamp: "2", message_id: messageId, chat_id: "oc_test",
      chat_type: "group", sender_id: "ou_peer_scoped_sender", message_type: "interactive", content, create_time: "2"
    });
    await secondRouter.handleMessage(botEvent("ev_bot_reply_1", "om_bot_reply_1", compatibilityPlaceholder));
    await secondRouter.handleMessage(botEvent("ev_bot_reply_1", "om_bot_reply_1", compatibilityPlaceholder));
    const botSignal = await db.selectFrom("signals").selectAll().where("bot_id", "=", second.id).where("message_id", "=", "om_bot_reply_1").executeTakeFirstOrThrow();
    expect(botSignal).toMatchObject({ sender_id: "ou_peer_scoped_sender", sender_type: "bot", sender_bot_id: first.id, sender_display_name: first.display_name, sender_role: "member", ingress_source: "lark", origin_message_id: "om_human_origin", bot_dialogue_depth: 1, content: "1" });
    expect(await db.selectFrom("signals").selectAll().where("bot_id", "=", first.id).where("message_id", "=", "om_bot_reply_1").execute()).toHaveLength(0);
    expect(await db.selectFrom("signals").selectAll().where("bot_id", "=", second.id).where("message_id", "=", "om_bot_reply_1").execute()).toHaveLength(1);

    const secondConversation = await db.selectFrom("conversations").select("id").where("bot_id", "=", second.id).executeTakeFirstOrThrow();
    await db.updateTable("tasks").set({ state: "completed", completed_at: new Date(), updated_at: new Date() }).where("conversation_id", "=", secondConversation.id).execute();
    await db.updateTable("conversations").set({ active: false, followup_expires_at: null, updated_at: new Date() }).where("id", "=", secondConversation.id).execute();
    await db.updateTable("task_outputs").set({ message_id: "om_bot_reply_2", current_content: "@第二机器人 请继续" }).where("task_id", "=", sourceTask.id).execute();
    botDetails = { ...botDetails, messageId: "om_bot_reply_2", content: cardContent("@第二机器人 请继续"), rawContent: cardContent("@第二机器人 请继续"), mentions: [{ id: "ou_receiver_scoped", idType: "open_id", name: second.display_name }] };
    await secondRouter.handleMessage(botEvent("ev_bot_reply_2", "om_bot_reply_2", compatibilityPlaceholder));
    expect(await db.selectFrom("signals").selectAll().where("bot_id", "=", second.id).where("message_id", "=", "om_bot_reply_2").execute()).toHaveLength(1);
    expect(await db.selectFrom("conversations").selectAll().where("bot_id", "=", second.id).where("active", "=", true).execute()).toHaveLength(1);

    await db.updateTable("bot_dialogue_settings").set({ max_consecutive_depth: 1, updated_at: new Date() }).where("id", "=", 1).execute();
    await db.updateTable("task_outputs").set({ message_id: "om_guarded_1", current_content: "达到上限" }).where("task_id", "=", sourceTask.id).execute();
    botDetails = { ...botDetails, messageId: "om_guarded_1", content: cardContent("达到上限"), rawContent: cardContent("达到上限"), mentions: [] };
    await secondRouter.handleMessage(botEvent("ev_guarded_1", "om_guarded_1", compatibilityPlaceholder));
    await db.updateTable("task_outputs").set({ message_id: "om_guarded_2", current_content: "不会重复提示" }).where("task_id", "=", sourceTask.id).execute();
    botDetails = { ...botDetails, messageId: "om_guarded_2", content: cardContent("不会重复提示"), rawContent: cardContent("不会重复提示") };
    await secondRouter.handleMessage(botEvent("ev_guarded_2", "om_guarded_2", compatibilityPlaceholder));
    expect(guardMessages).toHaveLength(1);
    expect(await db.selectFrom("bot_dialogue_guards").selectAll().where("chat_id", "=", "oc_test").where("origin_message_id", "=", "om_human_origin").execute()).toHaveLength(1);
    expect(await db.selectFrom("outbox_messages").selectAll().where("operation_kind", "=", "bot_dialogue_guard").execute()).toHaveLength(1);
    expect(await db.selectFrom("signals").selectAll().where("message_id", "in", ["om_guarded_1", "om_guarded_2"]).execute()).toHaveLength(0);
  });

  it("protects Prometheus metrics with a dedicated bearer token", async () => {
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer metrics-test-token" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("lark_agent_tasks");
    expect(response.body).toContain("lark_agent_consumer_enabled");
    expect(response.body).toContain("lark_agent_consumer_required");
    expect(response.body).toContain("lark_agent_conversations_awaiting_followup");
    expect(response.body).toContain("lark_agent_followup_expired_total");
    expect(response.body).toContain("lark_agent_conversation_turns_total");
    expect(response.body).toContain("lark_agent_bot_message_events_total");
    expect(response.body).toContain("lark_agent_bot_dialogue_guard_total");
    expect(response.body).not.toContain("ou_owner");
  });

  it("returns ready when messages are ready and card actions are disabled", async () => {
    const runtime = new RuntimeStatus();
    runtime.configure("im.message.receive_v1", true, true);
    runtime.configure("card.action.trigger", false, false);
    runtime.ready("im.message.receive_v1");
    const instance = buildControlPlane(db, { ...config, larkEnabled: true }, undefined, { isLarkReady: () => runtime.requiredReady(), runtime }).app;
    expect((await instance.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    await instance.close();
  });

  it("returns ready when the optional card consumer is in error", async () => {
    const runtime = new RuntimeStatus();
    runtime.configure("im.message.receive_v1", true, true);
    runtime.configure("card.action.trigger", true, false);
    runtime.ready("im.message.receive_v1");
    runtime.error("card.action.trigger", new Error("not subscribed"));
    const instance = buildControlPlane(db, { ...config, larkEnabled: true, larkCardActionsEnabled: true }, undefined, { isLarkReady: () => runtime.requiredReady(), runtime }).app;
    expect((await instance.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    await instance.close();
  });

  it("returns 503 when the required message consumer is in error", async () => {
    const runtime = new RuntimeStatus();
    runtime.configure("im.message.receive_v1", true, true);
    runtime.configure("card.action.trigger", false, false);
    runtime.error("im.message.receive_v1", new Error("disconnected"));
    const instance = buildControlPlane(db, { ...config, larkEnabled: true }, undefined, { isLarkReady: () => runtime.requiredReady(), runtime }).app;
    expect((await instance.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
    await instance.close();
  });

  it("does not create an incident for a disabled card consumer", async () => {
    const runtime = new RuntimeStatus();
    runtime.configure("im.message.receive_v1", true, true);
    runtime.configure("card.action.trigger", false, false);
    runtime.ready("im.message.receive_v1");
    runtime.startedAt.setTime(Date.now() - 61_000);
    await new IncidentService(db, { ...config, larkEnabled: true }, {} as LarkGateway, runtime, new AdminEventBus()).evaluate();
    expect(await db.selectFrom("incidents").selectAll().where("related_id", "=", "card.action.trigger").execute()).toHaveLength(0);
  });

  it("creates only a warning when an enabled card consumer is unavailable", async () => {
    const runtime = new RuntimeStatus();
    runtime.configure("im.message.receive_v1", true, true);
    runtime.configure("card.action.trigger", true, false);
    runtime.ready("im.message.receive_v1");
    runtime.error("card.action.trigger", new Error("not subscribed"));
    runtime.startedAt.setTime(Date.now() - 61_000);
    await new IncidentService(db, { ...config, larkEnabled: true, larkCardActionsEnabled: true }, {} as LarkGateway, runtime, new AdminEventBus()).evaluate();
    const incident = await db.selectFrom("incidents").select(["severity", "title"]).where("related_id", "=", "card.action.trigger").executeTakeFirstOrThrow();
    expect(incident).toEqual({ severity: "warning", title: "飞书卡片操作不可用" });
  });

  it("creates a critical incident when the message consumer is unavailable", async () => {
    const runtime = new RuntimeStatus();
    runtime.configure("im.message.receive_v1", true, true);
    runtime.configure("card.action.trigger", false, false);
    runtime.error("im.message.receive_v1", new Error("disconnected"));
    runtime.startedAt.setTime(Date.now() - 61_000);
    await new IncidentService(db, { ...config, larkEnabled: true }, {} as LarkGateway, runtime, new AdminEventBus()).evaluate();
    const incident = await db.selectFrom("incidents").select(["severity", "title"]).where("related_id", "=", "im.message.receive_v1").executeTakeFirstOrThrow();
    expect(incident).toEqual({ severity: "critical", title: "飞书消息接入未就绪" });
  });
});
