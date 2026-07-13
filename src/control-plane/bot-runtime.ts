import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { LarkCardActionEvent, LarkMessageEvent } from "../shared/contracts.js";
import { AppError, errorMessage } from "../shared/errors.js";
import { LarkGateway } from "../lark/gateway.js";
import { NdjsonConsumer, runCommandWithInput, runJsonCommand } from "../lark/cli.js";
import type { ControlPlaneConfig } from "./config.js";
import { EventRouter } from "./event-router.js";
import type { ControlPlaneRepository } from "./repository.js";
import type { RuntimeStatus } from "./runtime-status.js";
import type { AdminEventBus } from "./admin-events.js";
import { legacyBotId, type BotRow } from "./bot-types.js";
import { MessageRouter } from "./message-router.js";
import type { BotDialogueGuardService } from "./bot-dialogue-guard.js";

const messageEventSchema = z.object({
  type: z.literal("im.message.receive_v1"), event_id: z.string(), timestamp: z.string(), message_id: z.string(), chat_id: z.string(),
  chat_type: z.enum(["p2p", "group"]), sender_id: z.string(), message_type: z.string(), content: z.string(), create_time: z.string()
});
const cardEventSchema = z.object({
  type: z.literal("card.action.trigger"), event_id: z.string(), timestamp: z.string(), operator_id: z.string(), message_id: z.string(),
  chat_id: z.string(), action_tag: z.string(), action_value: z.string(), token: z.string()
});

export class BotGatewayRegistry {
  private readonly gateways = new Map<string, LarkGateway>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly cliPath: string,
    private readonly fallback?: LarkGateway
  ) {}

  async bot(botId: string): Promise<BotRow> {
    return this.db.selectFrom("bots").selectAll().where("id", "=", botId).where("deleted_at", "is", null).executeTakeFirstOrThrow();
  }

  async gateway(botId: string): Promise<LarkGateway> {
    if (this.fallback) return this.fallback;
    const existing = this.gateways.get(botId);
    if (existing) return existing;
    const bot = await this.bot(botId);
    const gateway = new LarkGateway(this.cliPath, runJsonCommand, bot.profile_name);
    this.gateways.set(botId, gateway);
    return gateway;
  }

  async system(): Promise<{ bot: BotRow; gateway: LarkGateway } | null> {
    const bot = await this.db.selectFrom("bots").selectAll().where("is_system", "=", true).where("deleted_at", "is", null).executeTakeFirst();
    return bot ? { bot, gateway: await this.gateway(bot.id) } : null;
  }

  invalidate(botId: string): void {
    this.gateways.delete(botId);
  }
}

export class LarkProfileStore {
  private readonly configPath = join(homedir(), ".lark-cli", "config.json");
  private readonly secretsDir = join(homedir(), ".lark-cli", "secrets");

  constructor(private readonly cliPath: string) {}

  async add(profileName: string, appId: string, appSecret: string): Promise<void> {
    const result = await runCommandWithInput(this.cliPath, ["profile", "add", "--name", profileName, "--app-id", appId, "--app-secret-stdin", "--brand", "feishu", "--lang", "zh"], `${appSecret}\n`);
    if (result.exitCode !== 0) throw new AppError(`lark-cli 添加机器人失败：${result.stderr.trim() || result.stdout.trim()}`, 502, "lark_profile_error");
    try {
      await this.persistSecret(profileName, appSecret);
      await this.verify(profileName, appId);
    } catch (error) {
      await this.remove(profileName).catch(() => undefined);
      throw error;
    }
  }

  async rotate(profileName: string, appId: string, appSecret: string): Promise<void> {
    const secretPath = join(this.secretsDir, profileName);
    const previous = await readFile(secretPath, "utf8").catch(() => null);
    try {
      await this.persistSecret(profileName, appSecret);
      await this.verify(profileName, appId);
    } catch (error) {
      if (previous !== null) await this.persistSecret(profileName, previous);
      throw error;
    }
  }

  async verify(profileName: string | null, appId: string): Promise<void> {
    const args = [...(profileName ? ["--profile", profileName] : []), "whoami", "--as", "bot"];
    const identity = await runJsonCommand(this.cliPath, args) as { appId?: string; available?: boolean; tokenStatus?: string };
    if (identity.appId !== appId || identity.available !== true || identity.tokenStatus !== "ready") {
      throw new AppError("机器人凭据验证失败", 400, "bot_credentials_invalid");
    }
  }

  async remove(profileName: string | null): Promise<void> {
    if (!profileName) return;
    const result = await runCommandWithInput(this.cliPath, ["profile", "remove", profileName], "");
    if (result.exitCode !== 0 && !/not found/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new AppError(`lark-cli 删除机器人失败：${result.stderr.trim() || result.stdout.trim()}`, 502, "lark_profile_error");
    }
    await rm(join(this.secretsDir, profileName), { force: true });
  }

