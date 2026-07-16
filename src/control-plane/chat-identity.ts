import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { errorMessage } from "../shared/errors.js";
import type { AdminEventBus } from "./admin-events.js";
import type { BotGatewayRegistry } from "./bot-runtime.js";
import type { LarkGateway } from "../lark/gateway.js";

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 15 * 60 * 1_000;

function cleanDisplayName(value: string | null): string | null {
  const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 128);
  return normalized || null;
}

export class ChatIdentityService {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly gateways: BotGatewayRegistry,
    private readonly events: AdminEventBus,
    private readonly log: { info(value: unknown, message: string): void; error(value: unknown, message: string): void }
  ) {}

  refresh(contextId: string, gateway?: LarkGateway): Promise<void> {
    const current = this.pending.get(contextId);
    if (current) return current;
    const task = this.refreshUnlocked(contextId, gateway).finally(() => this.pending.delete(contextId));
    this.pending.set(contextId, task);
    return task;
  }

  async backfill(concurrency = 5): Promise<void> {
    const contexts = await this.db.selectFrom("chat_contexts")
      .select("id")
      .where("chat_type", "=", "p2p")
      .where("peer_open_id", "is not", null)
      .orderBy("last_activity_at", "desc")
      .execute();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, contexts.length) }, async () => {
      while (cursor < contexts.length) {
        const item = contexts[cursor++];
        if (item) await this.refresh(item.id).catch(() => undefined);
      }
    });
    await Promise.all(workers);
    this.log.info({ contexts: contexts.length }, "chat identity backfill complete");
  }

  private async refreshUnlocked(contextId: string, suppliedGateway?: LarkGateway): Promise<void> {
    const context = await this.db.selectFrom("chat_contexts")
      .select(["id", "bot_id", "chat_type", "peer_open_id", "peer_display_name", "peer_identity_checked_at"])
      .where("id", "=", contextId)
      .executeTakeFirst();
    if (!context || context.chat_type !== "p2p" || !context.peer_open_id) return;
    const checkedAt = context.peer_identity_checked_at ? new Date(context.peer_identity_checked_at).getTime() : 0;
    const ttl = context.peer_display_name ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (checkedAt && Date.now() - checkedAt < ttl) return;

    const checked = new Date();
    try {
      const gateway = suppliedGateway ?? await this.gateways.gateway(context.bot_id);
      const displayName = cleanDisplayName(await gateway.getUserDisplayName(context.peer_open_id));
      await this.db.updateTable("chat_contexts").set({
        ...(displayName ? { peer_display_name: displayName } : {}),
        peer_identity_checked_at: checked,
        updated_at: checked
      }).where("id", "=", context.id).where("peer_open_id", "=", context.peer_open_id).execute();
      this.events.publish("chat_context", context.id);
    } catch (error) {
      await this.db.updateTable("chat_contexts").set({ peer_identity_checked_at: checked, updated_at: checked })
        .where("id", "=", context.id).where("peer_open_id", "=", context.peer_open_id).execute();
      this.log.error({ contextId, botId: context.bot_id, err: errorMessage(error) }, "chat identity refresh failed");
      this.events.publish("chat_context", context.id);
    }
  }
}
