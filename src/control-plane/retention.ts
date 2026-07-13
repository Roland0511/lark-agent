import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";

export class RetentionService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly messageDays: number,
    private readonly traceDays: number
  ) {}

  async runOnce(): Promise<void> {
    const messageCutoff = new Date(Date.now() - this.messageDays * 86_400_000);
    const traceCutoff = new Date(Date.now() - this.traceDays * 86_400_000);
    await this.db.updateTable("signals").set({ content: "[expired]", preview: "[expired]" }).where("created_at", "<", messageCutoff).where("content", "!=", "[expired]").execute();
    await this.db.updateTable("drafts").set({ content: "[expired]", updated_at: new Date() }).where("created_at", "<", messageCutoff).where("content", "!=", "[expired]").execute();
    await this.db.updateTable("outbox_messages").set({ content: "[expired]", updated_at: new Date() }).where("created_at", "<", messageCutoff).where("content", "!=", "[expired]").execute();
    await this.db.updateTable("task_outputs").set({ current_content: "[expired]", updated_at: new Date() }).where("created_at", "<", messageCutoff).where("current_content", "is not", null).where("current_content", "!=", "[expired]").execute();
    await this.db.updateTable("task_output_updates").set({ content: "[expired]", updated_at: new Date() }).where("created_at", "<", messageCutoff).where("content", "is not", null).where("content", "!=", "[expired]").execute();
    await this.db.updateTable("task_events").set({ payload: JSON.stringify({}) }).where("created_at", "<", messageCutoff).execute();
    await this.db.deleteFrom("action_receipts").where("created_at", "<", traceCutoff).execute();
    await this.db.deleteFrom("task_events").where("created_at", "<", traceCutoff).execute();
    await this.db.deleteFrom("admin_sessions").where("expires_at", "<", new Date()).execute();
    await this.db.deleteFrom("admin_login_tokens").where("expires_at", "<", new Date()).execute();
  }
}
