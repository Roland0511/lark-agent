import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/runner/lark-agent-runner");
const homes: string[] = [];

function run(args: string[], home = process.env.HOME): ReturnType<typeof spawnSync> {
  return spawnSync(script, args, { encoding: "utf8", env: { ...process.env, HOME: home } });
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("lark-agent-runner CLI", () => {
  it("provides identical help aliases without requiring an installation", () => {
    const home = mkdtempSync(join(tmpdir(), "lark-runner-help-"));
    homes.push(home);
    const help = run(["help"], home);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("lark-agent-runner - 管理本机 Lark Agent 执行器");
    expect(run(["--help"], home).stdout).toBe(help.stdout);
    expect(run(["-h"], home).stdout).toBe(help.stdout);
  });

  it("rejects unknown commands and points to help", () => {
    const result = run(["unknown"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("lark-agent-runner help");
  });

  it("reports a clear error when no executor is installed", () => {
    const home = mkdtempSync(join(tmpdir(), "lark-runner-empty-"));
    homes.push(home);
    const result = run(["list"], home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("没有找到已安装的执行器");
  });
});
