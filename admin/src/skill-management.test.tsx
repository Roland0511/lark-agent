// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BotSkillsCard, ChatSkillOverview, normalizeSkillBindings, RuntimeConfigPanel, TaskSkillSnapshot, WorkerUserSkills,
  type SkillBindingView
} from "./skill-management";
import type { AdminUser } from "./api";

const user: AdminUser = { openId: "masked", displayName: "主人", role: "owner", csrfToken: "csrf-token", agentDisplayName: "阿朱" };

function ok(body: unknown, status = 200) {
  return Promise.resolve({ ok: true, status, json: async () => body });
}

function wrapper(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("技能数据分层", () => {
  it("兼容全局和 Thread 分组返回并保留固定版本", () => {
    const result = normalizeSkillBindings({
      globalSkills: [{ id: "global-1", coordinate: "@sh01/git-commit", version: "20260605.221003", syncStatus: "applied" }],
      threadSkills: [{ chatContextId: "context-1", chatName: "项目群", skills: [{ id: "thread-1", coordinate: "@sh01/lark-doc", version: "7" }] }]
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ scope: "bot", coordinate: "@sh01/git-commit", version: "20260605.221003" });
    expect(result[1]).toMatchObject({ scope: "chat_context", chatContextId: "context-1", chatName: "项目群" });
  });

  it("聊天详情始终让 Thread 专属版本覆盖同坐标的全局版本", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({ items: [
      { id: "thread-1", coordinate: "@sh01/git-commit", version: "2", scope: "chat_context", chatContextId: "context-1", fileCount: 1 },
      { id: "global-1", coordinate: "@sh01/git-commit", version: "1", scope: "bot", fileCount: 2 }
    ] })));

    render(wrapper(<ChatSkillOverview botId="bot-1" context={{
      id: "context-1",
      desiredSkillSetFingerprint: "a".repeat(64),
      appliedSkillSetFingerprint: "a".repeat(64)
    }} user={user} />));

    expect(await screen.findByText("固定版本 2")).toBeTruthy();
    expect(screen.queryByText("固定版本 1")).toBeNull();
    expect(screen.getByText("已应用")).toBeTruthy();
    expect(screen.getByText("1 个已配置项")).toBeTruthy();
  });

  it("同步失败时允许主人从聊天详情重新同步", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (path === "/v1/admin/bots/bot-1/skills?chatContextId=context-1") return ok({ items: [{ id: "global-1", coordinate: "@sh01/git-commit", version: "1", scope: "bot" }] });
      if (path === "/v1/admin/workers/runner-1/user-skills") return ok({ status: "ready", skills: [] });
      if (path === "/v1/admin/chat-contexts/context-1/skill-runtime/retry" && init?.method === "POST") return ok({ ok: true, queued: true });
      throw new Error(`unexpected fetch ${path}`);
    }));

    render(wrapper(<ChatSkillOverview botId="bot-1" context={{
      id: "context-1", executorId: "runner-1", skillsSyncError: "temporary registry outage",
      desiredSkillSetFingerprint: "a".repeat(64), appliedSkillSetFingerprint: "b".repeat(64)
    }} user={user} />));

    expect(await screen.findByText("工作区技能同步失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新同步" }));
    await waitFor(() => expect(calls.some(([path, init]) => path === "/v1/admin/chat-contexts/context-1/skill-runtime/retry" && init?.method === "POST")).toBe(true));
    const retry = calls.find(([path, init]) => path === "/v1/admin/chat-contexts/context-1/skill-runtime/retry" && init?.method === "POST");
    expect(new Headers(retry?.[1]?.headers).get("x-csrf-token")).toBe("csrf-token");
  });
});

