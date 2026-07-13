import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneConfig } from "./config.js";
import { RunnerReleaseService } from "./runner-routes.js";

const config = {
  runnerArtifactPublicBaseUrl: "https://cdn.example.test/lark-agent",
  runnerManifestRefreshSeconds: 300
} as ControlPlaneConfig;

const manifest = {
  version: "0.1.0",
  publishedAt: "2026-07-13T00:00:00.000Z",
  worker: { path: "releases/0.1.0/worker.mjs", sha256: "a".repeat(64) },
  manager: { path: "releases/0.1.0/lark-agent-runner", sha256: "d".repeat(64) },
  node: {
    arm64: { path: "releases/0.1.0/node-darwin-arm64.tar.gz", sha256: "b".repeat(64) },
    x64: { path: "releases/0.1.0/node-darwin-x64.tar.gz", sha256: "c".repeat(64) }
  }
};

afterEach(() => vi.unstubAllGlobals());

describe("runner release service", () => {
  it("uses the permanent lark-agent CDN path", () => {
    const service = new RunnerReleaseService(config);
    expect(service.installUrl()).toBe("https://cdn.example.test/lark-agent/runner/install.sh");
    expect(service.manifestUrl()).toContain("/lark-agent/runner/manifest.json");
  });

  it("keeps the last verified manifest when CDN refresh fails", async () => {
    const service = new RunnerReleaseService(config);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } }))
      .mockRejectedValueOnce(new Error("network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    expect((await service.current(true)).source).toBe("fresh");
    const fallback = await service.current(true);
    expect(fallback.source).toBe("cache");
    expect(fallback.manifest?.version).toBe("0.1.0");
    expect(fallback.error).toContain("network unavailable");
  });
});
