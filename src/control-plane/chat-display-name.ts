export interface ChatDisplayIdentity {
  chatType: string;
  chatName?: string | null;
  peerOpenId?: string | null;
  peerDisplayName?: string | null;
}

export function maskedPeerOpenId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}…${value.slice(-3)}`;
}

export function chatDisplayName(identity: ChatDisplayIdentity): string {
  if (identity.chatType === "group") return identity.chatName?.trim() || "未命名群聊";
  const peerName = identity.peerDisplayName?.trim();
  if (peerName) return `与${peerName}的私聊`;
  const masked = maskedPeerOpenId(identity.peerOpenId);
  return masked ? `与用户 ${masked} 的私聊` : "未识别的私聊";
}

export function publicChatIdentity(identity: ChatDisplayIdentity) {
  return {
    chatDisplayName: chatDisplayName(identity),
    peerOpenId: identity.peerOpenId ?? null,
    peerDisplayName: identity.peerDisplayName ?? null
  };
}
