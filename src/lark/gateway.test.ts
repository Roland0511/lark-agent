import { describe, expect, it } from "vitest";
import { LarkGateway } from "./gateway.js";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("LarkGateway main-chat messaging", () => {
  it("downloads a message resource with a relative output path and removes the temporary directory", async () => {
    let temporaryDirectory = "";
    const gateway = new LarkGateway("lark-cli", async () => ({}), "bot-profile", async (_command, args, _env, options) => {
      temporaryDirectory = options?.cwd ?? "";
      const output = args[args.indexOf("--output") + 1] ?? "";
      expect(output.startsWith("/")).toBe(false);
      await writeFile(join(temporaryDirectory, output), "attachment-body");
      return { stdout: "{}", stderr: "", exitCode: 0 };
    });
    const resource = await gateway.downloadMessageResource("om_resource", {
      id: "11111111-1111-4111-8111-111111111111",
      type: "file",
      fileName: "proof.txt",
      resourceKey: "file_resource"
    }, 100);
    expect(await readFile(resource.path, "utf8")).toBe("attachment-body");
    expect(resource.size).toBe(15);
    resource.stream.destroy();
    await resource.cleanup();
    await expect(stat(temporaryDirectory)).rejects.toThrow();
  });

  it("rejects downloads stopped by the per-file size monitor and cleans temporary data", async () => {
    let temporaryDirectory = "";
    const gateway = new LarkGateway("lark-cli", async () => ({}), null, async (_command, _args, _env, options) => {
      temporaryDirectory = options?.cwd ?? "";
      return { stdout: "", stderr: "", exitCode: -1, limitExceeded: true };
    });
    await expect(gateway.downloadMessageResource("om_resource", {
      id: "22222222-2222-4222-8222-222222222222",
      type: "image",
      fileName: "screen.png",
      resourceKey: "img_resource"
    }, 5)).rejects.toMatchObject({ statusCode: 413, code: "attachment_too_large" });
    await expect(stat(temporaryDirectory)).rejects.toThrow();
  });

  it("accepts the extension that lark-cli infers for an image output basename", async () => {
    const gateway = new LarkGateway("lark-cli", async () => ({}), null, async (_command, args, _env, options) => {
      const output = args[args.indexOf("--output") + 1] ?? "";
      await writeFile(join(options?.cwd ?? "", `${output}.jpg`), "jpeg-bytes");
      return { stdout: "{}", stderr: "", exitCode: 0 };
    });
    const resource = await gateway.downloadMessageResource("om_image", {
      id: "33333333-3333-4333-8333-333333333333",
      type: "image",
      fileName: "image",
      resourceKey: "img_resource"
    }, 100);
    expect(resource.fileName).toBe("image.jpg");
    resource.stream.destroy();
    await resource.cleanup();
  });

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
