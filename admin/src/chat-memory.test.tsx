// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMemoryTable } from "./App";

afterEach(cleanup);

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
    expect(screen.getByText("群聊 · 群聊 A")).toBeTruthy();
    expect(screen.getByText("已绑定")).toBeTruthy();
    expect(screen.getByText("阿朱 SH01")).toBeTruthy();
    expect(screen.getByText("runner-sh01")).toBeTruthy();
    expect(screen.getByText("workspace")).toBeTruthy();
    expect(screen.getByText("3 次")).toBeTruthy();
    expect(screen.queryByText(/重置|删除工作区|最大轮数/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看 群聊 A 的聊天记忆" }));
    expect(onOpen).toHaveBeenCalledWith("018f90b0-b30c-7a11-a523-5d303ef41234");
  });

  it("空列表说明首次有效消息后才建立绑定", () => {
    render(<ChatMemoryTable items={[]} onOpen={() => undefined} />);
    expect(screen.getByText("还没有聊天记忆")).toBeTruthy();
    expect(screen.getByText(/首次收到该聊天的有效消息/)).toBeTruthy();
  });
});
