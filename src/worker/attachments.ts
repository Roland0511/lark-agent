import { chmod, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import type { SignalAttachment } from "../shared/contracts.js";

export interface LocalAttachment extends SignalAttachment {
  path: string;
  size: number;
}

export async function attachmentTarget(workspacePath: string, messageId: string, attachment: SignalAttachment): Promise<string> {
  const workspace = await realpath(workspacePath);
  const agentDirectory = join(workspace, ".lark-agent");
  const root = join(agentDirectory, "attachments");
  const messageDirectory = join(root, safeSegment(messageId));
  await mkdir(agentDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  await assertPrivateDirectory(workspace, agentDirectory);
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  await assertPrivateDirectory(workspace, root);
  await mkdir(messageDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  await assertPrivateDirectory(workspace, messageDirectory);
  const target = join(messageDirectory, `${safeSegment(attachment.id)}-${safeFileName(attachment.fileName)}`);
  assertDescendant(workspace, target);
  return target;
}

export async function cleanupExpiredAttachments(workspacePath: string, retentionDays: number, now = Date.now()): Promise<void> {
  const workspace = await realpath(workspacePath);
  const root = join(workspace, ".lark-agent", "attachments");
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo) return;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("attachment root is not a private directory");
  assertDescendant(workspace, await realpath(root));
  const cutoff = now - retentionDays * 86_400_000;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    assertDescendant(workspace, path);
    const info = await lstat(path).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
  }
}

export async function cleanupAllAttachmentRoots(roots: Array<{ path: string }>, retentionDays: number): Promise<void> {
  for (const root of roots) {
    const botDirectories = await readdir(root.path, { withFileTypes: true }).catch(() => []);
    for (const entry of botDirectories) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && /^cli_[A-Za-z0-9]+$/.test(entry.name)) {
        await cleanupExpiredAttachments(join(root.path, entry.name), retentionDays).catch(() => undefined);
      }
    }
  }
}

export async function existingAttachment(path: string, maxBytes: number): Promise<{ path: string; size: number } | null> {
  let candidate = path;
  let info = await lstat(candidate).catch(() => null);
  if (!info && !extname(path)) {
    const prefix = `${basename(path)}.`;
    const matches = (await readdir(dirname(path), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.startsWith(prefix));
    if (matches.length === 1) {
      candidate = join(dirname(path), matches[0]!.name);
      info = await lstat(candidate).catch(() => null);
    }
  }
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    await rm(candidate, { force: true });
    return null;
  }
  await chmod(candidate, 0o600);
  return { path: candidate, size: info.size };
}

export function safeFileName(value: string): string {
  const leaf = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const safe = truncateUtf8(leaf.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/^\.+/, "").trim(), 180);
  return safe && safe !== "." && safe !== ".." ? safe : "attachment";
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

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 180) || "unknown";
}

function assertDescendant(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("attachment path escapes the bot workspace");
}

async function assertPrivateDirectory(workspace: string, directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("attachment directory must not be a symbolic link");
  assertDescendant(workspace, await realpath(directory));
  await chmod(directory, 0o700);
}
