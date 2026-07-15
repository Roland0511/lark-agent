import { randomUUID, timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { Kysely, Selectable } from "kysely";
import { parse } from "yaml";
import type { Database, SkillhubPackagesTable } from "../db/types.js";
import { sha256 } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";
import type { ControlPlaneConfig } from "./config.js";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const coordinatePattern = /^@([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9_-]{0,127})$/;

interface ResolveResult {
  namespace: string;
  slug: string;
  version: string;
  fingerprint: string;
}

export function parseSkillCoordinate(coordinate: string): { namespace: string; slug: string } {
  const match = coordinate.trim().match(coordinatePattern);
  if (!match?.[1] || !match[2]) throw new AppError("技能坐标格式应为 @namespace/slug", 400, "invalid_skill_coordinate");
  return { namespace: match[1], slug: match[2] };
}

function safeEntryName(name: string): void {
  if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new AppError("技能包包含不安全路径", 400, "unsafe_skill_archive");
  }
  const parts = name.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new AppError("技能包包含目录穿越路径", 400, "unsafe_skill_archive");
  const withoutSlash = name.endsWith("/") ? name.slice(0, -1) : name;
  if (withoutSlash !== withoutSlash.normalize("NFC")) throw new AppError("技能包路径必须使用 Unicode NFC 规范形式", 400, "unsafe_skill_archive");
}

function validateCentralDirectory(buffer: Buffer): void {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new AppError("技能包不是有效 ZIP", 400, "invalid_skill_archive");
  const entries = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entries > MAX_ENTRIES || directoryOffset >= buffer.length) throw new AppError("技能包文件数量超限", 400, "skill_archive_too_large");
  let offset = directoryOffset;
  let unpacked = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new AppError("技能包中央目录损坏", 400, "invalid_skill_archive");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    safeEntryName(name);
    const collisionKey = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
    if (names.has(collisionKey)) throw new AppError("技能包包含跨平台冲突路径", 400, "unsafe_skill_archive");
    names.add(collisionKey);
    if ((flags & 0x1) !== 0 || ![0, 8].includes(method)) throw new AppError("技能包使用了不支持的加密或压缩方式", 400, "unsupported_skill_archive");
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) throw new AppError("技能包不能包含符号链接", 400, "unsafe_skill_archive");
    if (!name.endsWith("/") && size > MAX_FILE_BYTES) throw new AppError("技能包单个文件超过 10 MiB", 400, "skill_archive_too_large");
    unpacked += size;
    if (unpacked > MAX_UNPACKED_BYTES) throw new AppError("技能包解压后大小超限", 400, "skill_archive_too_large");
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

export interface DeclaredToolDependency {
  type: string;
  value: string;
  description: string | null;
}

export function normalizeDeclaredDependencies(input: unknown): { tools: DeclaredToolDependency[] } {
  if (!input || typeof input !== "object") return { tools: [] };
  const tools = Array.isArray((input as { tools?: unknown }).tools) ? (input as { tools: unknown[] }).tools : [];
  const normalized: DeclaredToolDependency[] = [];
  for (const candidate of tools.slice(0, 32)) {
    const record = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
    const type = (record && typeof record.type === "string" ? record.type : "tool").trim().slice(0, 32);
    const value = (typeof candidate === "string" ? candidate : record && typeof record.value === "string" ? record.value : "").trim().slice(0, 256);
    const description = record && typeof record.description === "string" ? record.description.trim().slice(0, 500) : "";
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(type) || !value || /[\u0000-\u001f\u007f]/u.test(value)) continue;
    normalized.push({ type, value, description: description || null });
  }
  return { tools: normalized };
}

export function inspectSkillArchive(buffer: Buffer): { skillName: string; description: string; dependencies: { tools: DeclaredToolDependency[] }; registryFingerprint: string } {
  validateCentralDirectory(buffer);
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(new Uint8Array(buffer)); } catch { throw new AppError("技能包无法安全解压", 400, "invalid_skill_archive"); }
  const names = Object.keys(entries);
  if (names.length > MAX_ENTRIES) throw new AppError("技能包文件数量超限", 400, "skill_archive_too_large");
  for (const name of names) safeEntryName(name);
  const skillFile = entries["SKILL.md"];
  if (!skillFile) throw new AppError("技能包根目录缺少 SKILL.md", 400, "invalid_skill_package");
  const text = Buffer.from(skillFile).toString("utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) throw new AppError("SKILL.md 缺少有效 frontmatter", 400, "invalid_skill_package");
  let frontmatter: unknown;
  try { frontmatter = parse(match[1]); } catch { throw new AppError("SKILL.md frontmatter 无法解析", 400, "invalid_skill_package"); }
  if (!frontmatter || typeof frontmatter !== "object") throw new AppError("SKILL.md frontmatter 无效", 400, "invalid_skill_package");
  const metadata = frontmatter as Record<string, unknown>;
  const skillName = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillName) || !description || description.length > 2_000) {
    throw new AppError("SKILL.md 必须声明合法的 name 和 description", 400, "invalid_skill_package");
  }
  const manifest = names.filter((name) => !name.endsWith("/")).sort()
    .map((name) => `${name}:${sha256(Buffer.from(entries[name]!))}\n`).join("");
  return {
    skillName,
    description,
    dependencies: normalizeDeclaredDependencies(metadata.dependencies),
    registryFingerprint: `sha256:${sha256(manifest)}`
  };
}

