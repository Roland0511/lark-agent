import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedTask, TaskRuntimeFile, TaskSkillPackage, WorkspaceRuntimeSyncJob } from "../shared/contracts.js";
import { sha256 } from "../shared/crypto.js";
import type { ResolvedWorkerConfig } from "./config.js";
import type { ControlPlaneClient } from "./control-plane-client.js";
import type { CodexSkillsListEntry } from "./codex-adapter.js";
import { buildUserSkillsReport, effectiveTaskSkills, managedSkillDirectory, SkillRuntimeError, SkillRuntimeManager } from "./skills.js";

const fsFault = vi.hoisted(() => ({ chmodPath: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (fsFault.chmodPath && String(args[0]) === fsFault.chmodPath) {
        throw Object.assign(new Error("injected chmod failure"), { code: "EIO" });
      }
      return actual.chmod(...args);
    }
  };
});

const originalDeviceToken = process.env.LARK_AGENT_DEVICE_TOKEN;
const originalCustomRunnerCredential = process.env.CUSTOM_RUNNER_CREDENTIAL;

afterEach(() => {
  fsFault.chmodPath = null;
  if (originalDeviceToken === undefined) delete process.env.LARK_AGENT_DEVICE_TOKEN;
  else process.env.LARK_AGENT_DEVICE_TOKEN = originalDeviceToken;
  if (originalCustomRunnerCredential === undefined) delete process.env.CUSTOM_RUNNER_CREDENTIAL;
  else process.env.CUSTOM_RUNNER_CREDENTIAL = originalCustomRunnerCredential;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lark-agent-skill-runtime-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await mkdir(join(workspace, ".git", "info"), { recursive: true });
  await mkdir(state);
  const config = {
    runtimeStateDir: state,
    workspaceRoots: [{ alias: "repo", path: workspace }]
  } as ResolvedWorkerConfig;
  return { root, workspace, state, config };
}

function skill(input: Partial<TaskSkillPackage> & Pick<TaskSkillPackage, "packageId" | "coordinate" | "name" | "archiveSha256">): TaskSkillPackage {
  return {
    version: "20260715.1",
    registryFingerprint: `sha256:${input.archiveSha256}`,
    sourceScope: "bot",
    ...input
  };
}

function skillArchive(name: string, extra: Record<string, Uint8Array> = {}): Buffer {
  return Buffer.from(zipSync({
    "SKILL.md": strToU8(`---\nname: ${name}\ndescription: test\n---\n\n# Test\n`),
    "scripts/run.sh": strToU8("#!/bin/sh\necho ok\n"),
    ...extra
  }));
}

function syncJob(files: TaskRuntimeFile[] = [], skills: TaskSkillPackage[] = []): WorkspaceRuntimeSyncJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    botAppId: "cli_test",
    chatContextId: "22222222-2222-4222-8222-222222222222",
    workspaceKey: "22222222-2222-4222-8222-222222222222",
    resolvedWorkspaceAlias: "repo",
    leaseToken: "lease",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    desiredFingerprint: "d".repeat(64),
    skills,
    skillSetFingerprint: sha256(JSON.stringify(skills)),
    runtimeConfig: { fingerprint: sha256(JSON.stringify(files)), files }
  };
}

