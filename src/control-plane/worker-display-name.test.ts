import { describe, expect, it } from "vitest";
import { effectiveWorkerDisplayName, publicWorkerDisplayName } from "./worker-display-name.js";

describe("worker display names", () => {
  it("uses the reported device name until an alias is assigned", () => {
    const worker = { display_name: "Mac Studio", display_alias: null };
    expect(effectiveWorkerDisplayName(worker)).toBe("Mac Studio");
    expect(publicWorkerDisplayName(worker)).toEqual({
      display_name: "Mac Studio",
      display_alias: null,
      reported_display_name: "Mac Studio"
    });
  });

  it("keeps the reported device name while exposing the alias as the final display name", () => {
    const worker = { display_name: "Mac Studio", display_alias: "阿朱本机" };
    expect(publicWorkerDisplayName(worker)).toEqual({
      display_name: "阿朱本机",
      display_alias: "阿朱本机",
      reported_display_name: "Mac Studio"
    });
  });
});
