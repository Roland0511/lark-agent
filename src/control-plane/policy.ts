import type { AuthorizationGrant } from "../shared/contracts.js";

const destructivePattern = /(^|\s)(rm\s+-rf|git\s+push\s+.*--force|git\s+reset\s+--hard|drop\s+(database|table)|delete\s+from)(\s|$)/i;

export function authorizationFromMessage(content: string, isOwner: boolean): AuthorizationGrant {
  if (!isOwner) {
    return { read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false };
  }
  return {
    read: true,
    repoWrite: /实现|修改|修复|write|edit|implement|fix/i.test(content),
    gitCommit: /提交|commit/i.test(content),
    gitPush: /推送|push/i.test(content),
    deploy: /部署|上线|发布|deploy|release/i.test(content),
    larkWrite: /创建|更新|写入|发送|create|update|send/i.test(content),
    destructive: false
  };
}

export function approvalPolicyDecision(
  method: string,
  summary: string,
  grant: AuthorizationGrant,
  requesterRole: "owner" | "member"
): "approved" | "rejected" | null {
  if (destructivePattern.test(summary)) return null;
  if (requesterRole !== "owner") return null;
  if (/fileChange/i.test(method)) return grant.repoWrite ? "approved" : null;
  if (/commandExecution/i.test(method)) {
    if (/git\s+push/i.test(summary)) return grant.gitPush ? "approved" : null;
    if (/git\s+commit/i.test(summary)) return grant.gitCommit ? "approved" : null;
    if (/deploy|release|上线|部署/i.test(summary)) return grant.deploy ? "approved" : null;
    return grant.repoWrite ? "approved" : null;
  }
  return null;
}
