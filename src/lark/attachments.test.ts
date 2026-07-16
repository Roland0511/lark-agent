import { describe, expect, it } from "vitest";
import { attachmentSummary, extractLarkAttachments, safeMessageContent, sanitizeAttachmentFileName } from "./attachments.js";

describe("Lark attachment parsing", () => {
  it("parses direct images and files without exposing resource keys in the safe body", () => {
    const image = extractLarkAttachments("image", JSON.stringify({ image_key: "img_direct" }));
    const file = extractLarkAttachments("file", JSON.stringify({ file_key: "file_direct", file_name: "check.txt" }));
    expect(image).toMatchObject([{ type: "image", resourceKey: "img_direct", fileName: "image" }]);
    expect(file).toMatchObject([{ type: "file", resourceKey: "file_direct", fileName: "check.txt" }]);
    expect(safeMessageContent("file", JSON.stringify({ file_key: "file_direct", file_name: "check.txt" }), file)).toBe("附件（1 个）：文件「check.txt」");
    expect(safeMessageContent("image", JSON.stringify({ image_key: "img_direct" }), image)).not.toContain("img_direct");
  });

  it("parses rich text images and files, deduplicates keys and preserves visible text", () => {
    const raw = JSON.stringify({ title: "", content: [[
      { tag: "text", text: "请读取附件" },
      { tag: "img", image_key: "img_rich" },
      { tag: "img", image_key: "img_rich" },
      { tag: "file", file_key: "file_rich", file_name: "answer.md" }
    ]] });
    const items = extractLarkAttachments("post", raw);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.resourceKey)).toEqual(["img_rich", "file_rich"]);
    const safe = safeMessageContent("post", raw, items);
    expect(safe).toContain("请读取附件");
    expect(safe).toContain("图片「image」");
    expect(safe).toContain("文件「answer.md」");
    expect(safe).not.toContain("img_rich");
    expect(safe).not.toContain("file_rich");
  });

  it("sanitizes malicious file names and excludes audio, video and stickers", () => {
    expect(sanitizeAttachmentFileName("../../evil\u0000:name?.txt")).toBe("evil_name_.txt");
    expect(extractLarkAttachments("audio", JSON.stringify({ file_key: "file_audio", file_name: "voice.opus" }))).toEqual([]);
    expect(extractLarkAttachments("media", JSON.stringify({ file_key: "file_video", file_name: "movie.mp4" }))).toEqual([]);
    expect(extractLarkAttachments("sticker", JSON.stringify({ file_key: "file_sticker" }))).toEqual([]);
    expect(extractLarkAttachments("post", JSON.stringify({ content: [[{ tag: "video", file_key: "file_video" }, { tag: "audio", file_key: "file_audio" }]] }))).toEqual([]);
    expect(safeMessageContent("audio", JSON.stringify({ file_key: "file_audio" }), [])).toBe("（暂不支持的飞书音频消息）");
    expect(safeMessageContent("audio", JSON.stringify({ file_key: "file_audio" }), [])).not.toContain("file_audio");
  });

  it("builds a concise attachment preview", () => {
    expect(attachmentSummary([
      { type: "image", fileName: "screen.png" },
      { type: "file", fileName: "proof.txt" }
    ])).toBe("附件（2 个）：图片「screen.png」、文件「proof.txt」");
  });

  it("removes resource keys from rendered rich markers", () => {
    const raw = "请看 ![截图](img_marker)、<file file_key=\"file_marker\" file_name=\"proof.txt\"> 和 <audio key=\"file_audio_marker\" duration=\"1s\">";
    const items = extractLarkAttachments("text", raw);
    const safe = safeMessageContent("text", raw, items);
    expect(items).toHaveLength(2);
    expect(safe).toContain("[图片：截图]");
    expect(safe).toContain("[文件]");
    expect(safe).toContain("[暂不支持的音频]");
    expect(safe).not.toContain("img_marker");
    expect(safe).not.toContain("file_marker");
    expect(safe).not.toContain("file_audio_marker");
  });

  it("extracts visible CardKit text from user, raw and rendered card content", () => {
    const userCard = JSON.stringify({
      body: { elements: [
        { tag: "markdown", element_id: "answer", content: "1" },
        { tag: "plain_text", text: "下一步" }
      ] },
      config: { summary: { content: "摘要" } },
      schema: "2.0"
    });
    const rawCard = JSON.stringify({
      json_card: JSON.stringify({
        body: { property: { elements: [{ property: { elements: [
          { tag: "plain_text", property: { content: "2" } }
        ] } }] } },
        config: { summary: { content: "2" } },
        schema: "2.0"
      }),
      card_schema: 2
    });

    expect(safeMessageContent("interactive", userCard, [])).toBe("1\n下一步");
    expect(safeMessageContent("interactive", rawCard, [])).toBe("2");
    expect(safeMessageContent("interactive", "<card>\n3\n</card>", [])).toBe("3");
  });

  it("uses the CardKit summary for an empty body and preserves unknown content", () => {
    const summaryOnly = JSON.stringify({ body: { elements: [] }, config: { summary: { content: "4" } }, schema: "2.0" });
    expect(safeMessageContent("interactive", summaryOnly, [])).toBe("4");
    expect(safeMessageContent("interactive", "{not-json", [])).toBe("{not-json");
    expect(safeMessageContent("interactive", "{}", [])).toBe("{}");
  });
});
