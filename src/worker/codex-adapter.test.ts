import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
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
  if (msg.method === 'turn/start') {
    const turnId = 'turn_' + nextTurn++;
    send({ id: msg.id, result: { turn: { id: turnId } } });
    const prompt = msg.params.input?.[0]?.text;
    const isStructuredTask = Boolean(msg.params.outputSchema) && prompt === 'structured';
    const isAttention = Boolean(msg.params.outputSchema) && !isStructuredTask;
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
      send({ method: 'item/started', params: { item: { id: 'comment_' + turnId, type: 'agentMessage', text: '', phase: 'commentary' } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'comment_' + turnId, delta: 'checking' } });
      send({ method: 'item/completed', params: { item: { id: 'comment_' + turnId, type: 'agentMessage', text: 'checking', phase: 'commentary' } } });
      send({ method: 'item/started', params: { item: { id: 'final_' + turnId, type: 'agentMessage', text: '', phase: 'final_answer' } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'final_' + turnId, delta: 'done' } });
      send({ method: 'item/completed', params: { item: { id: 'final_' + turnId, type: 'agentMessage', text: 'done', phase: 'final_answer' } } });
    }
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
  it("starts app-server with fixed profile overrides and supports persistent and attention turns", async () => {
    const config = await fakeCodexConfig();
    const commentary: string[] = [];
    const adapter = new CodexAdapter(config, async () => "decline", undefined, async (update) => { commentary.push(update.text); });
    await adapter.start();
    const threadId = await adapter.startOrResumeThread(config.codexHome, null);
    expect(threadId).toBe("thr_1");
    await expect(adapter.runTurn(threadId, "work")).resolves.toEqual({ turnId: "turn_1", text: "done" });
    await expect(adapter.runTurn(threadId, "structured", {
      outputSchema: { type: "object" }, publishCommentary: true
    })).resolves.toEqual({
      turnId: "turn_2",
      text: JSON.stringify({ reply: "2", disposition: "awaiting_followup", rationale: "counting continues" })
    });
    await expect(adapter.attention(config.codexHome, "task", "signal")).resolves.toEqual({ decision: "consume", priority: 80, rationale: "relevant" });
    expect(commentary).toEqual(["checking", "structured checking"]);
    await adapter.stop();
  });
});
