import { randomUUID } from "node:crypto";
import type { SignalAttachment } from "../shared/contracts.js";

export interface StoredAttachment extends SignalAttachment {
  resourceKey: string;
}

const allowedMessageTypes = new Set(["image", "file", "post", "text"]);
const excludedTags = new Set(["audio", "media", "video", "sticker"]);

export function extractLarkAttachments(messageType: string, rawContent: string): StoredAttachment[] {
  if (!allowedMessageTypes.has(messageType)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    parsed = rawContent;
  }
  const candidates: Array<Omit<StoredAttachment, "id">> = [];
  if (messageType === "image") collectDirect(parsed, "image", candidates);
  else if (messageType === "file") collectDirect(parsed, "file", candidates);
  else if (messageType === "post") collectRich(parsed, candidates);
  collectRenderedMarkers(rawContent, candidates);

  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const key = `${candidate.type}:${candidate.resourceKey}`;
    if (!validResourceKey(candidate.type, candidate.resourceKey) || seen.has(key)) return [];
    seen.add(key);
    return [{ id: randomUUID(), ...candidate }];
  });
}

export function safeMessageContent(messageType: string, rawContent: string, attachments: StoredAttachment[]): string {
  if (["audio", "media", "video", "sticker"].includes(messageType)) return `（暂不支持的飞书${unsupportedTypeName(messageType)}消息）`;
  const text = messageType === "post" ? extractRichText(rawContent) : messageType === "text" ? sanitizeRenderedMarkers(parsePlainText(rawContent)) : "";
  const summary = attachmentSummary(attachments);
  const safe = [text.trim(), summary].filter(Boolean).join("\n");
  if (safe) return safe;
  if (messageType === "image" || messageType === "file") return "（飞书附件信息不可用）";
  return sanitizeRenderedMarkers(parsePlainText(rawContent));
}

export function attachmentSummary(attachments: Array<Pick<StoredAttachment, "type" | "fileName">>): string {
  if (!attachments.length) return "";
  return `附件（${attachments.length} 个）：${attachments.map((item) => `${item.type === "image" ? "图片" : "文件"}「${item.fileName}」`).join("、")}`;
}

export function publicAttachments(value: unknown): SignalAttachment[] {
  return storedAttachments(value).map(({ id, type, fileName }) => ({ id, type, fileName }));
}

export function storedAttachments(value: unknown): StoredAttachment[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const type = record.type === "image" || record.type === "file" ? record.type : null;
    const id = typeof record.id === "string" ? record.id : "";
    const fileName = typeof record.fileName === "string" ? sanitizeAttachmentFileName(record.fileName) : "";
    const resourceKey = typeof record.resourceKey === "string" ? record.resourceKey : "";
    return type && id && fileName && validResourceKey(type, resourceKey) ? [{ id, type, fileName, resourceKey }] : [];
  });
}

export function sanitizeAttachmentFileName(value: string, fallback = "attachment"): string {
  const leaf = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const cleaned = leaf
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const bounded = truncateUtf8(cleaned, 180);
  return bounded && bounded !== "." && bounded !== ".." ? bounded : fallback;
}

function collectDirect(value: unknown, type: "image" | "file", output: Array<Omit<StoredAttachment, "id">>): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const resourceKey = String(type === "image" ? record.image_key ?? "" : record.file_key ?? "");
  if (!resourceKey) return;
  const rawName = type === "file" ? String(record.file_name ?? record.name ?? "attachment") : String(record.file_name ?? record.name ?? "image");
  output.push({ type, resourceKey, fileName: sanitizeAttachmentFileName(rawName, type === "image" ? "image" : "attachment") });
}

function collectRich(value: unknown, output: Array<Omit<StoredAttachment, "id">>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRich(item, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const tag = String(record.tag ?? record.type ?? "").toLowerCase();
  if (excludedTags.has(tag)) return;
  if (typeof record.image_key === "string" && (tag === "img" || tag === "image" || !tag)) {
    output.push({ type: "image", resourceKey: record.image_key, fileName: sanitizeAttachmentFileName(String(record.file_name ?? record.name ?? "image"), "image") });
  }
  if (typeof record.file_key === "string" && (tag === "file" || !tag)) {
    output.push({ type: "file", resourceKey: record.file_key, fileName: sanitizeAttachmentFileName(String(record.file_name ?? record.name ?? "attachment"), "attachment") });
  }
  Object.values(record).forEach((item) => collectRich(item, output));
}

function collectRenderedMarkers(value: string, output: Array<Omit<StoredAttachment, "id">>): void {
  for (const match of value.matchAll(/!\[[^\]]*\]\((img_[A-Za-z0-9_-]+)\)/g)) {
    if (match[1]) output.push({ type: "image", resourceKey: match[1], fileName: "image" });
  }
  for (const match of value.matchAll(/<file\b[^>]*\b(?:file_key|key)=["'](file_[A-Za-z0-9_-]+)["'][^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/\b(?:file_name|name)=["']([^"']+)["']/i)?.[1] ?? "attachment";
    if (match[1]) output.push({ type: "file", resourceKey: match[1], fileName: sanitizeAttachmentFileName(name) });
  }
}

function extractRichText(rawContent: string): string {
  const parsed = parseJson(rawContent);
  const text: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") text.push(record.text);
    Object.entries(record).forEach(([key, nested]) => {
      if (key !== "text" && !key.endsWith("_key")) visit(nested);
    });
  };
  visit(parsed);
  return text.join("").trim();
}

function parsePlainText(rawContent: string): string {
  const parsed = parseJson(rawContent);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).text === "string") {
    return String((parsed as Record<string, unknown>).text);
  }
  return typeof parsed === "string" ? parsed : rawContent;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sanitizeRenderedMarkers(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\(img_[A-Za-z0-9_-]+\)/g, (_match, alt: string) => alt ? `[图片：${alt}]` : "[图片]")
    .replace(/<file\b[^>]*>/gi, "[文件]")
    .replace(/<audio\b[^>]*>/gi, "[暂不支持的音频]")
    .replace(/<(?:video|media)\b[^>]*>/gi, "[暂不支持的视频]");
}

function unsupportedTypeName(messageType: string): string {
  if (messageType === "audio") return "音频";
  if (messageType === "sticker") return "贴纸";
  return "视频";
}

function validResourceKey(type: "image" | "file", value: string): boolean {
  return new RegExp(`^${type === "image" ? "img" : "file"}_[A-Za-z0-9_-]+$`).test(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}
