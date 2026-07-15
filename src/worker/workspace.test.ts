import { mkdtemp, mkdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveBotWorkspace, resolveChatWorkspace } from "./workspace.js";

const firstContext = "a1111111-1111-4111-8111-111111111111";
const secondContext = "b2222222-2222-4222-8222-222222222222";

describe("bot workspace isolation", () => {
  it("creates one app-id directory per bot below the selected total workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "lark-agent-total-workspace-"));
    const first = await resolveBotWorkspace([{ alias: "projects", path: root }], "projects", "cli_firstbot");
    const second = await resolveBotWorkspace([{ alias: "projects", path: root }], "projects", "cli_secondbot");
    expect(first).toEqual({ rootAlias: "projects", alias: "projects/cli_firstbot", path: await realpath(join(root, "cli_firstbot")) });
    expect(second.path).toBe(await realpath(join(root, "cli_secondbot")));
    expect(second.path).not.toBe(first.path);
  });

  it("uses the only configured root when the route is automatic", async () => {
    const root = await mkdtemp(join(tmpdir(), "lark-agent-auto-workspace-"));
    await expect(resolveBotWorkspace([{ alias: "default", path: root }], null, "cli_autobot"))
      .resolves.toMatchObject({ rootAlias: "default", alias: "default/cli_autobot" });
  });

  it("rejects invalid app ids and symlinks that escape the total workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "lark-agent-safe-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "lark-agent-outside-workspace-"));
    await mkdir(join(outside, "nested"));
    await symlink(join(outside, "nested"), join(root, "cli_escape"));
    await expect(resolveBotWorkspace([{ alias: "default", path: root }], "default", "not-an-app-id")).rejects.toThrow(/invalid bot app id/);
    await expect(resolveBotWorkspace([{ alias: "default", path: root }], "default", "cli_escape")).rejects.toThrow(/symbolic link/);
  });

  it("creates one private 0700 directory per bot and chat context", async () => {
    const root = await mkdtemp(join(tmpdir(), "lark-agent-chat-workspace-"));
    const first = await resolveChatWorkspace([{ alias: "projects", path: root }], "projects", "cli_firstbot", firstContext, firstContext);
    const second = await resolveChatWorkspace([{ alias: "projects", path: root }], "projects", "cli_firstbot", secondContext, secondContext);
    const otherBot = await resolveChatWorkspace([{ alias: "projects", path: root }], "projects", "cli_secondbot", firstContext, firstContext);

    expect(first).toEqual({
      rootAlias: "projects",
      alias: `projects/cli_firstbot/chats/${firstContext}`,
      path: await realpath(join(root, "cli_firstbot", "chats", firstContext)),
      chatContextId: firstContext,
      workspaceKey: firstContext
    });
    expect(second.path).not.toBe(first.path);
    expect(otherBot.path).not.toBe(first.path);
    expect((await stat(first.path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "cli_firstbot", "chats"))).mode & 0o777).toBe(0o700);
  });

  it("leaves the legacy bot directory in place without copying its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "lark-agent-legacy-workspace-"));
    const legacy = join(root, "cli_legacybot");
    await mkdir(legacy, { mode: 0o755 });
    await writeFile(join(legacy, "legacy-only.txt"), "keep in place");
    const legacyMode = (await stat(legacy)).mode & 0o777;
    const workspace = await resolveChatWorkspace([{ alias: "default", path: root }], "default", "cli_legacybot", firstContext, firstContext);
    expect(await stat(join(legacy, "legacy-only.txt"))).toBeDefined();
    expect((await stat(legacy)).mode & 0o777).toBe(legacyMode);
    await expect(stat(join(workspace.path, "legacy-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-lowercase UUIDs, mismatched keys, and a context symlink escaping the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lark-agent-chat-safe-"));
    const outside = await mkdtemp(join(tmpdir(), "lark-agent-chat-outside-"));
    await mkdir(join(root, "cli_safebot", "chats"), { recursive: true });
    await symlink(outside, join(root, "cli_safebot", "chats", firstContext));

    await expect(resolveChatWorkspace([{ alias: "default", path: root }], "default", "cli_safebot", firstContext.toUpperCase(), firstContext.toUpperCase()))
      .rejects.toThrow(/invalid chat context id/);
    await expect(resolveChatWorkspace([{ alias: "default", path: root }], "default", "cli_safebot", firstContext, secondContext))
      .rejects.toThrow(/does not match/);
    await expect(resolveChatWorkspace([{ alias: "default", path: root }], "default", "cli_safebot", firstContext, firstContext))
      .rejects.toThrow(/symbolic link/);
  });

  it("rejects app, chats, and context symlinks even when they stay inside the total workspace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "lark-agent-chat-app-link-"));
    await mkdir(join(appRoot, "cli_target"));
    await symlink(join(appRoot, "cli_target"), join(appRoot, "cli_alias"));
    await expect(resolveChatWorkspace([{ alias: "default", path: appRoot }], "default", "cli_alias", firstContext, firstContext))
      .rejects.toThrow(/symbolic link/);

    const chatsRoot = await mkdtemp(join(tmpdir(), "lark-agent-chat-chats-link-"));
    await mkdir(join(chatsRoot, "cli_first", "real-chats"), { recursive: true });
    await symlink(join(chatsRoot, "cli_first", "real-chats"), join(chatsRoot, "cli_first", "chats"));
    await expect(resolveChatWorkspace([{ alias: "default", path: chatsRoot }], "default", "cli_first", firstContext, firstContext))
      .rejects.toThrow(/symbolic link/);

    const contextRoot = await mkdtemp(join(tmpdir(), "lark-agent-chat-context-link-"));
    await mkdir(join(contextRoot, "cli_first", "chats", secondContext), { recursive: true });
    await symlink(join(contextRoot, "cli_first", "chats", secondContext), join(contextRoot, "cli_first", "chats", firstContext));
    await expect(resolveChatWorkspace([{ alias: "default", path: contextRoot }], "default", "cli_first", firstContext, firstContext))
      .rejects.toThrow(/symbolic link/);
  });
});
