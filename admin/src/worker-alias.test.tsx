// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSelectedWorkerId, WorkerAliasDialog } from "./App";
import type { AdminUser } from "./api";

const user: AdminUser = { openId: "masked", displayName: "主人", role: "owner", csrfToken: "csrf", agentDisplayName: "阿朱" };
const worker = {
  executor_id: "mac-sh01-lark-agent",
  display_name: "生产执行器",
  display_alias: "生产执行器",
  reported_display_name: "sh01.local"
};

function renderDialog(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><WorkerAliasDialog worker={worker} user={user} onClose={onClose} /></QueryClientProvider>);
  return onClose;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("执行器别名弹窗", () => {
  it("展示原设备信息并保存去除首尾空格后的中文别名", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = renderDialog();

    expect(screen.getByText("sh01.local")).toBeTruthy();
    expect(screen.getByText("mac-sh01-lark-agent")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/控制台别名/), { target: { value: "  阿朱生产机  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存别名" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/admin/workers/mac-sh01-lark-agent/display-alias");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ displayAlias: "阿朱生产机" }));
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("可以恢复设备名称并展示服务端错误", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { code: "invalid_alias", message: "别名不可用" } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    fireEvent.change(screen.getByLabelText(/控制台别名/), { target: { value: "新别名" } });
    fireEvent.click(screen.getByRole("button", { name: "保存别名" }));
    expect((await screen.findByRole("alert")).textContent).toContain("别名不可用");
    fireEvent.click(screen.getByRole("button", { name: "恢复设备名称" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBe(JSON.stringify({ displayAlias: null }));
  });
});

describe("执行器选中态", () => {
  it("列表因别名变化重排后仍按执行器 ID 保持当前详情", () => {
    const before = [
      { executor_id: "worker-a", display_name: "A" },
      { executor_id: "worker-b", display_name: "B" }
    ];
    const selectedId = resolveSelectedWorkerId(before, "");

    expect(selectedId).toBe("worker-a");
    expect(resolveSelectedWorkerId([...before].reverse(), selectedId)).toBe("worker-a");
  });

  it("当前执行器不存在时回退到列表首项", () => {
    expect(resolveSelectedWorkerId([{ executor_id: "worker-b" }], "worker-a")).toBe("worker-b");
    expect(resolveSelectedWorkerId([], "worker-a")).toBe("");
  });
});
