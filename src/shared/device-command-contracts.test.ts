import { describe, expect, it } from "vitest";
import { adminDeviceCommandSchema, deviceManagerHeartbeatSchema } from "./contracts.js";
import { redactMigrationText } from "../control-plane/device-command-routes.js";

describe("device command contracts", () => {
  it("accepts only typed allowlisted commands", () => {
    expect(adminDeviceCommandSchema.parse({ type: "restart" })).toEqual({ type: "restart" });
    expect(adminDeviceCommandSchema.parse({ type: "logs" })).toEqual({ type: "logs", lines: 200 });
    expect(() => adminDeviceCommandSchema.parse({ type: "shell", command: "rm -rf /" })).toThrow();
    expect(() => adminDeviceCommandSchema.parse({ type: "logs", lines: 501 })).toThrow();
    expect(() => adminDeviceCommandSchema.parse({ type: "switch_profile", targetProfile: "../other" })).toThrow();
  });

  it("limits and validates the manager profile inventory", () => {
    expect(deviceManagerHeartbeatSchema.parse({
      version: "0.5.0",
      localState: "stopped",
      activeProfile: "he",
      profiles: [{ name: "seed", model: "seed-model", modelProvider: "he", modifiedAt: "2026-07-16T00:00:00.000Z" }]
    }).profiles[0]?.name).toBe("seed");
    expect(() => deviceManagerHeartbeatSchema.parse({ version: "0.5.0", localState: "unknown", activeProfile: "he", profiles: [] })).toThrow();
  });

  it("redacts credentials before persisting migration summaries", () => {
    const redacted = redactMigrationText("api_key=secret-value token: ghp-abcdefghijklmnopqrstuvwxyz password=hunter2");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("ghp-");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("[REDACTED]");
  });
});
