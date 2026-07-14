import { chmod, lstat, mkdir, mkdtemp, realpath, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { attachmentTarget, cleanupExpiredAttachments, existingAttachment } from "./attachments.js";

describe("worker attachment storage", () => {
  it("creates isolated targets with private directories and files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lark-agent-attachments-"));
    const target = await attachmentTarget(workspace, "../../om_bad", {
      id: "11111111-1111-4111-8111-111111111111",
      type: "file",
      fileName: "../../proof.txt"
    });
    expect(target.startsWith(`${await realpath(workspace)}/.lark-agent/attachments/`)).toBe(true);
    expect(target).not.toContain("../");
    await writeFile(target, "proof", { mode: 0o600 });
    await chmod(target, 0o600);
    expect((await lstat(join(workspace, ".lark-agent", "attachments"))).mode & 0o777).toBe(0o700);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    expect(await existingAttachment(target, 10)).toEqual({ path: target, size: 5 });
  });

  it("deduplicates valid cached files and removes oversized cache entries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lark-agent-attachment-cache-"));
    const target = await attachmentTarget(workspace, "om_cache", {
      id: "22222222-2222-4222-8222-222222222222",
      type: "file",
      fileName: "cache.txt"
    });
    await writeFile(target, "12345", { mode: 0o600 });
    await expect(existingAttachment(target, 5)).resolves.toEqual({ path: target, size: 5 });
    await expect(existingAttachment(target, 4)).resolves.toBeNull();
    await expect(stat(target)).rejects.toThrow();
  });

  it("finds a cached image that previously received an inferred extension", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lark-agent-attachment-extension-cache-"));
    const target = await attachmentTarget(workspace, "om_image", {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "image",
      fileName: "image"
    });
    await writeFile(`${target}.jpg`, "jpeg", { mode: 0o600 });
    await expect(existingAttachment(target, 10)).resolves.toEqual({ path: `${target}.jpg`, size: 4 });
  });

  it("cleans message directories older than the retention window", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lark-agent-attachment-retention-"));
    const root = join(workspace, ".lark-agent", "attachments");
    const old = join(root, "om_old");
    const fresh = join(root, "om_fresh");
    await mkdir(old, { recursive: true, mode: 0o700 });
    await mkdir(fresh, { recursive: true, mode: 0o700 });
    const now = Date.now();
    await utimes(old, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000));
    await cleanupExpiredAttachments(workspace, 7, now);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeTruthy();
  });

  it("rejects a symbolic-link attachment root before creating files outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lark-agent-attachment-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "lark-agent-attachment-outside-"));
    await symlink(outside, join(workspace, ".lark-agent"));
    await expect(attachmentTarget(workspace, "om_escape", {
      id: "99999999-9999-4999-8999-999999999999",
      type: "file",
      fileName: "escape.txt"
    })).rejects.toThrow(/symbolic link|outside/);
    await expect(stat(join(outside, "attachments"))).rejects.toThrow();
  });
});
