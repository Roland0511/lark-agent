import { describe, expect, it } from "vitest";
import { approvalPolicyDecision, authorizationFromMessage } from "./policy.js";

describe("authorization policy", () => {
  it("grants only explicitly requested owner capabilities", () => {
    expect(authorizationFromMessage("请修改代码、提交并推送", true)).toEqual({
      read: true,
      repoWrite: true,
      gitCommit: true,
      gitPush: true,
      deploy: false,
      larkWrite: false,
      destructive: false
    });
  });

  it("does not grant member write capabilities", () => {
    expect(authorizationFromMessage("请修改、提交、推送并上线", false)).toEqual({
      read: true,
      repoWrite: false,
      gitCommit: false,
      gitPush: false,
      deploy: false,
      larkWrite: false,
      destructive: false
    });
  });

  it("requires explicit remote authorization and never auto-approves destructive commands", () => {
    const grant = authorizationFromMessage("请修改代码", true);
    expect(approvalPolicyDecision("item/commandExecution/requestApproval", "git push origin main", grant, "owner")).toBeNull();
    expect(approvalPolicyDecision("item/commandExecution/requestApproval", "rm -rf build", grant, "owner")).toBeNull();
    expect(approvalPolicyDecision("item/fileChange/requestApproval", "update src/app.ts", grant, "owner")).toBe("approved");
  });
});