  private async persistSecret(profileName: string, appSecret: string): Promise<void> {
    await mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
    const secretPath = join(this.secretsDir, profileName);
    const secretTmp = `${secretPath}.tmp`;
    await writeFile(secretTmp, appSecret, { mode: 0o600 });
    await rename(secretTmp, secretPath);
    const config = JSON.parse(await readFile(this.configPath, "utf8")) as { apps?: Array<Record<string, unknown>> };
    const app = config.apps?.find((item) => item.name === profileName);
    if (!app) throw new AppError("lark-cli profile 写入后未找到配置", 500, "lark_profile_missing");
    app.appSecret = { source: "file", id: secretPath };
    const configTmp = `${this.configPath}.tmp`;
    await writeFile(configTmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(configTmp, this.configPath);
  }
}

export async function bootstrapLegacyBot(db: Kysely<Database>, config: ControlPlaneConfig): Promise<BotRow> {
  const existing = await db.selectFrom("bots").selectAll().where("app_id", "!=", "__legacy__").where("deleted_at", "is", null).executeTakeFirst();
  if (existing) return existing;
  if (!config.botAppId || !config.ownerOpenId) {
    throw new AppError("空数据库首次启动需要配置 BOT_APP_ID 和 OWNER_OPEN_ID", 500, "bot_bootstrap_config_missing");
  }
  const legacy = await db.updateTable("bots").set({
    app_id: config.botAppId,
    bot_open_id: config.botAppId,
    display_name: config.agentDisplayName,
    owner_open_id: config.ownerOpenId,
    enabled: config.larkEnabled,
    is_system: true,
    credential_state: "verified",
    credential_error: null,
    updated_at: new Date()
  }).where("id", "=", legacyBotId).returningAll().executeTakeFirstOrThrow();
  for (const chatId of config.whitelistChatIds) {
    await db.insertInto("bot_chat_bindings").values({ bot_id: legacy.id, chat_id: chatId, chat_name: null, enabled: true, preferred_executor_id: null, workspace_alias: null, updated_at: new Date() })
      .onConflict((conflict) => conflict.columns(["bot_id", "chat_id"]).doNothing()).execute();
  }
  return legacy;
}

interface BotRuntime {
  consumers: NdjsonConsumer[];
}

export class BotRuntimeManager {
  private readonly active = new Map<string, BotRuntime>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: ControlPlaneConfig,
    private readonly repository: ControlPlaneRepository,
    private readonly gateways: BotGatewayRegistry,
    private readonly runtime: RuntimeStatus,
    private readonly events: AdminEventBus,
    private readonly log: { info(value: unknown, message: string): void; error(value: unknown, message: string): void },
    private readonly messageRouter = new MessageRouter(db),
    private readonly dialogueGuard?: BotDialogueGuardService
  ) {}

  async startAll(): Promise<void> {
    const bots = await this.db.selectFrom("bots").selectAll().where("enabled", "=", true).where("credential_state", "=", "verified").where("deleted_at", "is", null).execute();
    await Promise.all(bots.map((bot) => this.start(bot)));
  }

  async reconcile(botId: string): Promise<void> {
    await this.stop(botId);
    this.gateways.invalidate(botId);
    const bot = await this.db.selectFrom("bots").selectAll().where("id", "=", botId).where("deleted_at", "is", null).executeTakeFirst();
    if (bot?.enabled && bot.credential_state === "verified") await this.start(bot);
  }

  async suspend(botId: string): Promise<void> {
    await this.stop(botId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((botId) => this.stop(botId)));
  }

  messageReady(): boolean {
    const statuses = this.runtime.snapshot();
    const enabled = Object.entries(statuses).filter(([key, status]) => key.endsWith(":message") && status.enabled);
    return enabled.length === 0 ? !this.config.larkEnabled : enabled.some(([, status]) => status.ready);
  }

  private async start(bot: BotRow): Promise<void> {
    if (this.active.has(bot.id) || !this.config.larkEnabled) return;
    const gateway = await this.gateways.gateway(bot.id);
    const router = new EventRouter(this.db, this.config, gateway, this.repository, bot, this.messageRouter, this.dialogueGuard);
    const consumers: NdjsonConsumer[] = [];
    const messageKey = `${bot.id}:message`;
    this.runtime.configure(messageKey, true, false);
    consumers.push(new NdjsonConsumer(this.config.larkCliPath, "im.message.receive_v1", async (value) => {
      await router.handleMessage(messageEventSchema.parse(value) as LarkMessageEvent);
    }, () => this.ready(bot.id, messageKey), (error) => this.failed(bot.id, messageKey, error), bot.profile_name));
    if (this.config.larkCardActionsEnabled) {
      const cardKey = `${bot.id}:card`;
      this.runtime.configure(cardKey, true, false);
      consumers.push(new NdjsonConsumer(this.config.larkCliPath, "card.action.trigger", async (value) => {
        await router.handleCardAction(cardEventSchema.parse(value) as LarkCardActionEvent);
      }, () => this.ready(bot.id, cardKey), (error) => this.failed(bot.id, cardKey, error), bot.profile_name));
    }
    this.active.set(bot.id, { consumers });
    consumers.forEach((consumer) => consumer.start());
  }

  private async stop(botId: string): Promise<void> {
    const current = this.active.get(botId);
    if (!current) return;
    this.active.delete(botId);
    await Promise.all(current.consumers.map((consumer) => consumer.stop()));
    this.runtime.configure(`${botId}:message`, false, false);
    this.runtime.configure(`${botId}:card`, false, false);
  }

  private ready(botId: string, key: string): void {
    this.runtime.ready(key);
    this.events.publish("bot", botId);
    this.log.info({ botId, eventKey: key }, "lark bot consumer ready");
  }

  private failed(botId: string, key: string, error: Error): void {
    this.runtime.error(key, error);
    this.events.publish("bot", botId);
    this.log.error({ botId, eventKey: key, err: errorMessage(error) }, "lark bot consumer error");
  }
}
