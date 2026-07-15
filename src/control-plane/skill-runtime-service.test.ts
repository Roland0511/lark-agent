import { describe, expect, it } from "vitest";
import { runtimePathCollisionKey, validateEnvironmentName, validateRuntimeFilePath, validateRuntimeFileResults, validateRuntimeIdentity } from "./skill-runtime-service.js";
import { normalizeDeclaredDependencies, parseSkillCoordinate } from "./skillhub-service.js";

describe("skill runtime input validation", () => {
  it("accepts SkillHub coordinates supported by the shared contract", () => {
    expect(parseSkillCoordinate("@team_name/git_commit")).toEqual({ namespace: "team_name", slug: "git_commit" });
    expect(() => parseSkillCoordinate("global/git-commit")).toThrow("@namespace/slug");
  });

  it("rejects incomplete, stale, or digest-mismatched runtime reports", () => {
    const expected = [{ id: "10000000-0000-4000-8000-000000000001", bindingId: "b", targetPath: ".env", revision: 2, sha256: "a".repeat(64), size: 8, desiredState: "present" as const, scope: "bot" as const, downloadPath: null }];
    expect(() => validateRuntimeFileResults(expected, [], true)).toThrow("未完整覆盖");
    expect(() => validateRuntimeFileResults(expected, [{ id: expected[0]!.id, targetPath: ".env", revision: 1, actualSha256: "a".repeat(64), status: "applied" }], true)).toThrow("过期");
    expect(() => validateRuntimeFileResults(expected, [{ id: expected[0]!.id, targetPath: ".env", revision: 2, actualSha256: "b".repeat(64), status: "applied" }], true)).toThrow("期望文件状态");
    expect(() => validateRuntimeFileResults(expected, [], false)).not.toThrow();
    expect(() => validateRuntimeFileResults(expected, [{ id: expected[0]!.id, targetPath: ".env", revision: 2, actualSha256: null, status: "conflict", errorCode: "runtime_file_drift" }], false)).not.toThrow();
    expect(() => validateRuntimeFileResults(expected, [{ id: expected[0]!.id, targetPath: ".env", revision: 2, actualSha256: null, status: "conflict" }], false)).toThrow("缺少对应文件错误");
    const absent = [{ ...expected[0]!, desiredState: "absent" as const, sha256: "0".repeat(64), size: 0 }];
    expect(() => validateRuntimeFileResults(absent, [{ id: absent[0]!.id, targetPath: ".env", revision: 2, actualSha256: null, status: "unchanged" }], true)).not.toThrow();
  });

  it("normalizes declared tool dependencies without passing arbitrary metadata through", () => {
    expect(normalizeDeclaredDependencies({ tools: [
      "git", { type: "binary", value: "gh", description: "GitHub CLI" }, { type: "bad type", value: "ignored" }
    ], environment: [{ name: "SECRET" }], arbitrary: { secret: true } })).toEqual({ tools: [
      { type: "tool", value: "git", description: null }, { type: "binary", value: "gh", description: "GitHub CLI" }
    ] });
  });

  it("rejects missing managed skills and environment names", () => {
    const skill = { packageId: "10000000-0000-4000-8000-000000000001", coordinate: "@team/tool", name: "tool", version: "1", registryFingerprint: "sha256:x", archiveSha256: "a".repeat(64), sourceScope: "bot" };
    expect(() => validateRuntimeIdentity([skill], [], ["API_TOKEN"], ["API_TOKEN"])).toThrow("托管技能集合");
    expect(() => validateRuntimeIdentity([skill], [skill], ["API_TOKEN"], [])).toThrow("环境变量名称");
  });

  it("blocks control-process and loader environment variables", () => {
    expect(validateEnvironmentName("API_TOKEN")).toBe("API_TOKEN");
    for (const name of ["HOME", "CODEX_HOME", "codeX_home", "CODEX_SQLITE_HOME", "LD_PRELOAD", "ld_preload", "DYLD_INSERT_LIBRARIES", "GIT_CONFIG_COUNT", "git_config_count", "SSH_ASKPASS"]) {
      expect(() => validateEnvironmentName(name)).toThrow("不能由技能覆盖");
    }
  });

  it("allows dotfiles but rejects traversal, non-NFC paths, and case-insensitive reserved directories", () => {
    expect(validateRuntimeFilePath(".env")).toBe(".env");
    expect(validateRuntimeFilePath("config/service.yaml")).toBe("config/service.yaml");
    expect(runtimePathCollisionKey("A.env")).toBe(runtimePathCollisionKey("a.env"));
    for (const path of ["../.env", "/tmp/.env", "config/.agents/secret", "nested/.git/config", "nested/.Git/config", "a//b", "cafe\u0301.env"]) {
      expect(() => validateRuntimeFilePath(path)).toThrow();
    }
  });
});
