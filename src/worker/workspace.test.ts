import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveBotWorkspace } from "./workspace.js";

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
    await expect(resolveBotWorkspace([{ alias: "default", path: root }], "default", "cli_escape")).rejects.toThrow(/outside/);
  });
});