describe("SkillRuntimeManager managed skills", () => {
  it("uses namespace and slug for managed directories and never removes user repo skills", async () => {
    const { workspace, config } = await fixture();
    const firstArchive = skillArchive("alpha-skill");
    const secondArchive = skillArchive("beta-skill");
    const first = skill({ packageId: "33333333-3333-4333-8333-333333333333", coordinate: "@team-a/shared", name: "alpha-skill", archiveSha256: sha256(firstArchive) });
    const second = skill({ packageId: "44444444-4444-4444-8444-444444444444", coordinate: "@team-b/shared", name: "beta-skill", archiveSha256: sha256(secondArchive) });
    const archives = new Map([[first.packageId, firstArchive], [second.packageId, secondArchive]]);
    let downloadCalls = 0;
    const client = {
      downloadWorkspaceSkillPackage: async (_job: WorkspaceRuntimeSyncJob, item: TaskSkillPackage, target: string) => {
        downloadCalls += 1;
        const archive = archives.get(item.packageId)!;
        await writeFile(target, archive, { mode: 0o600 });
        return { path: target, size: archive.length, sha256: sha256(archive) };
      }
    } as unknown as ControlPlaneClient;
    const userSkill = join(workspace, ".agents", "skills", "user-owned");
    await mkdir(userSkill, { recursive: true });
    await writeFile(join(userSkill, "SKILL.md"), "user content");

    const manager = new SkillRuntimeManager(config, client);
    await expect(manager.applyWorkspaceSync(syncJob([], [first, second]), workspace)).resolves.toMatchObject({ status: "applied" });
    expect(await readFile(join(workspace, ".agents", "skills", managedSkillDirectory(first.coordinate), "SKILL.md"), "utf8")).toContain("alpha-skill");
    expect(await readFile(join(workspace, ".agents", "skills", managedSkillDirectory(second.coordinate), "SKILL.md"), "utf8")).toContain("beta-skill");
    expect(await readFile(join(userSkill, "SKILL.md"), "utf8")).toBe("user content");
    const exclude = await readFile(join(workspace, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(`/.agents/skills/${managedSkillDirectory(first.coordinate)}`);
    expect(exclude).not.toContain("/.agents/skills/\n");

    await writeFile(join(config.runtimeStateDir, "skill-packages", first.archiveSha256, "content", "scripts", "run.sh"), "tampered\n");
    await expect(manager.applyWorkspaceSync(syncJob([], [first, second]), workspace)).resolves.toMatchObject({ status: "applied" });
    expect(downloadCalls).toBe(3);
    expect(await readFile(join(workspace, ".agents", "skills", managedSkillDirectory(first.coordinate), "scripts", "run.sh"), "utf8")).toContain("echo ok");

    await expect(manager.applyWorkspaceSync(syncJob([], []), workspace)).resolves.toMatchObject({ status: "applied" });
    await expect(stat(join(workspace, ".agents", "skills", managedSkillDirectory(first.coordinate)))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(userSkill, "SKILL.md"), "utf8")).toBe("user content");
  });

  it("rejects traversal archives before writing outside the cache", async () => {
    const { root, workspace, config } = await fixture();
    const archive = skillArchive("unsafe-skill", { "../escape.txt": strToU8("escape") });
    const item = skill({ packageId: "55555555-5555-4555-8555-555555555555", coordinate: "@team/unsafe", name: "unsafe-skill", archiveSha256: sha256(archive) });
    const client = {
      downloadWorkspaceSkillPackage: async (_job: WorkspaceRuntimeSyncJob, _item: TaskSkillPackage, target: string) => {
        await writeFile(target, archive);
        return { path: target, size: archive.length, sha256: sha256(archive) };
      }
    } as unknown as ControlPlaneClient;
    const result = await new SkillRuntimeManager(config, client).applyWorkspaceSync(syncJob([], [item]), workspace);
    expect(result.status).toBe("failed");
    expect(await stat(join(root, "escape.txt")).catch(() => null)).toBeNull();
  });

  it("rejects archive paths that collide after NFC normalization and case folding", async () => {
    const { workspace, config } = await fixture();
    const archive = skillArchive("unsafe-skill", {
      "Docs/Guide.md": strToU8("first"),
      "docs/guide.md": strToU8("second")
    });
    const item = skill({ packageId: "55555555-5555-4555-8555-555555555556", coordinate: "@team/collision", name: "unsafe-skill", archiveSha256: sha256(archive) });
    const client = {
      downloadWorkspaceSkillPackage: async (_job: WorkspaceRuntimeSyncJob, _item: TaskSkillPackage, target: string) => {
        await writeFile(target, archive);
        return { path: target, size: archive.length, sha256: sha256(archive) };
      }
    } as unknown as ControlPlaneClient;
    await expect(new SkillRuntimeManager(config, client).applyWorkspaceSync(syncJob([], [item]), workspace))
      .resolves.toMatchObject({ status: "failed" });
  });
});

describe("SkillRuntimeManager persistent runtime files", () => {
  it("updates by target path across immutable revision IDs, detects drift, and only force-deletes explicitly", async () => {
    const { workspace, config } = await fixture();
    const values = new Map<string, Buffer>();
    const client = {
      downloadWorkspaceRuntimeFile: async (_job: WorkspaceRuntimeSyncJob, file: TaskRuntimeFile, target: string) => {
        const content = values.get(file.id)!;
        await writeFile(target, content, { mode: 0o600 });
        return { path: target, size: content.length, sha256: sha256(content) };
      }
    } as unknown as ControlPlaneClient;
    const manager = new SkillRuntimeManager(config, client);
    const oldContent = Buffer.from("TOKEN=old-secret\n");
    const newContent = Buffer.from("TOKEN=new-secret\n");
    const first: TaskRuntimeFile = { id: "66666666-6666-4666-8666-666666666666", targetPath: ".env", revision: 1, sha256: sha256(oldContent), size: oldContent.length, desiredState: "present", force: false };
    values.set(first.id, oldContent);
    expect((await manager.applyWorkspaceSync(syncJob([first]), workspace)).status).toBe("applied");
    expect(await readFile(join(workspace, ".env"), "utf8")).toBe("TOKEN=old-secret\n");
    expect((await lstat(join(workspace, ".env"))).mode & 0o777).toBe(0o600);

    const update: TaskRuntimeFile = { id: "77777777-7777-4777-8777-777777777777", targetPath: ".env", revision: 2, sha256: sha256(newContent), size: newContent.length, desiredState: "present", force: false };
    values.set(update.id, newContent);
    const updated = await manager.applyWorkspaceSync(syncJob([update]), workspace);
    expect(updated.status).toBe("applied");
    expect(updated.files[0]?.status).toBe("applied");
    const taskRuntime = await manager.prepareTaskFilesystem({
      skills: [],
      runtimeConfig: { fingerprint: syncJob([update]).runtimeConfig.fingerprint, environment: [], files: [update] }
    } as ClaimedTask, workspace);
    expect(taskRuntime.redactionValues).toContain("new-secret");
    expect(await readFile(join(workspace, ".env"), "utf8")).toBe("TOKEN=new-secret\n");

    await writeFile(join(workspace, ".env"), "manually changed\n");
    const remove: TaskRuntimeFile = { id: "88888888-8888-4888-8888-888888888888", targetPath: ".env", revision: 3, sha256: sha256(newContent), size: 0, desiredState: "absent", force: false };
    const conflict = await manager.applyWorkspaceSync(syncJob([remove]), workspace);
    expect(conflict.status).toBe("conflict");
    expect(await readFile(join(workspace, ".env"), "utf8")).toBe("manually changed\n");

    const forced = await manager.applyWorkspaceSync(syncJob([{ ...remove, force: true }]), workspace);
    expect(forced.status).toBe("applied");
    expect(forced.files[0]?.status).toBe("deleted");
    await expect(stat(join(workspace, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(workspace, ".git", "info", "exclude"), "utf8")).toContain("/.env");
  });

  it("restores the previous file when permission hardening fails after installation", async () => {
    const { workspace, config } = await fixture();
    const values = new Map<string, Buffer>();
    const client = {
      downloadWorkspaceRuntimeFile: async (_job: WorkspaceRuntimeSyncJob, file: TaskRuntimeFile, target: string) => {
        const content = values.get(file.id)!;
        await writeFile(target, content, { mode: 0o600 });
        return { path: target, size: content.length, sha256: sha256(content) };
      }
    } as unknown as ControlPlaneClient;
    const manager = new SkillRuntimeManager(config, client);
    const oldContent = Buffer.from("TOKEN=old-secret\n");
    const newContent = Buffer.from("TOKEN=new-secret\n");
    const first: TaskRuntimeFile = {
      id: "99999999-9999-4999-8999-999999999991",
      targetPath: ".env",
      revision: 1,
      sha256: sha256(oldContent),
      size: oldContent.length,
      desiredState: "present",
      force: false
    };
    const update: TaskRuntimeFile = {
      ...first,
      id: "99999999-9999-4999-8999-999999999992",
      revision: 2,
      sha256: sha256(newContent),
      size: newContent.length
    };
    values.set(first.id, oldContent);
    values.set(update.id, newContent);
    expect((await manager.applyWorkspaceSync(syncJob([first]), workspace)).status).toBe("applied");

    fsFault.chmodPath = join(workspace, ".env");
    expect((await manager.applyWorkspaceSync(syncJob([update]), workspace)).status).toBe("failed");
    fsFault.chmodPath = null;

    expect(await readFile(join(workspace, ".env"), "utf8")).toBe("TOKEN=old-secret\n");
    expect((await manager.applyWorkspaceSync(syncJob([update]), workspace)).status).toBe("applied");
    expect(await readFile(join(workspace, ".env"), "utf8")).toBe("TOKEN=new-secret\n");
  });

  it("rejects reserved paths and case-insensitive or Unicode-normalized collisions", async () => {
    const { workspace, config } = await fixture();
    const manager = new SkillRuntimeManager(config, {} as ControlPlaneClient);
    const content = Buffer.from("safe");
    const makeFile = (id: string, targetPath: string): TaskRuntimeFile => ({
      id,
      targetPath,
      revision: 1,
      sha256: sha256(content),
      size: content.length,
      desiredState: "present",
      force: false
    });
    await expect(manager.applyWorkspaceSync(syncJob([
      makeFile("11111111-1111-4111-8111-111111111112", ".Git/config")
    ]), workspace)).resolves.toMatchObject({ status: "conflict" });
    await expect(manager.applyWorkspaceSync(syncJob([
      makeFile("11111111-1111-4111-8111-111111111113", "A.env"),
      makeFile("11111111-1111-4111-8111-111111111114", "a.env")
    ]), workspace)).resolves.toMatchObject({ status: "conflict" });
    await expect(manager.applyWorkspaceSync(syncJob([
      makeFile("11111111-1111-4111-8111-111111111115", "caf\u00e9.env"),
      makeFile("11111111-1111-4111-8111-111111111116", "cafe\u0301.env")
    ]), workspace)).resolves.toMatchObject({ status: "conflict" });
  });

  it("supports worktree Git metadata and refuses a symlinked exclude file before writing secrets", async () => {
    const { root, workspace, config } = await fixture();
    await stat(join(workspace, ".git"));
    const gitCommon = join(root, "repo.git");
    const gitWorktree = join(gitCommon, "worktrees", "chat");
    await mkdir(join(gitCommon, "info"), { recursive: true });
    await mkdir(join(gitCommon, "objects"), { recursive: true });
    await mkdir(gitWorktree, { recursive: true });
    await writeFile(join(gitCommon, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(gitWorktree, "commondir"), "../..\n");
    await writeFile(join(gitWorktree, "gitdir"), `${join(workspace, ".git")}\n`);
    await writeFile(join(workspace, ".git-pointer"), `gitdir: ${gitWorktree}\n`);
    await rm(join(workspace, ".git"), { recursive: true });
    await rename(join(workspace, ".git-pointer"), join(workspace, ".git"));
    const victim = join(root, "victim.txt");
    await writeFile(victim, "unchanged\n");
    await symlink(victim, join(gitCommon, "info", "exclude"));
    const secret = Buffer.from("TOKEN=secret\n");
    const file: TaskRuntimeFile = {
      id: "11111111-1111-4111-8111-111111111117",
      targetPath: ".env",
      revision: 1,
      sha256: sha256(secret),
      size: secret.length,
      desiredState: "present",
      force: false
    };
    const result = await new SkillRuntimeManager(config, {} as ControlPlaneClient).applyWorkspaceSync(syncJob([file]), workspace);
    expect(result).toMatchObject({ status: "conflict" });
    expect(await stat(join(workspace, ".env")).catch(() => null)).toBeNull();
    expect(await readFile(victim, "utf8")).toBe("unchanged\n");
  });

  it("rejects a forged worktree pointer that does not link back to the workspace", async () => {
    const { root, workspace, config } = await fixture();
    const forgedCommon = join(root, "forged.git");
    const forgedWorktree = join(forgedCommon, "worktrees", "chat");
    await mkdir(join(forgedCommon, "info"), { recursive: true });
    await mkdir(join(forgedCommon, "objects"), { recursive: true });
    await mkdir(forgedWorktree, { recursive: true });
    await writeFile(join(forgedCommon, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(forgedWorktree, "commondir"), "../..\n");
    await writeFile(join(forgedWorktree, "gitdir"), `${join(root, "another-workspace", ".git")}\n`);
    await rm(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git"), `gitdir: ${forgedWorktree}\n`);
    const secret = Buffer.from("TOKEN=secret\n");
    const file: TaskRuntimeFile = {
      id: "11111111-1111-4111-8111-111111111118",
      targetPath: ".env",
      revision: 1,
      sha256: sha256(secret),
      size: secret.length,
      desiredState: "present",
      force: false
    };
    const result = await new SkillRuntimeManager(config, {} as ControlPlaneClient).applyWorkspaceSync(syncJob([file]), workspace);
    expect(result).toMatchObject({ status: "conflict" });
    expect(await stat(join(workspace, ".env")).catch(() => null)).toBeNull();
    expect(await stat(join(forgedCommon, "info", "exclude")).catch(() => null)).toBeNull();
  });

  it("does not leave a secret or manifest when the Git exclude file cannot be updated", async () => {
    const { workspace, config } = await fixture();
    const exclude = join(workspace, ".git", "info", "exclude");
    await writeFile(exclude, "# locked\n", { mode: 0o400 });
    await chmod(exclude, 0o400);
    const secret = Buffer.from("TOKEN=secret\n");
    const file: TaskRuntimeFile = {
      id: "11111111-1111-4111-8111-111111111119",
      targetPath: ".env",
      revision: 1,
      sha256: sha256(secret),
      size: secret.length,
      desiredState: "present",
      force: false
    };
    const result = await new SkillRuntimeManager(config, {} as ControlPlaneClient).applyWorkspaceSync(syncJob([file]), workspace);
    expect(result).toMatchObject({ status: "conflict" });
    expect(await stat(join(workspace, ".env")).catch(() => null)).toBeNull();
    expect(await stat(join(workspace, ".lark-agent", "runtime-files.json")).catch(() => null)).toBeNull();
  });

  it("does not commit downloaded runtime files after the sync lease is lost", async () => {
    const { workspace, config } = await fixture();
    const secret = Buffer.from("TOKEN=secret\n");
    const file: TaskRuntimeFile = {
      id: "11111111-1111-4111-8111-111111111120",
      targetPath: ".env",
      revision: 1,
      sha256: sha256(secret),
      size: secret.length,
      desiredState: "present",
      force: false
    };
    let leaseValid = true;
    const client = {
      downloadWorkspaceRuntimeFile: async (_job: WorkspaceRuntimeSyncJob, _file: TaskRuntimeFile, target: string) => {
        await writeFile(target, secret, { mode: 0o600 });
        leaseValid = false;
        return { path: target, size: secret.length, sha256: sha256(secret) };
      }
    } as unknown as ControlPlaneClient;
    const result = await new SkillRuntimeManager(config, client).applyWorkspaceSync(
      syncJob([file]),
      workspace,
      undefined,
      () => { if (!leaseValid) throw new Error("lease lost"); }
    );
    expect(result).toMatchObject({ status: "failed", files: [] });
    expect(await stat(join(workspace, ".env")).catch(() => null)).toBeNull();
    expect(await stat(join(workspace, ".lark-agent", "runtime-files.json")).catch(() => null)).toBeNull();
  });
});

describe("Runner skill inventory and environment isolation", () => {
  it("reports only enabled user skills and redacts the home directory", async () => {
    const entries: CodexSkillsListEntry[] = [{
      cwd: "/workspace",
      skills: [
        { name: "user-skill", description: "user", path: join(homedir(), ".agents", "skills", "user-skill", "SKILL.md"), scope: "user", enabled: true, shortDescription: null, interface: null, dependencies: [] },
        { name: "disabled", description: "disabled", path: join(homedir(), ".agents", "skills", "disabled", "SKILL.md"), scope: "user", enabled: false, shortDescription: null, interface: null, dependencies: [] },
        { name: "repo", description: "repo", path: "/workspace/.agents/skills/repo/SKILL.md", scope: "repo", enabled: true, shortDescription: null, interface: null, dependencies: [] }
      ],
      errors: []
    }];
    const report = await buildUserSkillsReport(entries);
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]?.relativePath).toBe("~/.agents/skills/user-skill/SKILL.md");
    expect(JSON.stringify(report)).not.toContain(homedir());
  });

  it("does not report absolute paths from Codex user-skill scan errors", async () => {
    const report = await buildUserSkillsReport([{
      cwd: "/workspace",
      skills: [],
      errors: [{ message: "failed to read /Volumes/Private/workspace/.agents/skills/secret/SKILL.md" }]
    }]);
    expect(report.status).toBe("stale");
    expect(report.errors).toEqual(["用户级技能扫描遇到错误，已保留上次可用清单。"]);
    expect(JSON.stringify(report)).not.toContain("/Volumes/Private");
  });

  it("injects only declared runtime values and excludes Runner control credentials from command inheritance", async () => {
    const { config } = await fixture();
    process.env.LARK_AGENT_DEVICE_TOKEN = "must-not-leak";
    process.env.CUSTOM_RUNNER_CREDENTIAL = "must-also-not-leak";
    config.deviceTokenEnvironmentName = "CUSTOM_RUNNER_CREDENTIAL";
    const runtimeFingerprint = "a".repeat(64);
    const client = {
      runtimeEnvironment: async () => ({ fingerprint: runtimeFingerprint, variables: [{ name: "SKILL_ACCESS_TOKEN", value: "runtime-secret" }] })
    } as unknown as ControlPlaneClient;
    const task = {
      runtimeConfig: { fingerprint: runtimeFingerprint, environment: [{ name: "SKILL_ACCESS_TOKEN" }], files: [] }
    } as ClaimedTask;
    const runtime = await new SkillRuntimeManager(config, client).environmentForTask(task);
    expect(runtime.environment.SKILL_ACCESS_TOKEN).toBe("runtime-secret");
    expect(runtime.environment.LARK_AGENT_DEVICE_TOKEN).toBeUndefined();
    expect(runtime.environment.CUSTOM_RUNNER_CREDENTIAL).toBeUndefined();
    expect(runtime.allowlist).toContain("SKILL_ACCESS_TOKEN");
    expect(runtime.allowlist).toContain("PATH");
    expect(runtime.allowlist).not.toContain("LARK_AGENT_DEVICE_TOKEN");
    expect(runtime.allowlist).not.toContain("CUSTOM_RUNNER_CREDENTIAL");
    expect(runtime.redactionValues).toEqual(["runtime-secret"]);

    const emptyRuntime = await new SkillRuntimeManager(config, client).environmentForTask({
      runtimeConfig: { fingerprint: runtimeFingerprint, environment: [], files: [] }
    } as ClaimedTask);
    expect(emptyRuntime.environment.CUSTOM_RUNNER_CREDENTIAL).toBeUndefined();
    expect(emptyRuntime.allowlist).not.toContain("CUSTOM_RUNNER_CREDENTIAL");

    for (const name of ["CODEX_HOME", "PYTHONPATH", "LARK_AGENT_DEVICE_TOKEN", "SKILL_RUNTIME_ACTIVE_KEY_ID"]) {
      await expect(new SkillRuntimeManager(config, client).environmentForTask({
        runtimeConfig: { fingerprint: runtimeFingerprint, environment: [{ name }], files: [] }
      } as ClaimedTask)).rejects.toMatchObject<Partial<SkillRuntimeError>>({ code: "runtime_environment_name_forbidden" });
    }
  });
});

describe("effectiveTaskSkills", () => {
  it("lets a thread binding replace the bot binding for the same coordinate", () => {
    const archive = "a".repeat(64);
    const global = skill({ packageId: "99999999-9999-4999-8999-999999999999", coordinate: "@team/tool", name: "tool", archiveSha256: archive, version: "1", sourceScope: "bot" });
    const local = skill({ packageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", coordinate: "@team/tool", name: "tool", archiveSha256: "b".repeat(64), version: "2", sourceScope: "chat_context" });
    expect(effectiveTaskSkills([global, local])).toEqual([local]);
  });
});
