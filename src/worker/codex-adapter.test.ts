import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildAttentionPrompt, CodexAdapter } from "./codex-adapter.js";
import type { ResolvedWorkerConfig } from "./config.js";

async function fakeCodexConfig(): Promise<ResolvedWorkerConfig> {
  const root = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const binary = join(root, "codex");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli fake'); process.exit(0); }
let nextThread = 1;
let nextTurn = 1;
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { userAgent: 'fake' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/start') return send({ id: msg.id, result: { thread: { id: 'thr_' + nextThread++ } } });
  if (msg.method === 'thread/resume') return send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
  if (msg.method === 'model/list') return send({ id: msg.id, result: { data: [{ id: 'exec-model', model: 'exec-model', displayName: 'Execution Model', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: null } });
  if (msg.method === 'turn/start') {
    const turnId = 'turn_' + nextTurn++;
    send({ id: msg.id, result: { turn: { id: turnId } } });
    const prompt = msg.params.input?.[0]?.text;
    const localImageAccepted = msg.params.input?.[1]?.type === 'localImage' && msg.params.input?.[1]?.path === '/tmp/screen.png';
    const isStructuredTask = Boolean(msg.params.outputSchema) && prompt === 'structured';
    const isAttention = Boolean(msg.params.outputSchema) && !isStructuredTask;
    if (isStructuredTask && (msg.params.model !== 'exec-model' || msg.params.effort !== 'high')) return send({ id: msg.id, error: { code: -1, message: 'execution policy missing' } });
    if (isAttention && (msg.params.model !== 'attention-model' || msg.params.effort !== 'low')) return send({ id: msg.id, error: { code: -1, message: 'attention policy missing' } });
    if (isStructuredTask) {
      const text = JSON.stringify({ reply: '2', disposition: 'awaiting_followup', rationale: 'counting continues' });
      send({ method: 'item/started', params: { item: { id: 'comment_' + turnId, type: 'agentMessage', text: '', phase: 'commentary' } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'comment_' + turnId, delta: 'structured checking' } });
      send({ method: 'item/completed', params: { item: { id: 'comment_' + turnId, type: 'agentMessage', text: 'structured checking', phase: 'commentary' } } });
      send({ method: 'item/started', params: { item: { id: 'final_' + turnId, type: 'agentMessage', text: '', phase: 'final_answer' } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'final_' + turnId, delta: text } });
      send({ method: 'item/completed', params: { item: { id: 'final_' + turnId, type: 'agentMessage', text, phase: 'final_answer' } } });
    } else if (isAttention) {
      const text = JSON.stringify({ decision: 'consume', priority: 80, rationale: 'relevant' });
      send({ method: 'item/started', params: { item: { id: 'attention_' + turnId, type: 'agentMessage', text: '', phase: 'final_answer' } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'attention_' + turnId, delta: text } });
      send({ method: 'item/completed', params: { item: { id: 'attention_' + turnId, type: 'agentMessage', text, phase: 'final_answer' } } });
    } else {
      const finalText = prompt === 'with-image' && localImageAccepted ? 'image accepted' : 'done';
      send({ method: 'item/started', params: { item: { id: 'comment_' + turnId, type: 'agentMessage', text: '', phase: 'commentary' } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'comment_' + turnId, delta: 'checking' } });
      send({ method: 'item/completed', params: { item: { id: 'comment_' + turnId, type: 'agentMessage', text: 'checking', phase: 'commentary' } } });
      send({ method: 'item/started', params: { item: { id: 'final_' + turnId, type: 'agentMessage', text: '', phase: 'final_answer' } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'final_' + turnId, delta: finalText } });
      send({ method: 'item/completed', params: { item: { id: 'final_' + turnId, type: 'agentMessage', text: finalText, phase: 'final_answer' } } });
    }
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr_1', turnId, tokenUsage: { last: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 15 }, total: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 15 } } } });
    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
  }
});
`;
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  return {
    controlPlaneUrl: "https://example.test",
    deviceToken: "secret",
    executorId: "test",
    displayName: "Test",
    codexHome: root,
    homeRef: "test:1234",
    codexProfile: "lark-agent",
    profileOverrides: ['model="test"'],
    profileModel: "test",
    profileReasoningEffort: "high",
    codexBinary: binary,
    codexVersion: "fake",
    configFingerprint: "a".repeat(64),
    capacity: 1,
    appLauncher: null,
    workspaceRoots: [{ alias: "repo", path: root }],
    capabilities: ["codex"]
  };
}

describe("CodexAdapter", () => {
  it("treats a registered bot handing over the next turn as actionable input", () => {
    const prompt = buildAttentionPrompt(
      "当前机器人：Bot A\n上一回合等待理由：等待 Bot B 接龙后继续",
      "[bot:Bot B|member|depth=1] 现在轮到 Bot A 数 2，Bot B 先等着"
    );
    expect(prompt).toContain("已注册机器人的最终回复与人类成员消息完全等价");
    expect(prompt).toContain("说明轮到当前机器人");
    expect(prompt).toContain("必须选择 consume 或 merge");
    expect(prompt).toContain("当前机器人：Bot A");
    expect(prompt).toContain("[bot:Bot B|member|depth=1]");
  });

  it("starts app-server with fixed profile overrides and supports persistent and attention turns", async () => {
    const config = await fakeCodexConfig();
    const commentary: string[] = [];
    const activity: string[] = [];
    const adapter = new CodexAdapter(config, async () => "decline", undefined, async (update) => { commentary.push(update.text); }, (method) => activity.push(method));
    await adapter.start();
    await expect(adapter.listModels()).resolves.toEqual([{ id: "exec-model", displayName: "Execution Model", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: ["medium", "high"] }]);
    const threadId = await adapter.startOrResumeThread(config.codexHome, null);
    expect(threadId).toBe("thr_1");
    await expect(adapter.runTurn(threadId, "work")).resolves.toEqual({ turnId: "turn_1", text: "done" });
    await expect(adapter.runTurn(threadId, "with-image", { localImages: ["/tmp/screen.png"] })).resolves.toEqual({ turnId: "turn_2", text: "image accepted" });
    await expect(adapter.runTurn(threadId, "structured", {
      outputSchema: { type: "object" }, publishCommentary: true, model: "exec-model", effort: "high"
    })).resolves.toEqual({
      turnId: "turn_3",
      text: JSON.stringify({ reply: "2", disposition: "awaiting_followup", rationale: "counting continues" })
    });
    await expect(adapter.attention(config.codexHome, "task", "signal", { model: "attention-model", effort: "low" })).resolves.toEqual({ decision: "consume", priority: 80, rationale: "relevant" });
    expect(commentary).toEqual(["checking", "checking", "structured checking"]);
    expect(activity).toContain("thread/tokenUsage/updated");
    await adapter.stop();
  });
});
