import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../shared/crypto.js";
import { assertRegistryFingerprint, fetchSkillArchiveResponse, inspectSkillArchive } from "./skillhub-service.js";

afterEach(() => vi.unstubAllGlobals());

function archive(extra: Record<string, Uint8Array> = {}): Buffer {
  return Buffer.from(zipSync({
    "SKILL.md": strToU8("---\nname: registry-test\ndescription: registry fingerprint test\n---\n\n# Test\n"),
    "scripts/run.sh": strToU8("#!/bin/sh\necho ok\n"),
    ...extra
  }));
}

describe("SkillHub archive identity", () => {
  it("rebuilds the registry file-manifest fingerprint from downloaded content", () => {
    const skillFile = Buffer.from("---\nname: registry-test\ndescription: registry fingerprint test\n---\n\n# Test\n");
    const scriptFile = Buffer.from("#!/bin/sh\necho ok\n");
    const expectedManifest = [
      `SKILL.md:${sha256(skillFile)}\n`,
      `scripts/run.sh:${sha256(scriptFile)}\n`
    ].join("");
    const expected = `sha256:${sha256(expectedManifest)}`;
    const inspected = inspectSkillArchive(archive());
    expect(inspected.registryFingerprint).toBe(expected);
    expect(() => assertRegistryFingerprint(expected, inspected.registryFingerprint)).not.toThrow();
  });

  it("rejects a different bundle for the same resolved version", () => {
    const expected = inspectSkillArchive(archive()).registryFingerprint;
    const tampered = inspectSkillArchive(archive({ "scripts/run.sh": strToU8("#!/bin/sh\necho changed\n") })).registryFingerprint;
    expect(() => assertRegistryFingerprint(expected, tampered)).toThrow(/指纹不一致/);
  });

  it("rejects case-insensitive archive path collisions", () => {
    expect(() => inspectSkillArchive(archive({
      "Docs/Guide.md": strToU8("first"),
      "docs/guide.md": strToU8("second")
    }))).toThrow(/跨平台冲突路径/);
  });
});

describe("SkillHub archive redirects", () => {
  it("follows one HTTPS cross-origin redirect without forwarding Authorization", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://storage.example.test/signed/bundle.zip" } }))
      .mockResolvedValueOnce(new Response("bundle", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSkillArchiveResponse("https://registry.example.test/api/download", "registry-token"))
      .resolves.toHaveProperty("status", 200);
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBe("Bearer registry-token");
    expect(new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).has("authorization")).toBe(false);
    expect((fetchMock.mock.calls[1]?.[0] as URL).href).toBe("https://storage.example.test/signed/bundle.zip");
  });

  it("rejects insecure and chained redirects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://storage.example.test/bundle.zip" } })));
    await expect(fetchSkillArchiveResponse("https://registry.example.test/api/download", "token")).rejects.toThrow(/不安全/);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://storage.example.test/one" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://storage.example.test/two" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSkillArchiveResponse("https://registry.example.test/api/download", "token")).rejects.toThrow(/次数超限/);
  });
});