describe("机器人技能管理", () => {
  it("展示低密度摘要，并按指定 Thread 添加技能", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (path === "/v1/admin/bots/bot-1/skills" && init?.method === "POST") return ok({ ok: true }, 201);
      if (path === "/v1/admin/bots/bot-1/skills") return ok({ items: [
        { id: "global-1", coordinate: "@sh01/git-commit", version: "1", scope: "bot", syncStatus: "applied", declaredDependencies: { tools: [{ type: "command", value: "git" }] } },
        { id: "thread-1", coordinate: "@sh01/lark-doc", version: "2", scope: "chat_context", chatContextId: "context-1", chatName: "项目群", syncStatus: "pending" }
      ] });
      if (path === "/v1/admin/skillhub/status") return ok({ configured: true, authenticated: true, registryUrl: "https://skillhub.example.internal/" });
      if (path.startsWith("/v1/admin/chat-contexts?")) return ok({ items: [{ id: "context-1", chatName: "项目群", chatType: "group", executorId: "runner-1" }] });
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(wrapper(<BotSkillsCard bot={{ id: "bot-1", displayName: "项目助理", defaultExecutorId: "runner-1" }} workers={[]} user={user} />));
    expect(await screen.findByText("全局与 Thread 专属技能按需合并")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "管理技能" }));

    expect(await screen.findByRole("dialog", { name: "项目助理 · 技能管理" })).toBeTruthy();
    expect(screen.getByText("技能声明依赖：command git")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("技能名称"), { target: { value: "@sh01/database-guide" } });
    fireEvent.change(screen.getByLabelText("生效范围"), { target: { value: "chat_context" } });
    fireEvent.change(await screen.findByLabelText("聊天 Thread"), { target: { value: "context-1" } });
    fireEvent.click(screen.getByRole("button", { name: "添加技能" }));

    await waitFor(() => expect(calls.some(([path, init]) => path === "/v1/admin/bots/bot-1/skills" && init?.method === "POST")).toBe(true));
    const addCall = calls.find(([path, init]) => path === "/v1/admin/bots/bot-1/skills" && init?.method === "POST");
    expect(addCall?.[1]?.body).toBe(JSON.stringify({ coordinate: "@sh01/database-guide", scope: "chat_context", chatContextId: "context-1" }));
    expect(new Headers(addCall?.[1]?.headers).get("x-csrf-token")).toBe("csrf-token");
  });

  it("Token 未通过认证时禁用添加操作", async () => {
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      if (path === "/v1/admin/bots/bot-1/skills") return ok({ items: [] });
      if (path === "/v1/admin/skillhub/status") return ok({ configured: true, authenticated: false, registryUrl: "https://skillhub.example.internal/" });
      if (path.startsWith("/v1/admin/chat-contexts?")) return ok({ items: [] });
      throw new Error(`unexpected fetch ${path}`);
    }));

    render(wrapper(<BotSkillsCard bot={{ id: "bot-1", displayName: "项目助理" }} workers={[]} user={user} />));
    fireEvent.click(await screen.findByRole("button", { name: "管理技能" }));
    expect(await screen.findByText("SkillHub 暂不可配置")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("技能名称"), { target: { value: "@sh01/git-commit" } });
    expect((screen.getByRole("button", { name: "添加技能" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("技能运行依赖", () => {
  const binding: SkillBindingView = {
    id: "binding-1",
    coordinate: "@sh01/git-commit",
    name: "git-commit",
    version: "20260605.221003",
    description: "提交规范",
    scope: "bot",
    chatContextId: null,
    chatName: null,
    syncStatus: "applied",
    updatedAt: null,
    environmentCount: 1,
    fileCount: 1,
    declaredDependencies: []
  };

  it("环境变量不可回读，文件使用 multipart 上传并可删除", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (!init?.method || init.method === "GET") return ok({
        environment: [{ name: "LARK_API_TOKEN", sourceScope: "bot", mode: "configured", updatedAt: "2026-07-15T08:00:00Z", value: "must-not-render" }],
        files: [{ id: "file-1", targetPath: ".env", sourceScope: "bot", status: "drift", revision: 3, size: 24, desiredSha256: "sha256:expected", actualSha256: "sha256:changed" }]
      });
      return ok({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(wrapper(<RuntimeConfigPanel botId="bot-1" binding={binding} contexts={[]} user={user} />));
    expect(await screen.findByText("LARK_API_TOKEN")).toBeTruthy();
    expect(screen.queryByText("must-not-render")).toBeNull();
    expect(screen.getByText("内容漂移")).toBeTruthy();
    expect(screen.getByText("选择异常 Thread 后处理")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "覆盖工作区版本" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect((screen.getByLabelText("环境变量名") as HTMLInputElement).value).toBe("LARK_API_TOKEN");

    fireEvent.change(screen.getByLabelText("环境变量名"), { target: { value: "SERVICE_TOKEN" } });
    fireEvent.change(screen.getByLabelText("环境变量值"), { target: { value: "top-secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "保存变量" }));
    await waitFor(() => expect(calls.some(([path, init]) => path.endsWith("/env/SERVICE_TOKEN") && init?.method === "PUT")).toBe(true));
    const envCall = calls.find(([path, init]) => path.endsWith("/env/SERVICE_TOKEN") && init?.method === "PUT");
    expect(envCall?.[1]?.body).toBe(JSON.stringify({ value: "top-secret-value" }));
    await waitFor(() => expect((screen.getByLabelText("环境变量值") as HTMLInputElement).value).toBe(""));
    expect(screen.queryByText("top-secret-value")).toBeNull();

    fireEvent.change(screen.getByLabelText("工作区相对路径"), { target: { value: "config/service.env" } });
    const file = new File(["TOKEN=secret"], "service.env", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("选择配置文件"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "上传并跟踪" }));
    await waitFor(() => expect(calls.some(([path, init]) => path.endsWith("/runtime-config/files") && init?.method === "POST")).toBe(true));
    const uploadCall = calls.find(([path, init]) => path.endsWith("/runtime-config/files") && init?.method === "POST");
    expect(uploadCall?.[1]?.body).toBeInstanceOf(FormData);
    expect((uploadCall?.[1]?.body as FormData).get("targetPath")).toBe("config/service.env");
    expect(new Headers(uploadCall?.[1]?.headers).get("content-type")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "删除文件" }));
    await waitFor(() => expect(calls.some(([path, init]) => path.endsWith("/files/file-1") && init?.method === "DELETE")).toBe(true));
  });

  it("仅在选择具体异常 Thread 后允许强制覆盖", async () => {
    const contextId = "11111111-1111-4111-8111-111111111111";
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (init?.method === "POST") return ok({ ok: true });
      return ok({
        environment: [],
        files: [{ id: "file-1", targetPath: ".env", sourceScope: "bot", status: "conflict", revision: 3 }]
      });
    }));

    render(wrapper(<RuntimeConfigPanel botId="bot-1" binding={binding} contexts={[{ id: contextId, chatName: "异常项目群" }]} user={user} />));
    expect(await screen.findByText("选择异常 Thread 后处理")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "覆盖工作区版本" })).toBeNull();

    fireEvent.change(screen.getByLabelText("运行依赖配置范围"), { target: { value: contextId } });
    fireEvent.click(await screen.findByRole("button", { name: "覆盖工作区版本" }));

    await waitFor(() => expect(calls.some(([path, init]) => path.endsWith("/files/file-1/force-apply") && init?.method === "POST")).toBe(true));
    const forceCall = calls.find(([path, init]) => path.endsWith("/files/file-1/force-apply") && init?.method === "POST");
    expect(forceCall?.[1]?.body).toBe(JSON.stringify({ chatContextId: contextId }));
  });

  it("兼容控制面 scope 与 desiredState 字段并识别 Thread 覆盖", async () => {
    vi.stubGlobal("fetch", vi.fn((path: string) => ok(path.includes("chatContextId=context-1") ? {
      environment: [{ id: "env-1", name: "THREAD_TOKEN", mode: "configured", scope: "chat_context" }],
      files: [{ id: "file-2", targetPath: ".env.thread", desiredState: "absent", scope: "chat_context", status: "pending_delete", revision: 2 }]
    } : { environment: [], files: [] })));

    render(wrapper(<RuntimeConfigPanel botId="bot-1" binding={binding} contexts={[{ id: "context-1", chatName: "项目群" }]} user={user} />));
    fireEvent.change(screen.getByLabelText("运行依赖配置范围"), { target: { value: "context-1" } });

    expect(await screen.findByText("Thread 覆盖 · 已设置")).toBeTruthy();
    expect(screen.getAllByText("此 Thread 不提供").length).toBeGreaterThan(0);
    expect(screen.getByText("等待删除")).toBeTruthy();
  });
});

describe("Runner 继承与任务快照", () => {
  it("用户级技能只读展示，不提供修改操作", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({ status: "ready", scannedAt: "2026-07-15T08:00:00Z", skills: [{ name: "git-commit", displayName: null, shortDescription: "提交规范", relativePath: "~/.agents/skills/git-commit", skillhub: { coordinate: "@sh01/git-commit", version: "1" } }] })));
    render(wrapper(<WorkerUserSkills worker={{ executor_id: "runner-1", display_name: "阿朱本机" }} expanded />));

    expect(await screen.findByText("git-commit")).toBeTruthy();
    expect(screen.getByText(/只读 · 来自 Runner 执行用户/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /安装|更新|删除/ })).toBeNull();
  });

  it("兼容用户级技能扫描的 error 字段", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({ status: "error", scannedAt: "2026-07-15T08:00:00Z", skills: [], error: "扫描失败" })));
    render(wrapper(<WorkerUserSkills worker={{ executor_id: "runner-1", display_name: "阿朱本机" }} expanded />));

    expect(await screen.findByText("扫描失败，正在展示上一次成功快照。")).toBeTruthy();
  });

  it("任务详情只展示变量名和文件路径，不泄露值与正文", () => {
    render(<TaskSkillSnapshot task={{
      skill_set_fingerprint: "sha256:skill-set-fingerprint",
      skill_set_snapshot: [{ coordinate: "@sh01/git-commit", version: "1", sourceScope: "chat_context" }],
      user_skill_snapshot: [{ name: "database-guide", version: "2" }],
      runtime_config_snapshot: {
        environment: [{ name: "SERVICE_TOKEN", value: "must-not-render" }],
        files: [{ targetPath: ".env", content: "SECRET=must-not-render" }]
      }
    }} />);

    expect(screen.getByText("@sh01/git-commit")).toBeTruthy();
    expect(screen.getByText("Thread 专属")).toBeTruthy();
    expect(screen.getByText("SERVICE_TOKEN")).toBeTruthy();
    expect(screen.getByText(".env")).toBeTruthy();
    expect(screen.queryByText(/must-not-render/)).toBeNull();
  });
});