export function assertRegistryFingerprint(expected: string, actual: string): void {
  const pattern = /^sha256:[a-f0-9]{64}$/;
  if (!pattern.test(expected) || !pattern.test(actual)) throw new AppError("SkillHub 返回了无效的内容指纹", 502, "skillhub_invalid_fingerprint");
  const expectedBytes = Buffer.from(expected.slice(7), "hex");
  const actualBytes = Buffer.from(actual.slice(7), "hex");
  if (!timingSafeEqual(expectedBytes, actualBytes)) throw new AppError("SkillHub 技能包与固定版本指纹不一致", 502, "skillhub_fingerprint_mismatch");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchSkillArchiveResponse(url: string, token: string, timeoutMs = 30_000): Promise<Response> {
  const original = new URL(url);
  const signal = AbortSignal.timeout(timeoutMs);
  const request = async (target: URL, includeAuthorization: boolean) => fetch(target, {
    headers: includeAuthorization ? { authorization: `Bearer ${token}` } : {},
    signal,
    redirect: "manual"
  });
  let response = await request(original, true);
  if (!REDIRECT_STATUSES.has(response.status)) return response;
  const location = response.headers.get("location");
  await response.body?.cancel().catch(() => undefined);
  if (!location) throw new AppError("SkillHub 技能包重定向缺少目标地址", 502, "skillhub_download_redirect_invalid");
  const redirected = new URL(location, original);
  if (redirected.protocol !== "https:" || redirected.username || redirected.password) {
    throw new AppError("SkillHub 技能包重定向地址不安全", 502, "skillhub_download_redirect_invalid");
  }
  response = await request(redirected, redirected.origin === original.origin);
  if (REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError("SkillHub 技能包重定向次数超限", 502, "skillhub_download_redirect_limit");
  }
  return response;
}

export class SkillHubService {
  readonly registryUrl: string;
  readonly cacheDir: string;
  private readonly token: string;

  constructor(private readonly db: Kysely<Database>, config: ControlPlaneConfig) {
    this.registryUrl = config.skillhubRegistryUrl?.replace(/\/$/, "") ?? "";
    this.cacheDir = config.skillhubCacheDir ?? "/home/agent/.lark-agent/skillhub-cache";
    this.token = config.skillhubApiToken ?? "";
  }

  status(): { configured: boolean; authenticated: boolean; registryUrl: string | null } {
    return { configured: Boolean(this.registryUrl), authenticated: Boolean(this.token), registryUrl: this.registryUrl || null };
  }

  private async json(path: string): Promise<unknown> {
    if (!this.registryUrl) throw new AppError("SkillHub 注册表尚未配置", 503, "skillhub_unavailable");
    let response: Response;
    try {
      response = await fetch(`${this.registryUrl}/api/cli/v1${path}`, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {}, signal: AbortSignal.timeout(15_000), redirect: "error" });
    } catch {
      throw new AppError("SkillHub 注册表连接超时或不可达", 503, "skillhub_unavailable");
    }
    if (response.status === 401 || response.status === 403) throw new AppError("SkillHub Token 无效或权限不足", 503, "skillhub_auth_failed");
    if (response.status === 404) throw new AppError("SkillHub 技能不存在", 404, "skillhub_skill_not_found");
    if (!response.ok) throw new AppError(`SkillHub 暂时不可用（${response.status}）`, 503, "skillhub_unavailable");
    const body = await response.json() as { data?: unknown };
    return body.data;
  }

  async search(query: string, limit = 20): Promise<unknown[]> {
    if (!this.token) throw new AppError("SkillHub Token 尚未配置", 503, "skillhub_auth_unavailable");
    const result = await this.json(`/skills/search?${new URLSearchParams({ q: query, limit: String(Math.min(Math.max(limit, 1), 50)) })}`);
    if (!result || typeof result !== "object") return [];
    const items = (result as { items?: unknown }).items;
    return Array.isArray(items) ? items : [];
  }

  private async resolve(namespace: string, slug: string, version?: string): Promise<ResolveResult> {
    if (!this.token) throw new AppError("SkillHub Token 尚未配置", 503, "skillhub_auth_unavailable");
    const suffix = version ? `?version=${encodeURIComponent(version)}` : "";
    const result = await this.json(`/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/resolve${suffix}`);
    if (!result || typeof result !== "object") throw new AppError("SkillHub 返回了无效版本信息", 502, "skillhub_invalid_response");
    const value = result as Record<string, unknown>;
    const resolved = {
      namespace: String(value.namespace ?? namespace),
      slug: String(value.slug ?? slug),
      version: String(value.version ?? ""),
      fingerprint: String(value.fingerprint ?? "")
    };
    if (resolved.namespace !== namespace || resolved.slug !== slug || !resolved.version || !resolved.fingerprint) throw new AppError("SkillHub 返回了不匹配的技能信息", 502, "skillhub_invalid_response");
    return resolved;
  }

  async resolveAndCache(coordinate: string, version?: string): Promise<Selectable<SkillhubPackagesTable>> {
    const parsed = parseSkillCoordinate(coordinate);
    const resolved = await this.resolve(parsed.namespace, parsed.slug, version);
    const existing = await this.db.selectFrom("skillhub_packages").selectAll()
      .where("registry_url", "=", this.registryUrl).where("namespace", "=", parsed.namespace).where("slug", "=", parsed.slug)
      .where("version", "=", resolved.version).where("registry_fingerprint", "=", resolved.fingerprint).executeTakeFirst();
    if (existing) {
      try { await this.verifyCachedPackage(existing.id); return existing; } catch { /* restore missing or damaged cache below */ }
    }
    let response: Response;
    try {
      response = await fetchSkillArchiveResponse(
        `${this.registryUrl}/api/cli/v1/skills/${encodeURIComponent(parsed.namespace)}/${encodeURIComponent(parsed.slug)}/versions/${encodeURIComponent(resolved.version)}/download`,
        this.token
      );
    } catch {
      throw new AppError("SkillHub 技能包下载超时或不可达", 503, "skillhub_download_failed");
    }
    if (response.status === 401 || response.status === 403) throw new AppError("SkillHub Token 无效或无下载权限", 503, "skillhub_auth_failed");
    if (!response.ok) throw new AppError(`SkillHub 技能包下载失败（${response.status}）`, 503, "skillhub_download_failed");
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_ARCHIVE_BYTES) throw new AppError("技能包下载大小超限", 400, "skill_archive_too_large");
    if (!response.body) throw new AppError("SkillHub 技能包响应为空", 503, "skillhub_download_failed");
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > MAX_ARCHIVE_BYTES) {
        await response.body.cancel().catch(() => undefined);
        throw new AppError("技能包下载大小超限", 400, "skill_archive_too_large");
      }
      chunks.push(bytes);
    }
    const archive = Buffer.concat(chunks, received);
    if (!archive.length || archive.length > MAX_ARCHIVE_BYTES) throw new AppError("技能包下载大小无效", 400, "skill_archive_too_large");
    const metadata = inspectSkillArchive(archive);
    assertRegistryFingerprint(resolved.fingerprint, metadata.registryFingerprint);
    const digest = sha256(archive);
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const archivePath = join(this.cacheDir, `${digest}.zip`);
    const temporaryPath = join(this.cacheDir, `.${digest}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, archive, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, archivePath).catch(async (error) => {
        try { await access(archivePath); } catch { throw error; }
      });
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    await this.db.insertInto("skillhub_packages").values({
      registry_url: this.registryUrl, namespace: parsed.namespace, slug: parsed.slug, version: resolved.version,
      registry_fingerprint: resolved.fingerprint, archive_sha256: digest, archive_path: archivePath, archive_size: archive.length,
      skill_name: metadata.skillName, description: metadata.description, dependencies: JSON.stringify(metadata.dependencies)
    }).onConflict((conflict) => conflict.columns(["registry_url", "namespace", "slug", "version", "registry_fingerprint"]).doUpdateSet({
      archive_sha256: digest,
      archive_path: archivePath,
      archive_size: archive.length,
      skill_name: metadata.skillName,
      description: metadata.description,
      dependencies: JSON.stringify(metadata.dependencies)
    })).execute();
    return this.db.selectFrom("skillhub_packages").selectAll()
      .where("registry_url", "=", this.registryUrl).where("namespace", "=", parsed.namespace).where("slug", "=", parsed.slug)
      .where("version", "=", resolved.version).where("registry_fingerprint", "=", resolved.fingerprint).executeTakeFirstOrThrow();
  }

  async verifyCachedPackage(packageId: string): Promise<Selectable<SkillhubPackagesTable>> {
    const row = await this.db.selectFrom("skillhub_packages").selectAll().where("id", "=", packageId).executeTakeFirst();
    if (!row) throw new AppError("技能包不存在", 404, "skill_package_not_found");
    try {
      const info = await stat(row.archive_path);
      if (Number(info.size) !== Number(row.archive_size)) throw new Error("size mismatch");
      const archive = await readFile(row.archive_path);
      if (sha256(archive) !== row.archive_sha256) throw new Error("sha256 mismatch");
      assertRegistryFingerprint(row.registry_fingerprint, inspectSkillArchive(archive).registryFingerprint);
    } catch {
      throw new AppError("技能包缓存不可用或完整性校验失败", 503, "skill_package_cache_unavailable");
    }
    return row;
  }
}
