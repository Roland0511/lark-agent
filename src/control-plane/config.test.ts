import { describe, expect, it } from "vitest";
import { loadControlPlaneConfig } from "./config.js";

const required = {
  DATABASE_URL: "postgresql://lark-agent:test@localhost/lark-agent",
  SESSION_SIGNING_SECRET: "x".repeat(32),
  RUNNER_ARTIFACT_PUBLIC_BASE_URL: "https://cdn.example.com/lark-agent"
};

describe("control plane config", () => {
  it("allows bootstrap-only bot settings to be absent after the database is initialized", () => {
    const config = loadControlPlaneConfig(required);
    expect(config.ownerOpenId).toBe("");
    expect(config.botAppId).toBe("");
    expect(config.whitelistChatIds.size).toBe(0);
    expect(config.attachmentMaxBytes).toBe(104_857_600);
    expect(config.attachmentTaskMaxBytes).toBe(209_715_200);
    expect(config.attachmentRetentionDays).toBe(7);
  });

  it("still accepts bootstrap settings for a fresh installation", () => {
    const config = loadControlPlaneConfig({
      ...required,
      OWNER_OPEN_ID: "ou_owner",
      BOT_APP_ID: "cli_bootstrap",
      WHITELIST_CHAT_IDS: "oc_first,oc_second"
    });
    expect(config.ownerOpenId).toBe("ou_owner");
    expect(config.botAppId).toBe("cli_bootstrap");
    expect([...config.whitelistChatIds]).toEqual(["oc_first", "oc_second"]);
  });
});
