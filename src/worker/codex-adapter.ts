import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AttentionResult, WorkerModelCatalogEntry } from "../shared/contracts.js";
import { attentionResultSchema } from "../shared/contracts.js";
import { errorMessage } from "../shared/errors.js";
import type { ResolvedWorkerConfig } from "./config.js";

type RpcId = number;
type RpcMessage = { id?: RpcId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface TurnCollector {
  threadId: string;
  turnId: string | null;
  items: Map<string, { text: string; phase: "commentary" | "final_answer" | null; order: number; lastPublishedText: string }>;
  legacyText: string;
  nextOrder: number;
  commentaryOrdinal: number;
  publishCommentary: boolean;
  resolve: (value: { turnId: string; text: string }) => void;
  reject: (error: Error) => void;
}

export type ApprovalHandler = (request: { id: string; method: string; params: Record<string, unknown>; summary: string }) => Promise<"accept" | "decline" | "cancel">;
export type ItemHandler = (item: Record<string, unknown>) => Promise<void>;
export type CommentaryHandler = (update: { itemId: string; text: string; ordinal: number }) => Promise<void>;
export type ActivityHandler = (method: string, params: Record<string, unknown>) => void;

export interface CodexSkillMetadata {
  name: string;
  description: string;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
  enabled: boolean;
  shortDescription: string | null;
  interface: {
    displayName: string | null;
    shortDescription: string | null;
  } | null;
  dependencies: Array<{ type: string; value: string; description: string | null }>;
}

export interface CodexSkillsListEntry {
  cwd: string;
  skills: CodexSkillMetadata[];
  errors: Array<{ path: string; message: string }>;
}

interface CodexAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  shellEnvironmentAllowlist?: string[];
  redactStderr?: (chunk: string) => string;
}

