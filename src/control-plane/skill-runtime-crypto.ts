import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../shared/errors.js";

export interface EncryptedSecret {
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

export function parseEncryptionKeyring(serialized = ""): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const rawEntry of serialized.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.indexOf(":");
    if (separator <= 0) throw new AppError("技能运行凭证密钥环格式无效", 500, "skill_runtime_keyring_invalid");
    const keyId = entry.slice(0, separator);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new AppError("技能运行凭证 key ID 格式无效", 500, "skill_runtime_keyring_invalid");
    const encoded = entry.slice(separator + 1);
    if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(encoded)) throw new AppError("技能运行凭证密钥必须使用规范 Base64", 500, "skill_runtime_keyring_invalid");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new AppError("技能运行凭证密钥必须是 32 字节", 500, "skill_runtime_keyring_invalid");
    if (keys.has(keyId)) throw new AppError("技能运行凭证 key ID 重复", 500, "skill_runtime_keyring_invalid");
    keys.set(keyId, key);
  }
  return keys;
}

export class SkillSecretBox {
  private readonly keys: Map<string, Buffer>;

  constructor(serializedKeyring = "", private readonly activeKeyId = "") {
    this.keys = parseEncryptionKeyring(serializedKeyring);
  }

  get available(): boolean {
    return Boolean(this.activeKeyId && this.keys.has(this.activeKeyId));
  }

  encrypt(value: Buffer, aad: string): EncryptedSecret {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new AppError("技能运行凭证加密密钥尚未配置", 503, "skill_runtime_encryption_unavailable");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return {
      keyId: this.activeKeyId,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64")
    };
  }

  decrypt(secret: EncryptedSecret, aad: string): Buffer {
    const key = this.keys.get(secret.keyId);
    if (!key) throw new AppError("技能运行凭证所需的历史密钥不可用", 503, "skill_runtime_key_unavailable");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.nonce, "base64"));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]);
    } catch {
      throw new AppError("技能运行凭证完整性校验失败", 500, "skill_runtime_secret_invalid");
    }
  }
}
