import { errorMessage } from "../shared/errors.js";

export type BotPermissionState = "unchecked" | "valid" | "missing" | "error";

export interface BotPermissionRequirement {
  key: string;
  label: string;
  description: string;
  alternatives: string[][];
}

export interface BotPermissionItem extends BotPermissionRequirement {
  status: "granted" | "missing" | "unknown";
  matchedScopes: string[];
}

export interface BotPermissionCheck {
  state: Exclude<BotPermissionState, "unchecked">;
  ok: boolean;
  checkedAt: string;
  items: BotPermissionItem[];
  missingScopes: string[];
  grantedScopes: string[];
  error: string | null;
}

export const requiredBotPermissions: BotPermissionRequirement[] = [
  {
    key: "p2p_messages",
    label: "接收私聊消息",
    description: "用于私聊指令、主人绑定和控制台连接。",
    alternatives: [["im:message.p2p_msg:readonly"], ["im:message.p2p_msg"]]
  },
  {
    key: "group_at_messages",
    label: "接收群内用户 @ 消息",
    description: "用于在群聊中首次唤醒机器人。",
    alternatives: [["im:message.group_at_msg:readonly"], ["im:message.group_at_msg"]]
  },
  {
    key: "group_messages",
    label: "接收群内普通用户消息",
    description: "用于群会话激活后的普通续聊。",
    alternatives: [["im:message.group_msg"]]
  },
  {
    key: "group_at_messages_include_bot",
    label: "接收用户或机器人 @ 消息",
    description: "用于已注册机器人之间明确 @ 的对话。",
    alternatives: [["im:message.group_at_msg.include_bot:readonly"]]
  },
  {
    key: "group_bot_messages",
    label: "接收群内机器人普通消息",
    description: "用于把其他已注册机器人视为普通群成员续聊。",
    alternatives: [["im:message.group_bot_msg:readonly"], ["im:message.bot_event:read"]]
  },
  {
    key: "message_read_write",
    label: "读取并发送消息",
    description: "用于补全消息详情并以机器人身份回复。",
    alternatives: [["im:message"], ["im:message:readonly", "im:message:send_as_bot"]]
  },
  {
    key: "chat_read",
    label: "读取群聊信息",
    description: "用于读取群名称和列出机器人已加入的群。",
    alternatives: [["im:chat:read"], ["im:chat:readonly"], ["im:chat"]]
  },
  {
    key: "cardkit_write",
    label: "创建和更新 CardKit 卡片",
    description: "用于单消息流式回复和最终结果原位更新。",
    alternatives: [["cardkit:card:write"]]
  }
];

export function evaluateBotPermissions(scopes: Iterable<string>, checkedAt = new Date()): BotPermissionCheck {
  const granted = new Set([...scopes].filter(Boolean));
  const items = requiredBotPermissions.map((requirement): BotPermissionItem => {
    const matched = requirement.alternatives.find((alternative) => alternative.every((scope) => granted.has(scope))) ?? [];
    return { ...requirement, status: matched.length ? "granted" : "missing", matchedScopes: matched };
  });
  const missingScopes = [...new Set(items.filter((item) => item.status === "missing").flatMap((item) => item.alternatives[0] ?? []))];
  return {
    state: missingScopes.length ? "missing" : "valid",
    ok: missingScopes.length === 0,
    checkedAt: checkedAt.toISOString(),
    items,
    missingScopes,
    grantedScopes: [...granted].sort(),
    error: null
  };
}

export class BotPermissionService {
  constructor(private readonly listGrantedScopes: (profileName: string | null) => Promise<string[]>) {}

  async check(profileName: string | null): Promise<BotPermissionCheck> {
    const checkedAt = new Date();
    try {
      return evaluateBotPermissions(await this.listGrantedScopes(profileName), checkedAt);
    } catch (error) {
      return {
        state: "error",
        ok: false,
        checkedAt: checkedAt.toISOString(),
        items: requiredBotPermissions.map((requirement) => ({ ...requirement, status: "unknown", matchedScopes: [] })),
        missingScopes: [],
        grantedScopes: [],
        error: errorMessage(error).slice(0, 500)
      };
    }
  }
}
