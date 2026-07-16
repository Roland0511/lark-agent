import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const installer = fileURLToPath(new URL("../../scripts/runner/install.sh", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runGuard(status: Record<string, unknown>, options: {
  secondStatus?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  installedVersion?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "lark-agent-upgrade-guard-"));
  temporaryRoots.push(root);
  const home = join(root, "home");
  const installDir = join(home, "Library", "Application Support", "Lark Agent Runner", "worker-a");
  const fakeBin = join(root, "bin");
  const statusFile = join(root, "status.json");
  const secondStatusFile = join(root, "status-second.json");
  const drainFile = join(root, "drain.json");
  const manifestFile = join(root, "manifest.json");
  const statusCountFile = join(root, "status-count");
  const curlLog = join(root, "curl.log");
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "installation.env"), [
    "CONTROL_PLANE_URL='https://agent.example.test'",
    "ARTIFACT_BASE='https://cdn.example.test/lark-agent'",
    "EXECUTOR_ID='worker-a'",
    "LAUNCHD_LABEL='io.github.lark-agent.runner.worker-a'",
    `PLIST_PATH='${join(home, "Library", "LaunchAgents", "io.github.lark-agent.runner.worker-a.plist")}'`,
    ""
  ].join("\n"), { mode: 0o600 });
  await writeFile(join(installDir, "credentials"), "device-credential", { mode: 0o600 });
  await writeFile(join(installDir, "config.yaml"), "executor:\n  runner_version: '0.3.1'\n", { mode: 0o600 });
  await writeFile(statusFile, JSON.stringify(status), { mode: 0o600 });
  await writeFile(secondStatusFile, JSON.stringify(options.secondStatus ?? status), { mode: 0o600 });
  await writeFile(drainFile, JSON.stringify({ drainToken: "test-upgrade-drain-token" }), { mode: 0o600 });
  await writeFile(manifestFile, JSON.stringify(options.manifest ?? status), { mode: 0o600 });
  if (options.installedVersion) {
    const oldVersion = join(installDir, "versions", "0.3.1");
    const nextVersion = join(installDir, "versions", options.installedVersion);
    await mkdir(join(nextVersion, "node", "bin"), { recursive: true });
    await mkdir(oldVersion, { recursive: true });
    await writeFile(join(nextVersion, "node", "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(nextVersion, "worker.mjs"), "// test worker\n");
    await writeFile(join(nextVersion, "manager.mjs"), "// test manager\n");
    await symlink("versions/0.3.1", join(installDir, "current"));
  }
  const fakeCurl = join(fakeBin, "curl");
  await writeFile(fakeCurl, [
    "#!/bin/zsh",
    "set -euo pipefail",
    "print -r -- \"$*\" >> \"$FAKE_CURL_LOG\"",
    "output=''",
    "for (( index=1; index <= $#; index++ )); do",
    "  if [[ \"${argv[$index]}\" == '-o' ]]; then",
    "    (( index++ ))",
    "    output=\"${argv[$index]}\"",
    "  fi",
    "done",
    "[[ -n \"$output\" ]] || exit 2",
    "if [[ \"$*\" == *'/upgrade-drain/'* && \"$*\" == *'-X POST'* ]]; then",
    "  cp \"$FAKE_DRAIN_STATUS_FILE\" \"$output\"",
    "elif [[ \"$*\" == *'/upgrade-drain/'* && \"$*\" == *'-X DELETE'* ]]; then",
    "  print -r -- '{\"ok\":true}' > \"$output\"",
    "elif [[ \"$*\" == *'/runner/manifest.json'* ]]; then",
    "  cp \"$FAKE_MANIFEST_FILE\" \"$output\"",
    "elif [[ \"$*\" == *'/v1/runner/status/'* ]]; then",
    "  count=0",
    "  [[ ! -f \"$FAKE_STATUS_COUNT_FILE\" ]] || count=$(<\"$FAKE_STATUS_COUNT_FILE\")",
    "  count=$((count + 1))",
    "  print -r -- \"$count\" > \"$FAKE_STATUS_COUNT_FILE\"",
    "  if (( count > 1 )); then cp \"$FAKE_SECOND_STATUS_FILE\" \"$output\"; else cp \"$FAKE_RUNNER_STATUS_FILE\" \"$output\"; fi",
    "else",
    "  cp \"$FAKE_RUNNER_STATUS_FILE\" \"$output\"",
    "fi",
    ""
  ].join("\n"), { mode: 0o755 });
  await chmod(fakeCurl, 0o755);

  const result = spawnSync("/bin/zsh", [installer, "--upgrade", "--artifact-base", "https://cdn.example.test/lark-agent", "--executor-id", "worker-a"], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_CURL_LOG: curlLog,
      FAKE_RUNNER_STATUS_FILE: statusFile,
      FAKE_SECOND_STATUS_FILE: secondStatusFile,
      FAKE_DRAIN_STATUS_FILE: drainFile,
      FAKE_MANIFEST_FILE: manifestFile,
      FAKE_STATUS_COUNT_FILE: statusCountFile
    }
  });
  const calls = existsSync(curlLog) ? (await readFile(curlLog, "utf8")).trim().split("\n").filter(Boolean) : [];
  return { result, calls, installDir };
}

