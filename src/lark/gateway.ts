import type { LarkMessageDetails } from "../shared/contracts.js";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { AppError } from "../shared/errors.js";
import type { StoredAttachment } from "./attachments.js";
import { sanitizeAttachmentFileName } from "./attachments.js";
import { runCommand, runJsonCommand, type CommandResult } from "./cli.js";

interface LarkEnvelope {
  data?: { items?: unknown[]; messages?: unknown[]; scopes?: unknown[]; message_id?: string; card_id?: string; has_more?: boolean; page_token?: string; name?: string; user?: unknown };
  items?: unknown[];
  messages?: unknown[];
  message_id?: string;
  chat_id?: string;
}

function parseContent(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text : value;
    } catch {
      return value;
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") return parseContent(record.content);
    return JSON.stringify(value);
  }
  return "";
}

function normalizeMessage(item: unknown): LarkMessageDetails | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
  const sender = (value.sender ?? {}) as Record<string, unknown>;
  const body = (value.body ?? {}) as Record<string, unknown>;
  const messageId = String(value.message_id ?? value.id ?? "");
  if (!messageId) return null;
  const mentions = Array.isArray(value.mentions)
    ? value.mentions.map((mention) => {
        const data = mention as Record<string, unknown>;
        return { id: String(data.id ?? ""), idType: String(data.id_type ?? ""), name: String(data.name ?? "") };
      })
    : [];
  const rawValue = body.content ?? value.content;
  const rawContent = typeof rawValue === "string" ? rawValue : rawValue == null ? "" : JSON.stringify(rawValue);
  return {
    messageId,
    rootId: value.root_id ? String(value.root_id) : null,
    parentId: value.parent_id ? String(value.parent_id) : null,
    threadId: value.thread_id ? String(value.thread_id) : null,
    chatId: String(value.chat_id ?? ""),
    senderId: String(sender.id ?? value.sender_id ?? ""),
    senderType: String(sender.sender_type ?? value.sender_type ?? "unknown"),
    messageType: String(value.msg_type ?? value.message_type ?? "text"),
    content: parseContent(rawValue),
    rawContent,
    createTime: String(value.create_time ?? "0"),
    mentions
  };
}

function messagesFromEnvelope(envelope: unknown): LarkMessageDetails[] {
  const value = envelope as LarkEnvelope;
  const items = value?.data?.items ?? value?.data?.messages ?? value?.items ?? value?.messages ?? [];
  return items.map(normalizeMessage).filter((item): item is LarkMessageDetails => Boolean(item));
}

export class LarkGateway {
  constructor(
    private readonly cliPath = "lark-cli",
    private readonly run: (command: string, args: string[]) => Promise<unknown> = runJsonCommand,
    private readonly profileName?: string | null,
    private readonly runFile: (command: string, args: string[], env?: NodeJS.ProcessEnv, options?: { cwd?: string; maxOutputDirectory?: string; maxOutputBytes?: number }) => Promise<CommandResult> = runCommand
  ) {}

  private args(args: string[]): string[] {
    return this.profileName ? ["--profile", this.profileName, ...args] : args;
  }

  private invoke(args: string[]): Promise<unknown> {
    return this.run(this.cliPath, this.args(args));
  }

