// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMemoryTable, ThreadMemoryItemCard, ThreadMemorySnapshot } from "./App";
import type { AdminUser } from "./api";

const user: AdminUser = { openId: "owner", displayName: "主人", role: "owner", csrfToken: "csrf-token", agentDisplayName: "阿朱" };

function ok(body: unknown, status = 200) {
  return Promise.resolve({ ok: true, status, json: async () => body });
}

function renderSnapshot(contextId = "context-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><ThreadMemorySnapshot contextId={contextId} threadId="thread-1" user={user} /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("聊天记忆列表", () => {
  it("展示长期绑定关键信息并提供只读下钻", () => {
    const onOpen = vi.fn();
    render(<ChatMemoryTable items={[{
      id: "018f90b0-b30c-7a11-a523-5d303ef41234",
      botDisplayName: "项目助理",
      chatType: "group",
      chatName: "群聊 A",
      chatId: "oc_chat_a",
      threadId: "0190f8c5-5605-7d08-9000-thread-a",
      state: "ready",
      executorId: "runner-sh01",
      executorDisplayName: "阿朱 SH01",
      workspaceRootAlias: "workspace",
      autoCompactionCount: 3,
      lastCompactedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString()
    }]} onOpen={onOpen} />);

    expect(screen.getByText("项目助理")).toBeTruthy();
    expect(screen.getByText("群聊 A")).toBeTruthy();
    expect(screen.getByText("已绑定")).toBeTruthy();
    expect(screen.getByText("阿朱 SH01")).toBeTruthy();
    expect(screen.getByText("runner-sh01")).toBeTruthy();
    expect(screen.getByText("workspace")).toBeTruthy();
    expect(screen.getByText("3 次")).toBeTruthy();
    expect(screen.queryByText(/重置|删除工作区|最大轮数/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看 群聊 A 的聊天记忆" }));
    expect(onOpen).toHaveBeenCalledWith("018f90b0-b30c-7a11-a523-5d303ef41234");
  });

  it("用私聊对象区分不同聊天，并仅在重名时追加脱敏 ID", () => {
    render(<ChatMemoryTable items={[
      { id: "context-a", botDisplayName: "项目助理", chatType: "p2p", peerDisplayName: "张三", peerOpenId: "peer_123456789xyz", chatId: "oc_a", state: "ready", lastActivityAt: new Date().toISOString() },
      { id: "context-b", botDisplayName: "项目助理", chatType: "p2p", peerDisplayName: "张三", peerOpenId: "peer_987654321abc", chatId: "oc_b", state: "ready", lastActivityAt: new Date().toISOString() },
      { id: "context-c", botDisplayName: "项目助理", chatType: "p2p", peerDisplayName: "李四", peerOpenId: "peer_555555555def", chatId: "oc_c", state: "ready", lastActivityAt: new Date().toISOString() }
    ]} onOpen={() => undefined} />);

    expect(screen.getByText("与张三的私聊（peer_…xyz）")).toBeTruthy();
    expect(screen.getByText("与张三的私聊（peer_…abc）")).toBeTruthy();
    expect(screen.getByText("与李四的私聊")).toBeTruthy();
  });

  it("空列表说明首次有效消息后才建立绑定", () => {
    render(<ChatMemoryTable items={[]} onOpen={() => undefined} />);
    expect(screen.getByText("还没有聊天记忆")).toBeTruthy();
    expect(screen.getByText(/首次收到该聊天的有效消息/)).toBeTruthy();
  });
});

describe("Thread 记忆内容", () => {
  it("按类型展示可读卡片、未知类型兜底，并将原始内容严格作为文本渲染", () => {
    const items = [
      { ordinal: 0, itemId: "user-1", itemType: "userMessage", raw: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "用户问题" }] } },
      { ordinal: 1, itemId: "agent-1", itemType: "agentMessage", raw: { id: "agent-1", type: "agentMessage", text: "<img src=x onerror=alert(1)>" } },
      { ordinal: 2, itemId: "reason-1", itemType: "reasoning", raw: { id: "reason-1", type: "reasoning", summary: ["检查现状"] } },
      { ordinal: 3, itemId: "command-1", itemType: "commandExecution", raw: { id: "command-1", type: "commandExecution", command: "pnpm test", status: "completed", exitCode: 0 } },
      { ordinal: 4, itemId: "file-1", itemType: "fileChange", raw: { id: "file-1", type: "fileChange", changes: [{ path: "src/a.ts", kind: "update" }] } },
      { ordinal: 5, itemId: "tool-1", itemType: "mcpToolCall", raw: { id: "tool-1", type: "mcpToolCall", server: "docs", tool: "search", arguments: { q: "thread" } } },
      { ordinal: 6, itemId: "collab-1", itemType: "collabAgentToolCall", raw: { id: "collab-1", type: "collabAgentToolCall", tool: "spawn_agent" } },
      { ordinal: 7, itemId: "compact-1", itemType: "contextCompaction", raw: { id: "compact-1", type: "contextCompaction" } },
      { ordinal: 8, itemId: "future-1", itemType: "futureItem", raw: { id: "future-1", type: "futureItem", secret: "完整原始值" } }
    ];
    const { container } = render(<>{items.map((item) => <ThreadMemoryItemCard key={item.itemId} item={item} />)}</>);

    for (const label of ["用户消息", "Agent 消息", "推理", "命令", "文件变更", "MCP 工具", "协作代理", "上下文压缩", "futureItem"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("用户问题")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText(/完整原始数据/)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.getAllByText("原始 JSON")).toHaveLength(items.length);
    expect(container.textContent).toContain("完整原始值");
  });

  it("无快照时自动触发一次只读读取并携带 CSRF", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    let getCount = 0;
    vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (init?.method === "POST") return ok({ jobId: "job-1", state: "queued", existing: false }, 202);
      getCount += 1;
      return ok({ snapshot: null, refresh: getCount > 1 ? { id: "job-1", state: "queued", attempt: 0, executorAvailability: "offline", executorLastSeenAt: "2026-07-16T01:00:00.000Z" } : null, items: [], turns: [], nextCursor: null });
    }));

    renderSnapshot();
    await waitFor(() => expect(calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/v1/admin/chat-contexts/context-1/thread-snapshot");
    expect(new Headers(post?.[1]?.headers).get("x-csrf-token")).toBe("csrf-token");
    await waitFor(() => expect(screen.getByText("等待执行器")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "查看内容" }));
    await waitFor(() => expect(screen.getByText("原执行器当前离线，快照保持排队")).toBeTruthy());
    expect(screen.getByText(/请在固定设备启动 Runner/)).toBeTruthy();
    expect(calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("已有快照立即展示，失败刷新保留旧内容，并可向前分页", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((path: string) => {
      calls.push(path);
      const base = {
        snapshot: { id: "snapshot-1", threadId: "thread-1", executorId: "runner-1", protocolSource: "thread/read", thread: { id: "thread-1" }, turnCount: 1, itemCount: 51, completedAt: "2026-07-16T01:00:00.000Z" },
        refresh: { id: "refresh-1", state: "failed", attempt: 1, error: "原执行器离线" }
      };
      if (path.includes("before=older")) return ok({ ...base, items: [{ ordinal: 0, turnId: "turn-1", itemId: "oldest", itemType: "userMessage", raw: { id: "oldest", type: "userMessage", content: [{ type: "text", text: "最早消息" }] } }], turns: [{ turnIndex: 0, turnId: "turn-1", status: "completed", durationMs: 1000 }], nextCursor: null });
      return ok({ ...base, items: Array.from({ length: 50 }, (_, index) => ({ ordinal: index + 1, turnId: "turn-1", itemId: `item-${index + 1}`, itemType: "agentMessage", raw: { id: `item-${index + 1}`, type: "agentMessage", text: index === 49 ? "最新消息" : `消息 ${index + 1}` } })), turns: [{ turnIndex: 0, turnId: "turn-1", status: "completed", durationMs: 1000 }], nextCursor: "older" });
    }));

    renderSnapshot("context-paged");
    expect(await screen.findByText("Thread 记忆内容 · 51 项")).toBeTruthy();
    expect(screen.queryByText("最新消息")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看内容" }));
    expect(screen.getAllByText("最新消息").length).toBeGreaterThan(0);
    expect(screen.getByText("本次 Thread 读取失败")).toBeTruthy();
    expect(screen.getByText(/原执行器离线.*保留上一份成功快照/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /加载更早/ }));
    expect(await screen.findByText("最早消息")).toBeTruthy();
    expect(calls.some((path) => path.includes("before=older"))).toBe(true);
    expect(screen.queryByRole("button", { name: /加载更早/ })).toBeNull();
  });

  it("以对话模式展示最终回复，并支持搜索、参与者筛选和详情模式切换", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({
      snapshot: { id: "snapshot-2", threadId: "thread-1", executorId: "runner-1", protocolSource: "thread/read", thread: { id: "thread-1" }, turnCount: 1, itemCount: 3, completedAt: "2026-07-16T01:00:00.000Z" },
      refresh: null,
      items: [
        { ordinal: 0, turnId: "turn-1", itemId: "other-1", itemType: "userMessage", raw: { id: "other-1", type: "userMessage", content: [{ type: "text", text: "系统提示\n飞书信号：\n- [bot:协作助手|member|depth=1] 8\n最终必须返回 reply。" }] } },
        { ordinal: 1, turnId: "turn-1", itemId: "self-1", itemType: "agentMessage", raw: { id: "self-1", type: "agentMessage", text: JSON.stringify({ reply: "9", disposition: "awaiting_followup", rationale: "等待对方数 10" }) } },
        { ordinal: 2, turnId: "turn-1", itemId: "reason-1", itemType: "reasoning", raw: { id: "reason-1", type: "reasoning", summary: ["检查轮流顺序"] } }
      ],
      turns: [{ turnIndex: 0, turnId: "turn-1", status: "completed", durationMs: 1000 }],
      nextCursor: null
    })));

    renderSnapshot("context-dialog");
    await screen.findByText("Thread 记忆内容 · 3 项");
    fireEvent.click(screen.getByRole("button", { name: "查看内容" }));
    expect(screen.getByText("协作助手")).toBeTruthy();
    expect(screen.getByRole("button", { name: "8" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "9" })).toBeTruthy();
    expect(screen.queryByText("等待对方数 10")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "9" }));
    expect(screen.getByRole("tab", { name: "完整提示词" })).toBeTruthy();
    expect(screen.getByText(/系统提示.*最终必须返回 reply/s)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "原始 JSON" }));
    expect(screen.getByText(/等待对方数 10/)).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索 Thread 记忆" }), { target: { value: "检查轮流顺序" } });
    expect(screen.getByText("检查轮流顺序")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "8" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /其它 Agent/ }));
    expect(screen.getByText("没有匹配的 Thread 记录")).toBeTruthy();
  });
});
