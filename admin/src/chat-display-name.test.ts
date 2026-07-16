import { describe, expect, it } from "vitest";
import { chatDisplayName, chatDisplayNames } from "./chat-display-name";

describe("admin chat display name", () => {
  it("prefers the canonical API name", () => {
    expect(chatDisplayName({ chatDisplayName: "与张三的私聊", chatType: "p2p" })).toBe("与张三的私聊");
  });

  it("only disambiguates duplicate peer names within the same list", () => {
    const items = [
      { id: "a", chatType: "p2p", peerDisplayName: "张三", peerOpenId: "peer_123456789xyz" },
      { id: "b", chatType: "p2p", peerDisplayName: "张三", peerOpenId: "peer_987654321abc" },
      { id: "c", chatType: "p2p", peerDisplayName: "李四", peerOpenId: "peer_555555555def" }
    ];
    const names = chatDisplayNames(items);
    expect(names.get("a")).toBe("与张三的私聊（peer_…xyz）");
    expect(names.get("b")).toBe("与张三的私聊（peer_…abc）");
    expect(names.get("c")).toBe("与李四的私聊");
  });
});
