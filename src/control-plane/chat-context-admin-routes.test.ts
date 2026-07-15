import { describe, expect, it } from "vitest";
import { AppError } from "../shared/errors.js";
import { buildChatContextRecoveryChecks, parseChatContextId, parseChatContextListQuery, redactAbsoluteLocalPath } from "./chat-context-admin-routes.js";

describe("聊天记忆管理接口脱敏", () => {
  it("只返回逻辑工作区别名，不暴露 Runner 本机绝对路径", () => {
    expect(redactAbsoluteLocalPath("workspace-sh01")).toBe("workspace-sh01");
    expect(redactAbsoluteLocalPath("/tmp/runner-workspace")).toBe("已配置（本机路径已隐藏）");
    expect(redactAbsoluteLocalPath("C:\\Users\\runner\\workspace")).toBe("已配置（本机路径已隐藏）");
    expect(redactAbsoluteLocalPath("\\\\runner\\workspace")).toBe("已配置（本机路径已隐藏）");
  });

  it("把非法 Chat Context ID 转成受控的 400 错误", () => {
    expect(parseChatContextId("018f90b0-b30c-7a11-a523-5d303ef41234")).toBe("018f90b0-b30c-7a11-a523-5d303ef41234");
    try {
      parseChatContextId("not-a-uuid");
      throw new Error("expected parseChatContextId to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(400);
      expect((error as AppError).code).toBe("invalid_chat_context_id");
    }
  });

  it("把非法状态筛选转成受控的 400 错误", () => {
    expect(() => parseChatContextListQuery({ state: "unknown" })).toThrowError(expect.objectContaining({
      statusCode: 400,
      code: "invalid_chat_context_filter"
    }));
  });

  it("恢复检查全部通过时只返回人类可读结论，不回显身份值", () => {
    const sensitiveHome = "/private/runner/.codex";
    const sensitiveFingerprint = "f".repeat(64);
    const sensitiveMappingFingerprint = "e".repeat(64);
    const checks = buildChatContextRecoveryChecks({
      codex_thread_id: "thread-1",
      executor_id: "worker-a",
      executor_home_ref: sensitiveHome,
      executor_profile: "private-profile",
      executor_config_fingerprint: sensitiveFingerprint,
      executor_workspace_mapping_fingerprint: sensitiveMappingFingerprint,
      workspace_root_alias: "private-workspace"
    }, {
      executor_id: "worker-a",
      home_ref: sensitiveHome,
      codex_profile: "private-profile",
      config_fingerprint: sensitiveFingerprint,
      workspace_mapping_fingerprint: sensitiveMappingFingerprint,
      workspace_aliases: ["private-workspace"],
      capabilities: ["codex", "chat_context_v1", "workspace_mapping_v1"],
      operational_mode: "enabled",
      deleted_at: null
    });

    expect(checks).toHaveLength(9);
    expect(checks.every((item) => item.state === "pass")).toBe(true);
    const publicResult = JSON.stringify(checks);
    expect(publicResult).not.toContain(sensitiveHome);
    expect(publicResult).not.toContain(sensitiveFingerprint);
    expect(publicResult).not.toContain(sensitiveMappingFingerprint);
    expect(publicResult).not.toContain("private-profile");
    expect(publicResult).not.toContain("private-workspace");
  });

  it("逐项报告恢复失败原因，且不会把预期不一致转换成异常", () => {
    const checks = buildChatContextRecoveryChecks({
      codex_thread_id: "thread-1",
      executor_id: "worker-a",
      executor_home_ref: "old-home",
      executor_profile: "old-profile",
      executor_config_fingerprint: "old-fingerprint",
      executor_workspace_mapping_fingerprint: "old-mapping",
      workspace_root_alias: "old-workspace"
    }, {
      executor_id: "worker-a",
      home_ref: "new-home",
      codex_profile: "new-profile",
      config_fingerprint: "new-fingerprint",
      workspace_mapping_fingerprint: "new-mapping",
      workspace_aliases: ["new-workspace"],
      capabilities: ["codex"],
      operational_mode: "maintenance",
      deleted_at: null
    });

    expect(checks.filter((item) => item.state === "fail").map((item) => item.key)).toEqual([
      "claimable", "capability", "homeIdentity", "profile", "workspaceAlias", "workspaceMapping", "configFingerprint"
    ]);
  });

  it("关联任务出现替代 Thread 时保持阻塞", () => {
    const checks = buildChatContextRecoveryChecks({
      codex_thread_id: "thread-original",
      thread_consistent: false,
      executor_id: null,
      executor_home_ref: null,
      executor_profile: null,
      executor_config_fingerprint: null,
      executor_workspace_mapping_fingerprint: null,
      workspace_root_alias: null
    }, null);

    expect(checks).toContainEqual(expect.objectContaining({
      key: "thread",
      state: "fail",
      detail: expect.stringContaining("不同 Thread")
    }));
  });
});