  async listGrantedScopes(): Promise<string[]> {
    const envelope = (await this.invoke([
      "api", "GET", "/open-apis/application/v6/scopes", "--as", "bot", "--format", "json"
    ])) as LarkEnvelope;
    const scopes = (envelope.data?.scopes ?? []).flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const item = raw as Record<string, unknown>;
      return Number(item.grant_status) === 1 && typeof item.scope_name === "string" ? [item.scope_name] : [];
    });
    return [...new Set(scopes)].sort();
  }

  async getMessage(messageId: string): Promise<LarkMessageDetails> {
    const envelope = await this.invoke([
      "api",
      "GET",
      `/open-apis/im/v1/messages/${messageId}`,
      "--as",
      "bot",
      "--params",
      JSON.stringify({ user_id_type: "open_id" })
    ]);
    const message = messagesFromEnvelope(envelope)[0];
    if (!message) throw new Error(`message ${messageId} was not returned by Lark`);
    return message;
  }

  async getUserDisplayName(openId: string): Promise<string | null> {
    const envelope = (await this.invoke([
      "api", "GET", `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
      "--as", "bot", "--params", JSON.stringify({ user_id_type: "open_id" }), "--format", "json"
    ])) as LarkEnvelope;
    const user = envelope.data?.user;
    if (!user || typeof user !== "object") return null;
    const name = (user as Record<string, unknown>).name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  }

  async downloadMessageResource(
    messageId: string,
    attachment: StoredAttachment,
    maxBytes: number
  ): Promise<{ path: string; size: number; fileName: string; stream: ReturnType<typeof createReadStream>; cleanup(): Promise<void> }> {
    const directory = await mkdtemp(join(tmpdir(), "lark-agent-resource-"));
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    };
    try {
      const requestedFileName = sanitizeAttachmentFileName(attachment.fileName, attachment.type === "image" ? "image" : "attachment");
      const result = await this.runFile(this.cliPath, this.args([
        "im", "+messages-resources-download",
        "--message-id", messageId,
        "--file-key", attachment.resourceKey,
        "--type", attachment.type,
        "--as", "bot",
        "--output", requestedFileName
      ]), process.env, { cwd: directory, maxOutputDirectory: directory, maxOutputBytes: maxBytes });
      if (result.limitExceeded) throw new AppError("attachment exceeds the per-file limit", 413, "attachment_too_large");
      if (result.exitCode !== 0) throw new AppError("Lark attachment download failed", 502, "attachment_download_failed");
      const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.isSymbolicLink());
      const selected = entries.find((entry) => entry.name === requestedFileName) ?? (entries.length === 1 ? entries[0] : null);
      const fileName = selected ? sanitizeAttachmentFileName(selected.name, requestedFileName) : "";
      const path = fileName ? await realpath(join(directory, fileName)).catch(() => "") : "";
      const child = path ? relative(await realpath(directory), path) : "";
      if (!path || !child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new AppError("Lark attachment output path is invalid", 502, "attachment_output_invalid");
      }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new AppError("Lark attachment output is not a regular file", 502, "attachment_output_invalid");
      if (info.size > maxBytes) throw new AppError("attachment exceeds the per-file limit", 413, "attachment_too_large");
      return { path, size: info.size, fileName, stream: createReadStream(path), cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async getChatName(chatId: string): Promise<string | null> {
    const envelope = (await this.invoke([
      "im", "chats", "get", "--chat-id", chatId, "--as", "bot", "--format", "json"
    ])) as LarkEnvelope;
    return envelope.data?.name || null;
  }

  async listJoinedChats(): Promise<Array<{ chatId: string; name: string }>> {
    const result: Array<{ chatId: string; name: string }> = [];
    let pageToken: string | undefined;
    do {
      const envelope = (await this.invoke([
        "api", "GET", "/open-apis/im/v1/chats", "--as", "bot",
        "--params", JSON.stringify({ page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) })
      ])) as LarkEnvelope;
      for (const raw of envelope.data?.items ?? []) {
        const item = raw as Record<string, unknown>;
        const chatId = String(item.chat_id ?? "");
        if (chatId) result.push({ chatId, name: String(item.name ?? chatId) });
      }
      pageToken = envelope.data?.has_more && envelope.data.page_token ? envelope.data.page_token : undefined;
    } while (pageToken && result.length < 500);
    return result.slice(0, 500);
  }

  async listChatMessages(
    chatId: string,
    start: Date,
    end: Date,
    pageToken?: string
  ): Promise<{ messages: LarkMessageDetails[]; hasMore: boolean; pageToken: string | null }> {
    const args = [
      "im",
      "+chat-messages-list",
      "--chat-id",
      chatId,
      "--order",
      "desc",
      "--page-size",
      "50",
      "--start",
      start.toISOString(),
      "--end",
      end.toISOString(),
      "--no-reactions",
      "--as",
      "bot",
      "--format",
      "json"
    ];
    if (pageToken) args.push("--page-token", pageToken);
    const envelope = (await this.invoke(args)) as LarkEnvelope;
    return {
      messages: messagesFromEnvelope(envelope),
      hasMore: envelope.data?.has_more === true,
      pageToken: envelope.data?.page_token || null
    };
  }

  async sendMarkdownToChat(chatId: string, markdown: string, idempotencyKey: string): Promise<string> {
    const envelope = (await this.invoke([
      "im",
      "+messages-send",
      "--chat-id",
      chatId,
      "--markdown",
      markdown,
      "--idempotency-key",
      idempotencyKey,
      "--as",
      "bot",
      "--format",
      "json"
    ])) as LarkEnvelope;
    return String(envelope.message_id ?? envelope.data?.message_id ?? "");
  }

  async replyMarkdownToMessage(messageId: string, markdown: string, idempotencyKey: string): Promise<string> {
    const envelope = (await this.invoke([
      "im",
      "+messages-reply",
      "--message-id",
      messageId,
      "--markdown",
      markdown,
      "--idempotency-key",
      idempotencyKey,
      "--as",
      "bot",
      "--format",
      "json"
    ])) as LarkEnvelope;
    return String(envelope.message_id ?? envelope.data?.message_id ?? "");
  }

  async sendCardToChat(chatId: string, card: Record<string, unknown>, idempotencyKey: string): Promise<string> {
    const envelope = (await this.invoke([
      "im",
      "+messages-send",
      "--chat-id",
      chatId,
      "--msg-type",
      "interactive",
      "--content",
      JSON.stringify(card),
      "--idempotency-key",
      idempotencyKey,
      "--as",
      "bot",
      "--format",
      "json"
    ])) as LarkEnvelope;
    return String(envelope.message_id ?? envelope.data?.message_id ?? "");
  }

  async createCardEntity(content: string, streaming: boolean): Promise<string> {
    const envelope = (await this.invoke([
      "api", "POST", "/open-apis/cardkit/v1/cards", "--as", "bot",
      "--data", JSON.stringify({ type: "card_json", data: JSON.stringify(replyCard(content, streaming)) })
    ])) as LarkEnvelope;
    const cardId = String(envelope.data?.card_id ?? "");
    if (!cardId) throw new Error("Lark CardKit did not return card_id");
    return cardId;
  }

  async sendCardEntityToChat(chatId: string, cardId: string, idempotencyKey: string): Promise<string> {
    const envelope = (await this.invoke([
      "api", "POST", "/open-apis/im/v1/messages", "--as", "bot",
      "--params", JSON.stringify({ receive_id_type: "chat_id" }),
      "--data", JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
        uuid: idempotencyKey
      })
    ])) as LarkEnvelope;
    const messageId = String(envelope.message_id ?? envelope.data?.message_id ?? "");
    if (!messageId) throw new Error("Lark did not return message_id for CardKit entity");
    return messageId;
  }

  async replyCardEntityToMessage(messageId: string, cardId: string, idempotencyKey: string): Promise<string> {
    const envelope = (await this.invoke([
      "im", "+messages-reply",
      "--message-id", messageId,
      "--msg-type", "interactive",
      "--content", JSON.stringify({ type: "card", data: { card_id: cardId } }),
      "--idempotency-key", idempotencyKey,
      "--as", "bot",
      "--format", "json"
    ])) as LarkEnvelope;
    const replyMessageId = String(envelope.message_id ?? envelope.data?.message_id ?? "");
    if (!replyMessageId) throw new Error("Lark did not return message_id for CardKit reply");
    return replyMessageId;
  }

  async streamCardContent(cardId: string, elementId: string, content: string, sequence: number, requestUuid: string): Promise<void> {
    await this.invoke([
      "api", "PUT", `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`, "--as", "bot",
      "--data", JSON.stringify({ content, sequence, uuid: requestUuid })
    ]);
  }

  async closeCardStream(cardId: string, summary: string, sequence: number, requestUuid: string): Promise<void> {
    await this.invoke([
      "api", "PATCH", `/open-apis/cardkit/v1/cards/${cardId}/settings`, "--as", "bot",
      "--data", JSON.stringify({
        settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }),
        sequence,
        uuid: requestUuid
      })
    ]);
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.invoke([
      "api",
      "PATCH",
      `/open-apis/im/v1/messages/${messageId}`,
      "--as",
      "bot",
      "--data",
      JSON.stringify({ content: JSON.stringify(card) })
    ]);
  }

  async sendCardToOpenId(openId: string, card: Record<string, unknown>, idempotencyKey: string): Promise<string> {
    const envelope = (await this.invoke([
      "api", "POST", "/open-apis/im/v1/messages", "--as", "bot",
      "--params", JSON.stringify({ receive_id_type: "open_id" }),
      "--data", JSON.stringify({ receive_id: openId, msg_type: "interactive", content: JSON.stringify(card), uuid: idempotencyKey })
    ])) as LarkEnvelope;
    return String(envelope.message_id ?? envelope.data?.message_id ?? "");
  }
}

export function replyCard(content: string, streaming: boolean): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: streaming,
      summary: { content: streaming ? "[生成中...]" : previewSummary(content) },
      ...(streaming ? {
        streaming_config: {
          print_frequency_ms: { default: 70, android: 70, ios: 70, pc: 70 },
          print_step: { default: 1, android: 1, ios: 1, pc: 1 },
          print_strategy: "fast"
        }
      } : {})
    },
    body: { elements: [{ tag: "markdown", element_id: "answer", content }] }
  };
}

export function previewSummary(content: string): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.slice(0, 80) || "Lark Agent 回复";
}
