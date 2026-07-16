import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig, workspaceMappingFingerprint } from "./config.js";

async function fixture(baseConfig = "model = \"test\"\n") {
  const root = await mkdtemp(join(tmpdir(), "lark-agent-config-"));
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "workspace");
  await mkdir(codexHome);
  await mkdir(workspace);
  await writeFile(join(codexHome, "config.toml"), baseConfig);
  await writeFile(join(codexHome, "lark-agent.config.toml"), "approval_policy = \"on-request\"\n[tui.model_availability_nux]\n\"test.model\" = 2\n");
  const fakeCodex = join(root, "codex");
  await writeFile(fakeCodex, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli test-version'; exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then
    shift
    mkdir -p "$1"
    printf '%s' '{"methods":["thread/start","thread/resume","thread/read","turn/start","turn/steer","turn/interrupt","skills/list"]}' > "$1/ClientRequest.json"
    printf '%s' '{"methods":["item/commandExecution/requestApproval","item/fileChange/requestApproval"]}' > "$1/ServerRequest.json"
    exit 0
  fi
  shift
done
exit 1
`);
  await chmod(fakeCodex, 0o755);
  const configFile = join(root, "worker.yaml");
  await writeFile(
    configFile,
    `control_plane:\n  url: https://agent.example.test\n  device_token_env: TEST_DEVICE_TOKEN\nexecutor:\n  id: test-worker\n  display_name: Test Worker\n  codex_home: ${JSON.stringify(codexHome)}\n  codex_profile: lark-agent\n  codex_binary: ${JSON.stringify(fakeCodex)}\n  capacity: 1\n  workspace_roots:\n    - alias: repo\n      path: ${JSON.stringify(workspace)}\n`
  );
  return { configFile, codexHome: await realpath(codexHome), workspace };
}

