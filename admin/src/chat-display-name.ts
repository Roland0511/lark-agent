type ChatIdentity = Record<string, unknown>;

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

export function maskedPeerOpenId(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}…${value.slice(-3)}`;
}

export function chatDisplayName(context: ChatIdentity): string {
  const resolved = firstString(context.chatDisplayName, context.chat_display_name);
  if (resolved) return resolved;
  const type = firstString(context.chatType, context.chat_type);
  if (type === "group") return firstString(context.chatName, context.chat_name) ?? "未命名群聊";
  const peerName = firstString(context.peerDisplayName, context.peer_display_name);
  if (peerName) return `与${peerName}的私聊`;
  const peerId = firstString(context.peerOpenId, context.peer_open_id);
  return peerId ? `与用户 ${maskedPeerOpenId(peerId)} 的私聊` : "未识别的私聊";
}

function identityKey(context: ChatIdentity, index: number): string {
  return firstString(context.id, context.chatContextId, context.chat_context_id, context.chatId, context.chat_id) ?? String(index);
}

export function chatDisplayNames(contexts: ChatIdentity[]): Map<string, string> {
  const bases = contexts.map(chatDisplayName);
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  return new Map(contexts.map((context, index) => {
    const base = bases[index] ?? "未识别的私聊";
    const peerId = firstString(context.peerOpenId, context.peer_open_id);
    const type = firstString(context.chatType, context.chat_type);
    const suffix = type !== "group" && peerId && (counts.get(base) ?? 0) > 1 ? `（${maskedPeerOpenId(peerId)}）` : "";
    return [identityKey(context, index), `${base}${suffix}`];
  }));
}
