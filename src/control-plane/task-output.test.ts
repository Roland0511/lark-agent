import { describe, expect, it } from "vitest";
import { visibleStreamText } from "./task-output.js";

describe("visibleStreamText", () => {
  it("keeps ordinary commentary unchanged", () => {
    expect(visibleStreamText("正在读取飞书文档…")).toBe("正在读取飞书文档…");
  });

  it("buffers partial structured output instead of leaking lifecycle metadata", () => {
    expect(visibleStreamText("{")).toBeNull();
    expect(visibleStreamText('{"disposition":"awaiting_followup"')).toBeNull();
    expect(visibleStreamText("```json\n")).toBeNull();
  });

  it("projects only reply from a complete structured result", () => {
    const result = JSON.stringify({
      disposition: "awaiting_followup",
      rationale: "等待下一条消息",
      reply: "小小朱正在读取这个飞书文档并整理主要内容。"
    });
    expect(visibleStreamText(result)).toBe("小小朱正在读取这个飞书文档并整理主要内容。");
    expect(visibleStreamText(`\`\`\`json\n${result}\n\`\`\``)).toBe("小小朱正在读取这个飞书文档并整理主要内容。");
  });

  it("does not expose JSON that fails the task result schema", () => {
    expect(visibleStreamText('{"reply":"不完整"}')).toBeNull();
  });
});
