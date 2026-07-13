import { describe, expect, it } from "vitest";
import { BotPermissionService, evaluateBotPermissions } from "./bot-permissions.js";

const fullScopes = [
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message.group_msg",
  "im:message.group_at_msg.include_bot:readonly",
  "im:message.group_bot_msg:readonly",
  "im:message",
  "im:chat:readonly",
  "cardkit:card:write"
];

describe("bot permission checks", () => {
  it("accepts the complete permission set", () => {
    const result = evaluateBotPermissions([...fullScopes, "im:message"]);
    expect(result).toMatchObject({ ok: true, state: "valid", missingScopes: [] });
    expect(result.items.every((item) => item.status === "granted")).toBe(true);
    expect(result.grantedScopes.filter((scope) => scope === "im:message")).toHaveLength(1);
  });

  it("accepts documented compatible alternatives", () => {
    const result = evaluateBotPermissions([
      "im:message.p2p_msg",
      "im:message.group_at_msg",
      "im:message.group_msg",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message.bot_event:read",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:chat:read",
      "cardkit:card:write"
    ]);
    expect(result.ok).toBe(true);
  });

  it("reports the exact missing capabilities and recommended scopes", () => {
    const result = evaluateBotPermissions(fullScopes.filter((scope) => !["im:message.group_bot_msg:readonly", "cardkit:card:write"].includes(scope)));
    expect(result.state).toBe("missing");
    expect(result.items.filter((item) => item.status === "missing").map((item) => item.key)).toEqual(["group_bot_messages", "cardkit_write"]);
    expect(result.missingScopes).toEqual(["im:message.group_bot_msg:readonly", "cardkit:card:write"]);
  });

  it("turns provider failures into a safe error result", async () => {
    const service = new BotPermissionService(async () => { throw new Error("scope endpoint unavailable"); });
    await expect(service.check("bot-test")).resolves.toMatchObject({ state: "error", ok: false, error: "scope endpoint unavailable" });
  });
});
