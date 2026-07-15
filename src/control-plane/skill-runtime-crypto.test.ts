import { describe, expect, it } from "vitest";
import { SkillSecretBox, parseEncryptionKeyring } from "./skill-runtime-crypto.js";

describe("SkillSecretBox", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  it("encrypts with AES-GCM and requires matching AAD", () => {
    const box = new SkillSecretBox(`v1:${key}`, "v1");
    const encrypted = box.encrypt(Buffer.from("secret-value"), "env:record");
    expect(encrypted.ciphertext).not.toContain("secret-value");
    expect(box.decrypt(encrypted, "env:record").toString()).toBe("secret-value");
    expect(() => box.decrypt(encrypted, "env:other")).toThrow("完整性校验失败");
  });

  it("rejects invalid and duplicate keyring entries", () => {
    expect(() => parseEncryptionKeyring(`v1:${Buffer.alloc(31, 1).toString("base64")}`)).toThrow("规范 Base64");
    expect(() => parseEncryptionKeyring(`v1:${key.slice(0, -2)}??`)).toThrow("规范 Base64");
    expect(() => parseEncryptionKeyring(`v1:${key},v1:${key}`)).toThrow("重复");
  });
});
