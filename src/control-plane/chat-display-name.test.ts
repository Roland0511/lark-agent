import { describe, expect, it } from "vitest";
import { chatDisplayName, maskedPeerOpenId, publicChatIdentity } from "./chat-display-name.js";

describe("chat display name", () => {
  it("names concrete private conversations by their peer", () => {
    expect(chatDisplayName({ chatType: "p2p", peerDisplayName: "张三", peerOpenId: "peer_123456789xyz" })).toBe("与张三的私聊");
  });

  it("uses stable privacy-preserving fallbacks", () => {
    expect(maskedPeerOpenId("peer_123456789xyz")).toBe("peer_…xyz");
    expect(chatDisplayName({ chatType: "p2p", peerOpenId: "peer_123456789xyz" })).toBe("与用户 peer_…xyz 的私聊");
    expect(chatDisplayName({ chatType: "p2p" })).toBe("未识别的私聊");
  });

  it("keeps group naming and exposes one canonical admin shape", () => {
    expect(publicChatIdentity({ chatType: "group", chatName: "项目群", peerOpenId: null, peerDisplayName: null })).toEqual({
      chatDisplayName: "项目群",
      peerOpenId: null,
      peerDisplayName: null
    });
  });
});