describe("worker config", () => {
  it("binds one canonical CODEX_HOME and profile without exposing the path in homeRef", async () => {
    const data = await fixture();
    const config = await loadWorkerConfig(data.configFile, { TEST_DEVICE_TOKEN: ["test", "device", "token"].join("-") });
    expect(config.codexHome).toBe(data.codexHome);
    expect(config.deviceTokenEnvironmentName).toBe("TEST_DEVICE_TOKEN");
    expect(config.codexProfile).toBe("lark-agent");
    expect(config.profileOverrides).toContain('approval_policy="on-request"');
    expect(config.profileModel).toBe("test");
    expect(config.profileReasoningEffort).toBeNull();
    expect(config.profileOverrides.every((value) => !value.startsWith("tui."))).toBe(true);
    expect(config.homeRef).toMatch(/^test-worker:[a-f0-9]{16}$/);
    expect(config.homeRef).not.toContain(data.codexHome);
    expect(config.configFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(config.workspaceMappingFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(config.capabilities).not.toContain("app_handoff");
    expect(config.capabilities).toContain("chat_context_v1");
    expect(config.capabilities).toContain("skillhub_skills_v1");
    expect(config.capabilities).toContain("skill_runtime_config_v1");
    expect(config.capabilities).toContain("user_skills_inventory_v1");
    expect(config.capabilities).toContain("workspace_mapping_v1");
    expect(config.capabilities).toContain("thread_snapshot_v1");
    expect(config.capabilities).toContain("thread_turn_summary_v1");
    expect(config.runtimeStateDir).toBe(await realpath(join(dirname(data.configFile), "state")));
    expect(config.attachmentMaxBytes).toBe(104_857_600);
    expect(config.attachmentTaskMaxBytes).toBe(209_715_200);
    expect(config.attachmentRetentionDays).toBe(7);
  });

  it("reports the effective profile model and reasoning effort", async () => {
    const data = await fixture('model = "base-model"\nmodel_reasoning_effort = "medium"\n');
    const profilePath = join(data.codexHome, "lark-agent.config.toml");
    await writeFile(profilePath, 'model = "profile-model"\nmodel_reasoning_effort = "high"\napproval_policy = "on-request"\n');
    const config = await loadWorkerConfig(data.configFile, { TEST_DEVICE_TOKEN: ["test", "device", "token"].join("-") });
    expect(config.profileModel).toBe("profile-model");
    expect(config.profileReasoningEffort).toBe("high");
  });

  it("keeps the continuity fingerprint stable across unrelated base and TUI changes", async () => {
    const data = await fixture('model = "base-model"\nmodel_provider = "base-provider"\nmodel_reasoning_effort = "medium"\n');
    const env = { TEST_DEVICE_TOKEN: ["test", "device", "token"].join("-") };
    const initial = await loadWorkerConfig(data.configFile, env);

    await writeFile(
      join(data.codexHome, "config.toml"),
      'model = "base-model"\nmodel_provider = "base-provider"\nmodel_reasoning_effort = "medium"\n' +
      '[desktop]\ncodeFontSize = 15\n[projects."/tmp/example"]\ntrust_level = "trusted"\n'
    );
    await writeFile(
      join(data.codexHome, "lark-agent.config.toml"),
      'approval_policy = "on-request"\n[tui.model_availability_nux]\n"another.model" = 3\n'
    );
    const unrelatedChange = await loadWorkerConfig(data.configFile, env);
    expect(unrelatedChange.configFingerprint).toBe(initial.configFingerprint);

    await writeFile(
      join(data.codexHome, "lark-agent.config.toml"),
      'approval_policy = "never"\n[tui.model_availability_nux]\n"another.model" = 3\n'
    );
    const profileChange = await loadWorkerConfig(data.configFile, env);
    expect(profileChange.configFingerprint).not.toBe(initial.configFingerprint);
  });

  it("tracks canonical workspace mappings independently from the continuity fingerprint", async () => {
    const data = await fixture();
    const env = { TEST_DEVICE_TOKEN: "test-device-token" };
    const initial = await loadWorkerConfig(data.configFile, env);
    const secondWorkspace = join(dirname(data.configFile), "workspace-two");
    await mkdir(secondWorkspace);
    const yaml = await import("node:fs/promises").then(({ readFile }) => readFile(data.configFile, "utf8"));
    await writeFile(data.configFile, yaml.replace(JSON.stringify(data.workspace), JSON.stringify(secondWorkspace)));
    const changed = await loadWorkerConfig(data.configFile, env);

    expect(changed.configFingerprint).toBe(initial.configFingerprint);
    expect(changed.workspaceMappingFingerprint).not.toBe(initial.workspaceMappingFingerprint);
    expect(workspaceMappingFingerprint([
      { alias: "b", path: "/canonical/b" },
      { alias: "a", path: "/canonical/a" }
    ])).toBe(workspaceMappingFingerprint([
      { alias: "a", path: "/canonical/a" },
      { alias: "b", path: "/canonical/b" }
    ]));
  });

  it("adds chat_context_v1 to existing explicit capability lists", async () => {
    const data = await fixture();
    const yaml = await import("node:fs/promises").then(({ readFile }) => readFile(data.configFile, "utf8"));
    await writeFile(data.configFile, yaml.replace("  workspace_roots:", "  capabilities:\n    - codex\n  workspace_roots:"));
    const config = await loadWorkerConfig(data.configFile, { TEST_DEVICE_TOKEN: ["test", "device", "token"].join("-") });
    expect(config.capabilities).toEqual([
      "codex",
      "chat_context_v1",
      "skillhub_skills_v1",
      "skill_runtime_config_v1",
      "user_skills_inventory_v1",
      "workspace_mapping_v1",
      "thread_snapshot_v1",
      "thread_turn_summary_v1"
    ]);
  });

  it("rejects legacy embedded profiles", async () => {
    const data = await fixture("[profiles.lark-agent]\nmodel = \"test\"\n");
    await expect(loadWorkerConfig(data.configFile, { TEST_DEVICE_TOKEN: ["test", "device", "token"].join("-") })).rejects.toThrow(/legacy/);
  });

  it("reads a registered device credential from a 0600 file", async () => {
    const data = await fixture();
    const credentialFile = join(dirname(data.configFile), "credentials");
    await writeFile(credentialFile, "registered-device-credential\n", { mode: 0o600 });
    const yaml = await import("node:fs/promises").then(({ readFile }) => readFile(data.configFile, "utf8"));
    await writeFile(data.configFile, yaml.replace("device_token_env: TEST_DEVICE_TOKEN", `device_token_file: ${JSON.stringify(credentialFile)}`));
    const config = await loadWorkerConfig(data.configFile, {});
    expect(config.deviceToken).toBe("registered-device-credential");
    expect(config.deviceTokenEnvironmentName).toBeNull();
    expect(config.runnerVersion).toBe("development");
    expect(config.architecture).toBe(process.arch === "arm64" ? "arm64" : "x64");
  });

  it("rejects a runtime state directory that overlaps a workspace root", async () => {
    const data = await fixture();
    const yaml = await import("node:fs/promises").then(({ readFile }) => readFile(data.configFile, "utf8"));
    const workspace = join(dirname(data.configFile), "workspace");
    await writeFile(data.configFile, yaml.replace("  capacity: 1", `  capacity: 1\n  runtime_state_dir: ${JSON.stringify(join(workspace, ".runner-state"))}`));
    await expect(loadWorkerConfig(data.configFile, { TEST_DEVICE_TOKEN: "test-device-token" })).rejects.toThrow(/must not overlap workspace root/);
  });
});