describe.skipIf(process.platform !== "darwin" || !existsSync("/bin/zsh"))("Runner upgrade safety guard", () => {
  it("waits for the newly installed Runner version instead of accepting a stale online heartbeat", async () => {
    const script = await readFile(installer, "utf8");
    expect(script).toContain("optional_json_value \"$RESPONSE\" runnerVersion ''");
    expect(script).toContain("wait_online \"$CONTROL_PLANE_URL\" \"$EXECUTOR_ID\" \"$CREDENTIAL\" \"$VERSION\"");
  });

  it("stops before reading the release manifest when a runtime sync lease is active", async () => {
    const { result, calls } = await runGuard({ online: true, activeTasks: 0, activeRuntimeSyncJobs: 1 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("活跃技能同步任务");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/runner/status/worker-a");
    expect(calls[0]).not.toContain("manifest.json");
  });

  it("stops before reading the release manifest when an executor task is active", async () => {
    const { result, calls } = await runGuard({ online: true, activeTasks: 1, activeRuntimeSyncJobs: 0 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("活跃任务");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/runner/status/worker-a");
  });

  it("stops before reading the release manifest when a Thread snapshot lease is active", async () => {
    const { result, calls } = await runGuard({
      online: true, activeTasks: 0, activeRuntimeSyncJobs: 0, activeThreadSnapshotJobs: 1
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("活跃 Thread 快照任务");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/runner/status/worker-a");
    expect(calls[0]).not.toContain("manifest.json");
  });

  it("treats a missing runtime-sync field from an old control plane as zero", async () => {
    const { result, calls } = await runGuard({ online: true, activeTasks: 0 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("技能同步状态无效");
    expect(result.stderr).not.toContain("Thread 快照状态无效");
    expect(calls[0]).toContain("/v1/runner/status/worker-a");
    expect(calls.some((call) => call.includes("-X POST") && call.includes("/v1/runner/upgrade-drain/worker-a"))).toBe(true);
    expect(calls.some((call) => call.includes("/runner/manifest.json"))).toBe(true);
    expect(calls.join("\n")).toContain("-X DELETE");
  });

  it("does not switch or restart when an administrator cancels the drain during download", async () => {
    const manifest = {
      version: "0.4.0", publishedAt: "2026-07-15T00:00:00.000Z",
      worker: { path: "releases/0.4.0/worker.mjs", sha256: "a".repeat(64) },
      manager: { path: "releases/0.4.0/lark-agent-runner", sha256: "b".repeat(64) },
      daemon: { path: "releases/0.4.0/manager.mjs", sha256: "e".repeat(64) },
      node: {
        arm64: { path: "releases/0.4.0/node-arm64.tar.gz", sha256: "c".repeat(64) },
        x64: { path: "releases/0.4.0/node-x64.tar.gz", sha256: "d".repeat(64) }
      }
    };
    const { result, calls, installDir } = await runGuard(
      { online: true, activeTasks: 0, activeRuntimeSyncJobs: 0 },
      {
        manifest, installedVersion: "0.4.0",
        secondStatus: { online: true, activeTasks: 0, activeRuntimeSyncJobs: 0, upgradeDraining: false, upgradeDrainOwned: false }
      }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("升级排空状态已失效");
    expect(await readlink(join(installDir, "current"))).toBe("versions/0.3.1");
    expect(calls.some((call) => call.includes("X-Upgrade-Drain-Token: test-upgrade-drain-token") && call.includes("/v1/runner/status/worker-a"))).toBe(true);
    expect(calls.some((call) => call.includes("releases/0.4.0/lark-agent-runner"))).toBe(false);
    expect(calls.some((call) => call.includes("-X DELETE") && call.includes("/v1/runner/upgrade-drain/worker-a"))).toBe(true);
  });
});
