import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import type { ControlPlaneConfig } from "./config.js";
import { buildControlPlane } from "./app.js";
import { EventRouter } from "./event-router.js";
import { ControlPlaneRepository } from "./repository.js";
import type { LarkGateway } from "../lark/gateway.js";
import type { LarkMessageDetails, LarkMessageEvent } from "../shared/contracts.js";
import { sha256 } from "../shared/crypto.js";
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
    traceRetentionDays: 180,
    leaseSeconds: 60,
    sessionMinutes: 60,
    adminOrigin: "https://agent.example.test/lark-agent",
    adminSessionHours: 12,
    adminIdleMinutes: 120,
    metricsBearerToken: "metrics-test-token",
    alertsEnabled: false,
    runnerArtifactPublicBaseUrl: "https://cdn.example.test/home/cdn/lark-agent",
    runnerManifestRefreshSeconds: 300
  };
  const { app, services } = buildControlPlane(db, config);
  const reconciledBotIds: string[] = [];
  registerBotAdminRoutes(app, db, config, {
    gateways: services.gateways,
    runtime: services.runtime,
    events: services.adminEvents,
    controller: {
      reconcile: async (botId) => { reconciledBotIds.push(botId); },
      suspend: async () => undefined
    }
  });
  const insertWorker = async () => db.insertInto("workers").values({
    executor_id: "worker-a", display_name: "Worker A", home_ref: "worker-a:home", codex_profile: "lark-agent",
    config_fingerprint: "a".repeat(64), codex_version: "test", capacity: 1,
    workspace_aliases: JSON.stringify(["repo"]), capabilities: JSON.stringify(["codex"]), last_seen_at: new Date(), updated_at: new Date()
  }).execute();

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
    await client.end();
  });

  beforeEach(async () => {
    reconciledBotIds.length = 0;
    await db.deleteFrom("admin_sessions").execute();
    await db.deleteFrom("admin_login_tokens").execute();
    await db.deleteFrom("incidents").execute();
    await db.deleteFrom("bot_dialogue_guards").execute();
    await db.deleteFrom("task_output_updates").execute();
    await db.deleteFrom("task_outputs").execute();
    await db.deleteFrom("outbox_messages").execute();
    await db.deleteFrom("drafts").execute();
    await db.deleteFrom("approvals").execute();
    await db.deleteFrom("task_events").execute();
    await db.deleteFrom("signals").execute();
    await db.deleteFrom("tasks").execute();
    await db.deleteFrom("conversations").execute();
    await db.deleteFrom("processed_events").execute();
    await db.deleteFrom("bot_owner_binding_tokens").execute();
    await db.deleteFrom("bot_chat_bindings").execute();
    await db.deleteFrom("worker_device_credentials").execute();
    await db.deleteFrom("worker_enrollment_tokens").execute();
    await db.deleteFrom("workers").execute();
    await db.deleteFrom("bots").where("id", "!=", "00000000-0000-0000-0000-000000000001").execute();
    await db.updateTable("bot_dialogue_settings").set({ max_consecutive_depth: 30, updated_at: new Date() }).where("id", "=", 1).execute();
    await db.updateTable("bots").set({ app_id: config.botAppId, bot_open_id: config.botAppId, display_name: config.agentDisplayName, owner_open_id: config.ownerOpenId, attention_model: null, attention_reasoning_effort: null, execution_model: null, execution_reasoning_effort: null, default_executor_id: null, default_workspace_alias: null, enabled: true, is_system: true, credential_state: "verified", deleted_at: null }).where("id", "=", "00000000-0000-0000-0000-000000000001").execute();
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

  it("does not require bootstrap identity after a bot has been imported", async () => {
    const withoutBootstrap = { ...config, ownerOpenId: "", botAppId: "", whitelistChatIds: new Set<string>() };
    await expect(bootstrapLegacyBot(db, withoutBootstrap)).resolves.toMatchObject({ app_id: "cli_bot", owner_open_id: "ou_owner" });
    await db.updateTable("bots").set({ app_id: "__legacy__", owner_open_id: null }).where("id", "=", "00000000-0000-0000-0000-000000000001").execute();
    await expect(bootstrapLegacyBot(db, withoutBootstrap)).rejects.toThrow("空数据库首次启动需要配置 BOT_APP_ID 和 OWNER_OPEN_ID");
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

  it("reports device status and lets the bound credential unregister itself", async () => {
    await insertWorker();
    const deviceToken = "device-token-self-unregister";
    await db.insertInto("worker_device_credentials").values({
      executor_id: "worker-a", credential_hash: sha256(deviceToken), last_used_at: null, revoked_at: null
    }).execute();

    const status = await app.inject({ method: "GET", url: "/v1/runner/status/worker-a", headers: { authorization: `Bearer ${deviceToken}` } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ executorId: "worker-a", activeTasks: 0, workspaceAliases: ["repo"], workspaceAliasesText: "repo" });

    const unregister = await app.inject({ method: "DELETE", url: "/v1/runner/credentials/current", headers: { authorization: `Bearer ${deviceToken}` } });
    expect(unregister.statusCode).toBe(204);
    const worker = await db.selectFrom("workers").select(["status", "operational_mode"]).where("executor_id", "=", "worker-a").executeTakeFirstOrThrow();
    expect(worker).toEqual({ status: "offline", operational_mode: "disabled" });
    expect((await db.selectFrom("worker_device_credentials").select("revoked_at").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
    expect((await app.inject({ method: "DELETE", url: "/v1/runner/credentials/current", headers: { authorization: `Bearer ${deviceToken}` } })).statusCode).toBe(401);
  });

  it("refuses device self-unregister while a task is running", async () => {
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

    const response = await app.inject({ method: "DELETE", url: "/v1/runner/credentials/current", headers: { authorization: `Bearer ${deviceToken}` } });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("worker_has_active_tasks");
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
    const removed = await app.inject({ method: "DELETE", url: "/v1/admin/workers/worker-a", headers });
    expect(removed.statusCode).toBe(200);
    expect((await db.selectFrom("workers").select("deleted_at").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).deleted_at).not.toBeNull();
    expect((await db.selectFrom("worker_device_credentials").select("revoked_at").where("executor_id", "=", "worker-a").executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
    expect((await db.selectFrom("tasks").select("executor_id").where("id", "=", task.id).executeTakeFirstOrThrow()).executor_id).toBe("worker-a");
    expect((await app.inject({ method: "GET", url: "/v1/admin/workers", headers })).json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it("binds a claimed task to the registered home/profile/fingerprint and holds a stale draft", async () => {
    const staticSession = await app.inject({
      method: "POST", url: "/v1/worker-sessions", headers: { authorization: "Bearer legacy-static-token" },
      payload: {
        executorId: "worker-a", displayName: "Worker A", homeRef: "worker-a:home", codexProfile: "lark-agent",
        configFingerprint: "a".repeat(64), codexVersion: "codex-cli test", capacity: 1,
        workspaceAliases: ["repo"], capabilities: ["codex"], runnerVersion: "0.1.1", architecture: "arm64", registrationSource: "quick_install"
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
          workspaceAliases: ["repo"], capabilities: ["codex"], runnerVersion: "0.1.0", architecture: "arm64", registrationSource: "quick_install"
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
          workspaceAliases: ["repo"], capabilities: ["codex"], runnerVersion: "0.1.0", architecture: "arm64", registrationSource: "quick_install"
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
        capabilities: ["codex"],
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
      priority: 90,
      decision: "pending",
      decision_rationale: null,
      decided_at: null
    }).execute();

    const claimResponse = await app.inject({ method: "POST", url: "/v1/tasks/claim", headers: { authorization: `Bearer ${sessionToken}` } });
    expect(claimResponse.statusCode).toBe(200);
    const claim = claimResponse.json<{ id: string; botAppId: string; leaseToken: string; chatType: string; turnIndex: number; triggerMessageId: string; attentionContext: string; requestedWorkspaceAlias: string | null; resolvedWorkspaceAlias: string }>();
    expect(claim.id).toBe(task.id);
    expect(claim).toMatchObject({ botAppId: "cli_bot", chatType: "group", turnIndex: 1, triggerMessageId: "om_root", requestedWorkspaceAlias: "repo", resolvedWorkspaceAlias: "repo" });
    expect(claim.attentionContext).toContain("首次激活回合");
    const claimedRow = await db.selectFrom("tasks").selectAll().where("id", "=", task.id).executeTakeFirstOrThrow();
    expect(claimedRow.executor_home_ref).toBe("worker-a:home");
    expect(claimedRow.executor_profile).toBe("lark-agent");
    expect(claimedRow.executor_config_fingerprint).toBe("a".repeat(64));
    expect(claimedRow.resolved_workspace_alias).toBe("repo");

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
      workspace_aliases: JSON.stringify(["repo", "docs"]), capabilities: JSON.stringify(["codex"]), last_seen_at: new Date(), updated_at: new Date()
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
      workspace_aliases: JSON.stringify(["repo"]), capabilities: JSON.stringify(["codex"]), last_seen_at: new Date(), updated_at: new Date()
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
    const final = await outputs.finalize(task.id, "最终答案", "draft-key");

    expect(final).toEqual({ messageId: "om_one", transport: "cardkit" });
    expect(calls).toEqual([
      { kind: "create_stream", content: "正在查询…" }, { kind: "send" },
      { kind: "update", sequence: 1, content: "新的回合" },
      { kind: "update", sequence: 2, content: "最终答案" }, { kind: "close", sequence: 3 }
    ]);
    const output = await db.selectFrom("task_outputs").selectAll().where("task_id", "=", task.id).executeTakeFirstOrThrow();
    expect(output).toMatchObject({ card_id: "card_one", message_id: "om_one", sequence: 3, state: "completed", visible_phase: "final", last_item_id: "comment_2" });
    expect(await db.selectFrom("task_output_updates").selectAll().where("task_id", "=", task.id).execute()).toHaveLength(5);
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
    const event = (eventId: string, messageId: string, content: string, senderId = "ou_member"): LarkMessageEvent => ({
      type: "im.message.receive_v1",
      event_id: eventId,
      timestamp: "1",
      message_id: messageId,
      chat_id: "oc_test",
      chat_type: "group",
      sender_id: senderId,
      message_type: "text",
      content,
      create_time: "1"
    });

    await router.handleMessage(event("ev_unrelated", "om_unrelated", "ordinary chat"));
    expect(await db.selectFrom("processed_events").select("status").where("event_id", "=", "ev_unrelated").executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("signals").selectAll().execute()).toHaveLength(0);

    details = { ...details, messageId: "om_activated", content: "@Lark Agent handle this", mentions: [{ id: "cli_bot", idType: "app_id", name: "Lark Agent" }] };
    await router.handleMessage(event("ev_activated", "om_activated", "@Lark Agent handle this", "ou_owner"));
    expect(getMessageCalls).toBe(1);
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

    const activeTask = await db.selectFrom("tasks").select("id").executeTakeFirstOrThrow();
    await new ControlPlaneRepository(db, 60).finishTask(activeTask.id, "completed", "done");
    expect((await db.selectFrom("conversations").select("active").where("id", "=", activatedConversation.id).executeTakeFirstOrThrow()).active).toBe(false);
    details = { ...details, messageId: "om_after", content: "ordinary after completion", mentions: [] };
    await router.handleMessage(event("ev_after", "om_after", "ordinary after completion"));
    expect(await db.selectFrom("signals").selectAll().execute()).toHaveLength(2);
    expect(await db.selectFrom("processed_events").select("event_id").where("event_id", "=", "ev_after").executeTakeFirst()).toBeUndefined();

    details = { ...details, messageId: "om_reactivate", content: "@Lark Agent next task", mentions: [{ id: "cli_bot", idType: "app_id", name: "Lark Agent" }] };
    await router.handleMessage(event("ev_reactivate", "om_reactivate", "@Lark Agent next task"));
    expect(await db.selectFrom("conversations").selectAll().execute()).toHaveLength(2);
    expect(await db.selectFrom("tasks").selectAll().execute()).toHaveLength(2);
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
      workspace_aliases: JSON.stringify(["repo"]), capabilities: JSON.stringify(["codex"]), last_seen_at: new Date(), updated_at: new Date()
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
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test"
    }).where("id", "=", first.id).execute();
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
      requested_workspace_alias: null, preferred_executor_id: "worker-a", executor_id: "worker-a", codex_thread_id: "thread-race",
      executor_home_ref: "worker-a:home", executor_profile: "lark-agent", executor_config_fingerprint: "a".repeat(64), codex_version: "test",
      lease_token_hash: null, lease_expires_at: null, summary: null, completed_at: null, updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
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

  it("aggregates inbox, task, draft and outbox data and diagnoses broken links", async () => {
    const now = new Date();
    await db.insertInto("admin_sessions").values({
      token_hash: sha256("owner-flow-token"), open_id: "ou_owner", display_name: "owner", role: "owner", csrf_token: "flow-csrf",
      last_seen_at: now, expires_at: new Date(Date.now() + 3_600_000)
    }).execute();
    await insertWorker();
    const conversation = await db.insertInto("conversations").values({
      chat_id: "oc_test", chat_type: "group", root_message_id: "om_flow", thread_id: null, room_seq: 2,
      active: false, response_message_id: "om_reply", updated_at: now
    }).returningAll().executeTakeFirstOrThrow();
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
    expect(inbox.json<{ items: Array<{ content: string }> }>().items[0]?.content).toBe("请检查完整链路");
    const flow = await app.inject({ method: "GET", url: "/v1/admin/flow/items?view=flow&range=all", headers });
    expect(flow.statusCode).toBe(200);
    expect(flow.json<{ items: Array<{ resolved_workspace_alias: string }> }>().items[0]?.resolved_workspace_alias).toBe("repo");
    const outbox = await app.inject({ method: "GET", url: "/v1/admin/flow/items?view=outbox&range=all", headers });
    expect(outbox.json<{ items: Array<{ content: string }> }>().items[0]?.content).toBe("检查完成");
    const trace = await app.inject({ method: "GET", url: `/v1/admin/tasks/${task.id}/trace`, headers });
    expect(trace.statusCode).toBe(200);
    const traceBody = trace.json<{ checks: Array<{ key: string; state: string }>; stageTimings: Array<{ key: string; state: string }> }>();
    const checks = traceBody.checks;
    expect(checks.find((item) => item.key === "codex")?.state).toBe("错误");
    expect(checks.find((item) => item.key === "platform")?.state).toBe("错误");
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
      visible_phase: "final", current_content: "第一机器人的最终回复", current_content_hash: null, last_item_id: null,
      last_error: null, opened_at: new Date(), closed_at: new Date()
    }).execute();
    const guardMessages: string[] = [];
    const outbound = { sendMarkdownToChat: async (_chatId: string, content: string) => { guardMessages.push(content); return "om_guard_notice"; } } as unknown as LarkGateway;
    const guard = new BotDialogueGuardService(db, new BotGatewayRegistry(db, "lark-cli", outbound));
    let botDetails: LarkMessageDetails = {
      messageId: "om_bot_reply_1", rootId: null, parentId: null, threadId: null, chatId: "oc_test",
      senderId: first.app_id, senderType: "app", messageType: "interactive", content: "第一机器人的最终回复",
      createTime: "2", mentions: []
    };
    const nativeLark = { getMessage: async () => botDetails } as unknown as LarkGateway;
    const secondRouter = new EventRouter(db, config, nativeLark, new ControlPlaneRepository(db, 60), second, new MessageRouter(db), guard);
    const botEvent = (eventId: string, messageId: string, content: string): LarkMessageEvent => ({
      type: "im.message.receive_v1", event_id: eventId, timestamp: "2", message_id: messageId, chat_id: "oc_test",
      chat_type: "group", sender_id: "ou_peer_scoped_sender", message_type: "interactive", content, create_time: "2"
    });
    await secondRouter.handleMessage(botEvent("ev_bot_reply_1", "om_bot_reply_1", botDetails.content));
    await secondRouter.handleMessage(botEvent("ev_bot_reply_1", "om_bot_reply_1", botDetails.content));
    const botSignal = await db.selectFrom("signals").selectAll().where("bot_id", "=", second.id).where("message_id", "=", "om_bot_reply_1").executeTakeFirstOrThrow();
    expect(botSignal).toMatchObject({ sender_id: "ou_peer_scoped_sender", sender_type: "bot", sender_bot_id: first.id, sender_display_name: first.display_name, sender_role: "member", ingress_source: "lark", origin_message_id: "om_human_origin", bot_dialogue_depth: 1 });
    expect(await db.selectFrom("signals").selectAll().where("bot_id", "=", first.id).where("message_id", "=", "om_bot_reply_1").execute()).toHaveLength(0);
    expect(await db.selectFrom("signals").selectAll().where("bot_id", "=", second.id).where("message_id", "=", "om_bot_reply_1").execute()).toHaveLength(1);

    const secondConversation = await db.selectFrom("conversations").select("id").where("bot_id", "=", second.id).executeTakeFirstOrThrow();
    await db.updateTable("tasks").set({ state: "completed", completed_at: new Date(), updated_at: new Date() }).where("conversation_id", "=", secondConversation.id).execute();
    await db.updateTable("conversations").set({ active: false, followup_expires_at: null, updated_at: new Date() }).where("id", "=", secondConversation.id).execute();
    await db.updateTable("task_outputs").set({ message_id: "om_bot_reply_2", current_content: "@第二机器人 请继续" }).where("task_id", "=", sourceTask.id).execute();
    botDetails = { ...botDetails, messageId: "om_bot_reply_2", content: "@第二机器人 请继续", mentions: [{ id: "ou_receiver_scoped", idType: "open_id", name: second.display_name }] };
    await secondRouter.handleMessage(botEvent("ev_bot_reply_2", "om_bot_reply_2", botDetails.content));
    expect(await db.selectFrom("signals").selectAll().where("bot_id", "=", second.id).where("message_id", "=", "om_bot_reply_2").execute()).toHaveLength(1);
    expect(await db.selectFrom("conversations").selectAll().where("bot_id", "=", second.id).where("active", "=", true).execute()).toHaveLength(1);

    await db.updateTable("bot_dialogue_settings").set({ max_consecutive_depth: 1, updated_at: new Date() }).where("id", "=", 1).execute();
    await db.updateTable("task_outputs").set({ message_id: "om_guarded_1", current_content: "达到上限" }).where("task_id", "=", sourceTask.id).execute();
    botDetails = { ...botDetails, messageId: "om_guarded_1", content: "达到上限", mentions: [] };
    await secondRouter.handleMessage(botEvent("ev_guarded_1", "om_guarded_1", botDetails.content));
    await db.updateTable("task_outputs").set({ message_id: "om_guarded_2", current_content: "不会重复提示" }).where("task_id", "=", sourceTask.id).execute();
    botDetails = { ...botDetails, messageId: "om_guarded_2", content: "不会重复提示" };
    await secondRouter.handleMessage(botEvent("ev_guarded_2", "om_guarded_2", botDetails.content));
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
