import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";

export interface BotMessageContext {
  sourceTaskId: string;
  originMessageId: string;
  botDialogueDepth: number;
}

export async function botMessageContextForPlatformMessage(
  db: Kysely<Database>,
  senderBotId: string,
  messageId: string
): Promise<BotMessageContext | null> {
  const output = await db.selectFrom("task_outputs")
    .innerJoin("tasks", "tasks.id", "task_outputs.task_id")
    .select("tasks.id")
    .where("tasks.bot_id", "=", senderBotId)
    .where("task_outputs.message_id", "=", messageId)
    .executeTakeFirst();
  if (!output) return null;

  const signals = await db.selectFrom("signals")
    .select(["origin_message_id", "bot_dialogue_depth", "sender_type", "message_id"])
    .where("task_id", "=", output.id)
    .orderBy("seq")
    .execute();
  const latestUser = signals.filter((signal) => signal.sender_type === "user").at(-1);
  if (latestUser) {
    return { sourceTaskId: output.id, originMessageId: latestUser.message_id, botDialogueDepth: 1 };
  }
  const deepest = signals.toSorted((a, b) => b.bot_dialogue_depth - a.bot_dialogue_depth)[0];
  return deepest
    ? { sourceTaskId: output.id, originMessageId: deepest.origin_message_id, botDialogueDepth: deepest.bot_dialogue_depth + 1 }
    : null;
}
