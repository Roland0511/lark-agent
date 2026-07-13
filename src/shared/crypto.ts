import { createHash, randomBytes } from "node:crypto";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function stableHomeRef(executorId: string, canonicalCodexHome: string): string {
  return `${executorId}:${sha256(canonicalCodexHome).slice(0, 16)}`;
}