export class CodexAdapter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private collector: TurnCollector | null = null;

  constructor(
    private readonly config: ResolvedWorkerConfig,
    private readonly approvalHandler: ApprovalHandler,
    private readonly itemHandler?: ItemHandler,
    private readonly commentaryHandler?: CommentaryHandler,
    private readonly activityHandler?: ActivityHandler,
    private readonly options: CodexAdapterOptions = {}
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    const env: NodeJS.ProcessEnv = { ...(this.options.environment ?? process.env), CODEX_HOME: this.config.codexHome };
    delete env.CODEX_SQLITE_HOME;
    const environmentPolicyOverrides = this.options.shellEnvironmentAllowlist
      ? [
          'shell_environment_policy.inherit="all"',
          "shell_environment_policy.ignore_default_excludes=true",
          `shell_environment_policy.include_only=${JSON.stringify([...new Set(this.options.shellEnvironmentAllowlist)].sort())}`
        ]
      : [];
    const child = spawn(this.config.codexBinary, [
      "app-server",
      ...this.config.profileOverrides.flatMap((value) => ["-c", value]),
      ...environmentPolicyOverrides.flatMap((value) => ["-c", value]),
      "--stdio"
    ], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const safeChunk = this.options.redactStderr ? this.options.redactStderr(chunk) : chunk;
      process.stderr.write(`[codex:${this.config.executorId}] ${safeChunk}`);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("close", (code) => this.failAll(new Error(`Codex App Server exited ${code ?? -1}`)));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    await this.request("initialize", {
      clientInfo: { name: "lark_agent", title: "Lark Agent", version: "0.4.1" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const exit = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5_000);
    await exit;
    clearTimeout(timeout);
    this.child = null;
  }

  async startOrResumeThread(cwd: string, threadId: string | null, model: string | null = null): Promise<string> {
    const result = (await this.request(threadId ? "thread/resume" : "thread/start", threadId
      ? { threadId, cwd, approvalPolicy: "on-request", approvalsReviewer: "user" }
      : { cwd, approvalPolicy: "on-request", approvalsReviewer: "user", ephemeral: false, serviceName: "lark-agent", ...(model ? { model } : {}) })) as {
      thread?: { id?: string };
    };
    const id = result.thread?.id;
    if (!id) throw new Error("Codex did not return a thread id");
    if (threadId && id !== threadId) {
      throw new Error(`Codex resumed an unexpected thread id (expected ${threadId}, received ${id})`);
    }
    return id;
  }

  async runTurn(
    threadId: string,
    text: string,
    options: { outputSchema?: Record<string, unknown>; publishCommentary?: boolean; model?: string | null; effort?: string | null; localImages?: string[] } = {}
  ): Promise<{ turnId: string; text: string }> {
    if (this.collector) throw new Error("only one primary turn may run per executor instance");
    let collector!: TurnCollector;
    const completion = new Promise<{ turnId: string; text: string }>((resolve, reject) => {
      collector = { threadId, turnId: null, items: new Map(), legacyText: "", nextOrder: 1, commentaryOrdinal: 0, publishCommentary: options.publishCommentary ?? !options.outputSchema, resolve, reject };
      this.collector = collector;
    });
    try {
      const result = (await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text }, ...(options.localImages ?? []).map((path) => ({ type: "localImage", path }))],
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {})
      })) as { turn?: { id?: string } };
      const turnId = result.turn?.id;
      if (!turnId) throw new Error("Codex did not return a turn id");
      collector.turnId = turnId;
      return await completion;
    } catch (error) {
      collector.reject(error instanceof Error ? error : new Error(String(error)));
      this.collector = null;
      throw error;
    }
  }

  async attention(
    cwd: string,
    taskSummary: string,
    signalPreview: string,
    policy: { model: string | null; effort: string | null } = { model: null, effort: null }
  ): Promise<AttentionResult> {
    const threadId = await this.startEphemeralThread(cwd, policy.model);
    const result = await this.runTurn(
      threadId,
      buildAttentionPrompt(taskSummary, signalPreview),
      { model: policy.model, effort: policy.effort, outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "priority", "rationale"],
        properties: {
          decision: { type: "string", enum: ["consume", "defer", "dismiss", "merge"] },
          priority: { type: "integer", minimum: 0, maximum: 100 },
          rationale: { type: "string", maxLength: 500 }
        }
      } }
    );
    return attentionResultSchema.parse(parseJsonText(result.text));
  }

  async steer(threadId: string, turnId: string, text: string): Promise<void> {
    await this.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  activeTurn(): { threadId: string; turnId: string } | null {
    if (!this.collector?.turnId) return null;
    return { threadId: this.collector.threadId, turnId: this.collector.turnId };
  }

  async listModels(): Promise<WorkerModelCatalogEntry[]> {
    const models: WorkerModelCatalogEntry[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request("model/list", { cursor, limit: 100, includeHidden: false }) as {
        data?: Array<Record<string, unknown>>;
        nextCursor?: string | null;
      };
      for (const item of result.data ?? []) {
        const id = String(item.id ?? item.model ?? "").trim();
        if (!id) continue;
        const efforts = Array.isArray(item.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts.map((entry) => typeof entry === "string" ? entry : String((entry as Record<string, unknown>).reasoningEffort ?? "")).filter(Boolean)
          : [];
        models.push({
          id,
          displayName: String(item.displayName ?? id),
          isDefault: item.isDefault === true,
          defaultReasoningEffort: typeof item.defaultReasoningEffort === "string" ? item.defaultReasoningEffort : null,
          supportedReasoningEfforts: [...new Set(efforts)]
        });
      }
      cursor = result.nextCursor ?? null;
    } while (cursor);
    return models;
  }

  async listSkills(cwds: string[], forceReload = true): Promise<CodexSkillsListEntry[]> {
    const result = await this.request("skills/list", { cwds, forceReload }) as { data?: unknown[] };
    return (result.data ?? []).map((rawEntry) => {
      const entry = rawEntry && typeof rawEntry === "object" ? rawEntry as Record<string, unknown> : {};
      const skills = Array.isArray(entry.skills) ? entry.skills : [];
      const errors = Array.isArray(entry.errors) ? entry.errors : [];
      return {
        cwd: String(entry.cwd ?? ""),
        skills: skills.flatMap((rawSkill): CodexSkillMetadata[] => {
          if (!rawSkill || typeof rawSkill !== "object") return [];
          const skill = rawSkill as Record<string, unknown>;
          const scope = skill.scope;
          if (scope !== "user" && scope !== "repo" && scope !== "system" && scope !== "admin") return [];
          const skillInterface = skill.interface && typeof skill.interface === "object"
            ? skill.interface as Record<string, unknown>
            : null;
          const dependencies = skill.dependencies && typeof skill.dependencies === "object"
            ? (skill.dependencies as Record<string, unknown>).tools
            : null;
          return [{
            name: String(skill.name ?? ""),
            description: String(skill.description ?? ""),
            path: String(skill.path ?? ""),
            scope,
            enabled: skill.enabled === true,
            shortDescription: typeof skill.shortDescription === "string" ? skill.shortDescription : null,
            interface: skillInterface ? {
              displayName: typeof skillInterface.displayName === "string" ? skillInterface.displayName : null,
              shortDescription: typeof skillInterface.shortDescription === "string" ? skillInterface.shortDescription : null
            } : null,
            dependencies: Array.isArray(dependencies) ? dependencies.flatMap((rawDependency): CodexSkillMetadata["dependencies"] => {
              if (!rawDependency || typeof rawDependency !== "object") return [];
              const dependency = rawDependency as Record<string, unknown>;
              const type = String(dependency.type ?? "").trim();
              const value = String(dependency.value ?? "").trim();
              return type && value ? [{
                type,
                value,
                description: typeof dependency.description === "string" ? dependency.description : null
              }] : [];
            }) : []
          }];
        }),
        errors: errors.flatMap((rawError) => {
          if (!rawError || typeof rawError !== "object") return [];
          const error = rawError as Record<string, unknown>;
          return [{ path: String(error.path ?? ""), message: String(error.message ?? "skill discovery failed") }];
        })
      };
    });
  }

  private async startEphemeralThread(cwd: string, model: string | null): Promise<string> {
    const result = (await this.request("thread/start", {
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      ephemeral: true,
      serviceName: "lark-agent-attention",
      ...(model ? { model } : {})
    })) as { thread?: { id?: string } };
    if (!result.thread?.id) throw new Error("Codex did not return an attention thread id");
    return result.thread.id;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ id, method, params });
    return promise;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private write(message: RpcMessage): void {
    if (!this.child) throw new Error("Codex App Server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch (error) {
      this.failAll(new Error(`invalid Codex JSONL: ${errorMessage(error)}`));
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Codex RPC ${message.error.code ?? ""}: ${message.error.message ?? "unknown error"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    this.handleNotification(message);
  }

  private handleNotification(message: RpcMessage): void {
    if (message.method) this.activityHandler?.(message.method, message.params ?? {});
    const collector = this.collector;
    if (!collector || !message.method) return;
    if (message.method === "item/started") {
      const item = message.params?.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && typeof item.id === "string") {
        collector.items.set(item.id, {
          text: typeof item.text === "string" ? item.text : "",
          phase: messagePhase(item.phase),
          order: collector.nextOrder++,
          lastPublishedText: ""
        });
      }
    } else if (message.method === "item/agentMessage/delta") {
      const delta = message.params?.delta;
      const itemId = typeof message.params?.itemId === "string" ? message.params.itemId : null;
      if (typeof delta === "string" && itemId) {
        const item = collector.items.get(itemId) ?? { text: "", phase: null, order: collector.nextOrder++, lastPublishedText: "" };
        item.text += delta;
        collector.items.set(itemId, item);
        if (collector.publishCommentary && item.phase === "commentary" && this.commentaryHandler) {
          collector.commentaryOrdinal += 1;
          item.lastPublishedText = item.text;
          void this.commentaryHandler({ itemId, text: item.text, ordinal: collector.commentaryOrdinal }).catch(() => undefined);
        }
      } else if (typeof delta === "string") {
        collector.legacyText += delta;
      }
    } else if (message.method === "item/completed") {
      const item = message.params?.item as Record<string, unknown> | undefined;
      if (item && this.itemHandler) void this.itemHandler(item).catch(() => undefined);
      if (item?.type === "agentMessage" && typeof item.id === "string") {
        const current = collector.items.get(item.id) ?? { text: "", phase: null, order: collector.nextOrder++, lastPublishedText: "" };
        current.text = typeof item.text === "string" ? item.text : current.text;
        current.phase = messagePhase(item.phase) ?? current.phase;
        collector.items.set(item.id, current);
        if (collector.publishCommentary && current.phase === "commentary" && current.text && current.text !== current.lastPublishedText && this.commentaryHandler) {
          collector.commentaryOrdinal += 1;
          current.lastPublishedText = current.text;
          void this.commentaryHandler({ itemId: item.id, text: current.text, ordinal: collector.commentaryOrdinal }).catch(() => undefined);
        }
      }
    } else if (message.method === "turn/completed") {
      const turn = message.params?.turn as Record<string, unknown> | undefined;
      const turnId = String(turn?.id ?? collector.turnId ?? "");
      const status = String(turn?.status ?? "completed");
      const text = finalAgentText(collector);
      this.collector = null;
      if (status === "failed") collector.reject(new Error("Codex turn failed"));
      else collector.resolve({ turnId, text });
    }
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    const id = message.id as number;
    const method = message.method as string;
    const params = message.params ?? {};
    try {
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        const summary = approvalSummary(method, params);
        const decision = await this.approvalHandler({ id: String(id), method, params, summary });
        this.write({ id, result: { decision } });
      } else if (method === "mcpServer/elicitation/request") {
        this.write({ id, result: { action: "decline" } });
      } else {
        this.write({ id, error: { code: -32000, message: `unsupported server request: ${method}` } });
      }
    } catch (error) {
      this.write({ id, error: { code: -32000, message: errorMessage(error) } });
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.collector) this.collector.reject(error);
    this.collector = null;
    this.child = null;
  }
}

