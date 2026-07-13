import { describe, expect, it } from "vitest";
import { RuntimeStatus } from "./runtime-status.js";

describe("RuntimeStatus", () => {
  it("treats a disabled optional card consumer as healthy", () => {
    const runtime = new RuntimeStatus();
    runtime.configure("im.message.receive_v1", true, true);
    runtime.configure("card.action.trigger", false, false);
    runtime.ready("im.message.receive_v1");
    expect(runtime.requiredReady()).toBe(true);
    expect(runtime.snapshot()["card.action.trigger"]).toMatchObject({ enabled: false, required: false, state: "disabled", ready: false });
  });

  it("does not let an optional card error affect core readiness", () => {
    const runtime = new RuntimeStatus();
    runtime.configure("im.message.receive_v1", true, true);
    runtime.configure("card.action.trigger", true, false);
    runtime.ready("im.message.receive_v1");
    runtime.error("card.action.trigger", new Error("not subscribed"));
    expect(runtime.requiredReady()).toBe(true);
    expect(runtime.snapshot()["card.action.trigger"]).toMatchObject({ state: "error", ready: false });
  });

  it("fails core readiness when the message consumer errors", () => {
    const runtime = new RuntimeStatus();
    runtime.configure("im.message.receive_v1", true, true);
    runtime.configure("card.action.trigger", false, false);
    runtime.error("im.message.receive_v1", new Error("disconnected"));
    expect(runtime.requiredReady()).toBe(false);
  });
});
