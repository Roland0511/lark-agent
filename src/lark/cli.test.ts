import { describe, expect, it } from "vitest";
import { consumerExitError, isPermanentConsumerExit } from "./cli.js";

describe("lark-cli consumer exit policy", () => {
  it("does not retry permanent validation or authentication failures", () => {
    expect(isPermanentConsumerExit(2)).toBe(true);
    expect(isPermanentConsumerExit(3)).toBe(true);
  });

  it("allows transient failures to restart", () => {
    expect(isPermanentConsumerExit(1)).toBe(false);
    expect(isPermanentConsumerExit(4)).toBe(false);
    expect(isPermanentConsumerExit(null)).toBe(false);
  });

  it("preserves the structured lark-cli startup diagnostic", () => {
    const error = consumerExitError("card.action.trigger", 2, JSON.stringify({
      ok: false,
      error: { message: "callback is not subscribed", hint: "subscribe it in the console" }
    }));
    expect(error.message).toBe("callback is not subscribed; subscribe it in the console");
  });

  it("extracts a JSON error when lark-cli also writes progress lines", () => {
    const error = consumerExitError("im.message.receive_v1", 2, [
      "[event] consuming as bot-example",
      JSON.stringify({ error: { message: "message event is not subscribed", hint: "subscribe it in the console" } }, null, 2),
      "[event] stopped"
    ].join("\n"));
    expect(error.message).toBe("message event is not subscribed; subscribe it in the console");
  });

});