export function buildAttentionPrompt(taskSummary: string, signalPreview: string): string {
  return [
    "你是消息注意力控制器。不要执行任务，只判断新信号是否值得进入主工作线程。",
    "已注册机器人的最终回复与人类成员消息完全等价；不得仅因来源是 bot、像状态提示或符合先前预期而忽略。",
    "若信号明确点名当前机器人、说明轮到当前机器人、要求当前机器人行动，或给出接龙/协作所需的新一步，必须选择 consume 或 merge。协作方把下一轮交给当前机器人属于新的可执行输入，不是重复消息。",
    "只有与当前会话无关，或对后续行为确实没有任何新增影响的信号，才可以 dismiss。",
    `当前任务摘要：${taskSummary}`,
    `新信号预览：${signalPreview}`,
    "选择 consume、defer、dismiss 或 merge，并给出 0-100 优先级和简短理由。"
  ].join("\n");
}

function messagePhase(value: unknown): "commentary" | "final_answer" | null {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function finalAgentText(collector: TurnCollector): string {
  const items = [...collector.items.values()].sort((a, b) => a.order - b.order);
  const final = items.filter((item) => item.phase === "final_answer" && item.text.trim()).at(-1);
  if (final) return final.text.trim();
  const unknown = items.filter((item) => item.phase === null && item.text.trim()).at(-1);
  if (unknown) return unknown.text.trim();
  return collector.legacyText.trim();
}

function approvalSummary(method: string, params: Record<string, unknown>): string {
  const command = params.command ?? params.reason ?? params.changes ?? params;
  const value = typeof command === "string" ? command : JSON.stringify(command);
  return `${method}: ${value}`.slice(0, 2_000);
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    throw new Error(`Codex attention result was not JSON: ${trimmed.slice(0, 500)}`);
  }
}
