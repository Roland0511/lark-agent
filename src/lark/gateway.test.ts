import { describe, expect, it } from "vitest";
import { LarkGateway } from "./gateway.js";

describe("LarkGateway main-chat messaging", () => {
  it("lists only granted application scopes with the selected bot profile", async () => {
    const calls: string[][] = [];
    const gateway = new LarkGateway("lark-cli", async (_command, args) => {
      calls.push(args);
      return { data: { scopes: [
        { scope_name: "im:message", grant_status: 1 },
        { scope_name: "cardkit:card:write", grant_status: 2 },
        { scope_name: "im:message", grant_status: 1 }
      ] } };
    }, "bot-profile");
    await expect(gateway.listGrantedScopes()).resolves.toEqual(["im:message"]);
    expect(calls[0]).toEqual(["--profile", "bot-profile", "api", "GET", "/open-apis/application/v6/scopes", "--as", "bot", "--format", "json"]);
  });

  it("sends markdown and cards directly to a chat without thread reply arguments", async () => {
    const calls: string[][] = [];
    const gateway = new LarkGateway("lark-cli", async (_command, args) => {
      calls.push(args);
      return { data: { message_id: `om_${calls.length}` } };
    });

    await expect(gateway.sendMarkdownToChat("oc_chat", "hello", "markdown-key")).resolves.toBe("om_1");
    await expect(gateway.sendCardToChat("oc_chat", { elements: [] }, "card-key")).resolves.toBe("om_2");

    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(["im", "+messages-send"]);
      expect(args).toContain("--chat-id");
      expect(args).toContain("oc_chat");
      expect(args).not.toContain("--reply-in-thread");
      expect(args).not.toContain("+messages-reply");
    }
  });

  it("replies to an activating group message in the main stream without creating a thread", async () => {
    const calls: string[][] = [];
    const gateway = new LarkGateway("lark-cli", async (_command, args) => {
      calls.push(args);
      return { data: { message_id: `om_reply_${calls.length}` } };
    });

    await expect(gateway.replyMarkdownToMessage("om_activation", "完成", "markdown-reply-key")).resolves.toBe("om_reply_1");
    await expect(gateway.replyCardEntityToMessage("om_activation", "card_1", "card-reply-key")).resolves.toBe("om_reply_2");

    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(["im", "+messages-reply"]);
      expect(args).toContain("--message-id");
      expect(args).toContain("om_activation");
      expect(args).not.toContain("--reply-in-thread");
      expect(args).not.toContain("--chat-id");
    }
    expect(calls[1]).toContain("interactive");
    expect(calls[1]).toContain(JSON.stringify({ type: "card", data: { card_id: "card_1" } }));
  });

  it("lists only the chat main stream and parses data.messages pagination", async () => {
    const calls: string[][] = [];
    const gateway = new LarkGateway("lark-cli", async (_command, args) => {
      calls.push(args);
      return {
        data: {
          has_more: true,
          page_token: "next-page",
          messages: [{
            message_id: "om_message",
            chat_id: "oc_chat",
            content: "follow up",
            sender: { id: "ou_owner", sender_type: "user" },
            msg_type: "text",
            create_time: "2026-07-11 12:00"
          }]
        }
      };
    });
    const result = await gateway.listChatMessages(
      "oc_chat",
      new Date("2026-07-11T11:00:00Z"),
      new Date("2026-07-11T13:00:00Z"),
      "page-1"
    );

    expect(calls[0]?.slice(0, 2)).toEqual(["im", "+chat-messages-list"]);
    expect(calls[0]).toContain("--page-token");
    expect(calls[0]).not.toContain("+threads-messages-list");
    expect(result).toMatchObject({ hasMore: true, pageToken: "next-page" });
    expect(result.messages[0]).toMatchObject({ messageId: "om_message", chatId: "oc_chat", content: "follow up" });
  });

  it("resolves a group display name for the admin task detail", async () => {
    const gateway = new LarkGateway("lark-cli", async (_command, args) => {
      expect(args).toEqual(["im", "chats", "get", "--chat-id", "oc_chat", "--as", "bot", "--format", "json"]);
      return { data: { name: "阿朱的测试群" } };
    });
    await expect(gateway.getChatName("oc_chat")).resolves.toBe("阿朱的测试群");
  });

  it("creates, sends, streams and closes one CardKit entity", async () => {
    const calls: string[][] = [];
    const gateway = new LarkGateway("lark-cli", async (_command, args) => {
      calls.push(args);
      if (args[2] === "/open-apis/cardkit/v1/cards") return { data: { card_id: "card_1" } };
      if (args[2] === "/open-apis/im/v1/messages") return { data: { message_id: "om_card" } };
      return { data: {} };
    });
    await expect(gateway.createCardEntity("正在处理…", true)).resolves.toBe("card_1");
    await expect(gateway.sendCardEntityToChat("oc_chat", "card_1", "send-key")).resolves.toBe("om_card");
    await gateway.streamCardContent("card_1", "answer", "进度", 1, "update-1");
    await gateway.closeCardStream("card_1", "完成", 2, "close-2");

    expect(calls.map((args) => args.slice(0, 3))).toEqual([
      ["api", "POST", "/open-apis/cardkit/v1/cards"],
      ["api", "POST", "/open-apis/im/v1/messages"],
      ["api", "PUT", "/open-apis/cardkit/v1/cards/card_1/elements/answer/content"],
      ["api", "PATCH", "/open-apis/cardkit/v1/cards/card_1/settings"]
    ]);
    const createBody = JSON.parse(calls[0]?.at(-1) ?? "{}") as { data: string };
    expect(JSON.parse(createBody.data)).toMatchObject({ schema: "2.0", config: { streaming_mode: true, update_multi: true } });
    const closeBody = JSON.parse(calls[3]?.at(-1) ?? "{}") as { sequence: number; settings: string };
    expect(closeBody.sequence).toBe(2);
    expect(JSON.parse(closeBody.settings)).toMatchObject({ config: { streaming_mode: false } });
  });
});
