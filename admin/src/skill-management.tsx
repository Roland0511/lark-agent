import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, ChevronDown, FileClock, KeyRound, Layers3,
  LockKeyhole, Plus, RefreshCw, Search, Server, ShieldCheck, Sparkles, Trash2, Upload, X
} from "lucide-react";
import { api, relativeTime, type AdminUser } from "./api";

type AnyRecord = Record<string, any>;

export type SkillBindingView = {
  id: string;
  coordinate: string;
  name: string;
  version: string;
  description: string;
  scope: "bot" | "chat_context";
  chatContextId: string | null;
  chatName: string | null;
  syncStatus: string;
  updatedAt: string | null;
  environmentCount: number;
  fileCount: number;
  declaredDependencies: Array<{ type: string; value: string; description: string | null }>;
};

type RuntimeEnvironmentView = {
  name: string;
  mode: "inherited" | "replace" | "disabled" | "configured";
  sourceScope: "bot" | "chat_context";
  updatedAt: string | null;
};

type RuntimeFileView = {
  id: string;
  targetPath: string;
  mode: "inherited" | "replace" | "disabled" | "configured";
  sourceScope: "bot" | "chat_context";
  status: string;
  revision: string;
  size: number | null;
  desiredSha: string | null;
  actualSha: string | null;
  checkedAt: string | null;
};

const runtimeStatusLabels: Record<string, string> = {
  pending: "等待同步",
  waiting_sync: "等待同步",
  pending_force: "等待强制同步",
  applied: "已应用",
  synced: "已应用",
  configured: "已配置",
  unchanged: "无需变更",
  deleted: "已删除",
  offline: "Runner 离线",
  updating: "更新中",
  pending_delete: "等待删除",
  deleting: "等待删除",
  drift: "内容漂移",
  conflict: "路径冲突",
  failed: "同步失败",
  error: "同步失败",
  stale: "数据已过期",
  ready: "已就绪",
  unknown: "尚未获取"
};

function records(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter((item): item is AnyRecord => Boolean(item && typeof item === "object")) : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value) return value;
  return null;
}

function numberValue(...values: unknown[]): number {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function bindingRecords(payload: AnyRecord | undefined): AnyRecord[] {
  if (!payload) return [];
  const direct = records(payload.items ?? payload.bindings);
  if (direct.length) return direct;
  return [
    ...records(payload.globalSkills ?? payload.global ?? payload.botSkills).map((item) => ({ ...item, scope: item.scope ?? "bot" })),
    ...records(payload.threadSkills ?? payload.threads ?? payload.chatContextSkills).flatMap((entry) => {
      if (Array.isArray(entry.skills)) return records(entry.skills).map((item) => ({ ...item, scope: "chat_context", chatContextId: item.chatContextId ?? entry.chatContextId, chatName: item.chatName ?? entry.chatName }));
      return [{ ...entry, scope: entry.scope ?? "chat_context" }];
    })
  ];
}

export function normalizeSkillBindings(payload: AnyRecord | undefined): SkillBindingView[] {
  return bindingRecords(payload).map((item, index) => {
    const packageData = item.package ?? item.skillPackage ?? {};
    const namespace = firstString(item.namespace, packageData.namespace);
    const slug = firstString(item.slug, packageData.slug);
    const coordinate = firstString(item.coordinate, packageData.coordinate) ?? (namespace && slug ? `@${namespace}/${slug}` : `skill-${index + 1}`);
    const rawScope = firstString(item.scope, item.scopeType);
    const chatContextId = firstString(item.chatContextId, item.chat_context_id);
    const dependencySource = item.declaredDependencies ?? item.declared_dependencies ?? packageData.dependencies ?? {};
    const declaredDependencies = records(dependencySource.tools ?? dependencySource).flatMap((dependency) => {
      const type = firstString(dependency.type);
      const value = firstString(dependency.value);
      return type && value ? [{ type, value, description: firstString(dependency.description) }] : [];
    });
    return {
      id: firstString(item.id, item.bindingId, item.binding_id) ?? `${coordinate}:${chatContextId ?? "bot"}`,
      coordinate,
      name: firstString(item.name, item.skillName, item.skill_name, packageData.name, packageData.skillName) ?? coordinate,
      version: firstString(item.version, item.pinnedVersion, item.pinned_version, packageData.version) ?? "待解析",
      description: firstString(item.description, packageData.description) ?? "暂无技能说明",
      scope: rawScope === "chat_context" || rawScope === "thread" || Boolean(chatContextId) ? "chat_context" : "bot",
      chatContextId,
      chatName: firstString(item.chatName, item.chat_name),
      syncStatus: firstString(item.syncStatus, item.sync_status, item.state) ?? "configured",
      updatedAt: firstString(item.updatedAt, item.updated_at),
      environmentCount: numberValue(item.environmentCount, item.environment_count, item.runtimeConfigSummary?.environmentCount),
      fileCount: numberValue(item.fileCount, item.file_count, item.runtimeConfigSummary?.fileCount),
      declaredDependencies
    };
  });
}

function effectiveSkillRecords(payload: AnyRecord | undefined, chatContextId: string): SkillBindingView[] {
  if (!payload) return [];
  const candidates = records(payload.effectiveSkills ?? payload.effective).length
    ? normalizeSkillBindings({ items: records(payload.effectiveSkills ?? payload.effective) })
    : normalizeSkillBindings(payload).filter((item) => item.scope === "bot" || item.chatContextId === chatContextId);
  const effective = new Map<string, SkillBindingView>();
  for (const item of candidates) {
    const current = effective.get(item.coordinate);
    if (!current || (item.scope === "chat_context" && item.chatContextId === chatContextId)) effective.set(item.coordinate, item);
  }
  return [...effective.values()];
}

function scanState(payload: AnyRecord | undefined): string {
  return firstString(payload?.scanStatus, payload?.scan_status, payload?.status) ?? "unknown";
}

function userSkillRecords(payload: AnyRecord | undefined): AnyRecord[] {
  return records(payload?.items ?? payload?.skills ?? payload?.userSkills);
}

function statusLabel(status: string): string {
  return runtimeStatusLabels[status] ?? status;
}

function statusTone(status: string): string {
  if (["applied", "synced", "configured", "unchanged", "deleted", "ready", "success", "ok"].includes(status)) return "success";
  if (["drift", "conflict", "failed", "error"].includes(status)) return "danger";
  if (["pending", "waiting_sync", "pending_force", "updating", "pending_delete", "deleting", "offline", "stale"].includes(status)) return "warning";
  return "neutral";
}

function shortDigest(value: string | null): string {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function formatSize(value: number | null): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function contextTitle(context: AnyRecord): string {
  return firstString(context.chatName, context.chat_name) ?? (firstString(context.chatType, context.chat_type) === "group" ? "未命名群聊" : "私聊");
}

function contextsFrom(payload: AnyRecord | undefined): AnyRecord[] {
  return records(payload?.items ?? payload?.contexts);
}

function QueryError({ error }: { error: unknown }) {
  return <div className="skill-callout danger" role="alert"><AlertTriangle size={16} />{error instanceof Error ? error.message : "读取失败，请稍后重试"}</div>;
}

function InlineLoading({ text = "正在读取技能状态…" }: { text?: string }) {
  return <div className="skill-inline-loading" role="status"><RefreshCw className="spin" size={16} />{text}</div>;
}

function StatusPill({ status, label }: { status: string; label?: string | undefined }) {
  return <span className={`skill-status-pill tone-${statusTone(status)}`}>{statusTone(status) === "success" ? <CheckCircle2 size={12} /> : statusTone(status) === "danger" ? <AlertTriangle size={12} /> : <FileClock size={12} />}{label ?? statusLabel(status)}</span>;
}

function SkillModal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onClick={onClose}><div ref={dialog} className="modal skill-manager-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}><header className="modal-head"><div><span className="eyebrow">SKILLHUB</span><h2>{title}</h2></div><button className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><X /></button></header>{children}</div></div>;
}

export function BotSkillsCard({ bot, workers, user }: { bot: AnyRecord; workers: AnyRecord[]; user: AdminUser }) {
  const [open, setOpen] = useState(false);
  const skills = useQuery({ queryKey: ["skill", "bot", bot.id], queryFn: () => api<AnyRecord>(`/v1/admin/bots/${bot.id}/skills`), retry: false });
  const items = normalizeSkillBindings(skills.data);
  const globalCount = items.filter((item) => item.scope === "bot").length;
  const threadCount = items.filter((item) => item.scope === "chat_context").length;
  const problemCount = items.filter((item) => ["failed", "error", "drift", "conflict"].includes(item.syncStatus)).length;
  return <>
    <section className="bot-skills-entry" aria-labelledby={`bot-skills-${bot.id}`}>
      <span className="entry-icon"><Sparkles size={20} /></span>
      <span><strong id={`bot-skills-${bot.id}`}>技能与运行依赖</strong><small>{skills.error && !skills.data ? "技能服务暂不可用" : items.length ? "全局与 Thread 专属技能按需合并" : "尚未配置 SkillHub 技能"}</small></span>
      <span className="bot-skill-stats" aria-label="技能配置摘要"><span><b>{globalCount}</b><small>全局</small></span><span><b>{threadCount}</b><small>Thread</small></span>{problemCount > 0 && <span className="danger"><b>{problemCount}</b><small>异常</small></span>}</span>
      <button className="secondary-button" onClick={() => setOpen(true)}>管理技能</button>
    </section>
    {open && <SkillManagerDialog bot={bot} workers={workers} user={user} onClose={() => setOpen(false)} />}
  </>;
}

export function SkillManagerDialog({ bot, workers, user, onClose }: { bot: AnyRecord; workers: AnyRecord[]; user: AdminUser; onClose(): void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"skills" | "runtime" | "runner">("skills");
  const [coordinate, setCoordinate] = useState("");
  const [scope, setScope] = useState<"bot" | "chat_context">("bot");
  const [chatContextId, setChatContextId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [runtimeBindingId, setRuntimeBindingId] = useState<string | null>(null);
  const status = useQuery({ queryKey: ["skill", "skillhub-status"], queryFn: () => api<AnyRecord>("/v1/admin/skillhub/status"), retry: false });
  const skills = useQuery({ queryKey: ["skill", "bot", bot.id], queryFn: () => api<AnyRecord>(`/v1/admin/bots/${bot.id}/skills`), retry: false });
  const contexts = useQuery({ queryKey: ["chat-context", "skills", bot.id], queryFn: () => api<AnyRecord>(`/v1/admin/chat-contexts?${new URLSearchParams({ bot: bot.id, limit: "100" })}`) });
  const search = useQuery({ queryKey: ["skill", "search", searchQuery], queryFn: () => api<AnyRecord>(`/v1/admin/skillhub/search?${new URLSearchParams({ q: searchQuery })}`), enabled: Boolean(searchQuery), retry: false });
  const items = normalizeSkillBindings(skills.data);
  const selectedBinding = items.find((item) => item.id === runtimeBindingId) ?? null;
  const contextItems = contextsFrom(contexts.data);
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["skill"] }); };
  const add = useMutation({
    mutationFn: () => api(`/v1/admin/bots/${bot.id}/skills`, { method: "POST", body: JSON.stringify({ coordinate: coordinate.trim(), scope, ...(scope === "chat_context" ? { chatContextId } : {}) }) }, user),
    onSuccess: () => { setCoordinate(""); refresh(); }
  });
  const update = useMutation({ mutationFn: (binding: SkillBindingView) => api(`/v1/admin/bots/${bot.id}/skills/${encodeURIComponent(binding.id)}/update`, { method: "POST", body: "{}" }, user), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (binding: SkillBindingView) => api(`/v1/admin/bots/${bot.id}/skills/${encodeURIComponent(binding.id)}`, { method: "DELETE" }, user), onSuccess: refresh });
  const runnerIds = [...new Set([firstString(bot.defaultExecutorId, bot.default_executor_id), ...contextItems.map((item) => firstString(item.executorId, item.executor_id))].filter((value): value is string => Boolean(value)))];
  const relevantWorkers = runnerIds.length ? workers.filter((worker) => runnerIds.includes(worker.executor_id)) : workers;
  const registryAvailable = status.data ? status.data.available !== false && status.data.configured !== false && status.data.authenticated !== false : !status.error;
  const pickRuntime = (binding: SkillBindingView) => { setRuntimeBindingId(binding.id); setTab("runtime"); };
  return <SkillModal title={`${bot.displayName} · 技能管理`} onClose={onClose}>
    <div className="skill-manager-tabs" role="tablist" aria-label="技能管理区域">{([
      ["skills", "技能配置", Sparkles], ["runtime", "运行依赖", KeyRound], ["runner", "Runner 继承", Server]
    ] as const).map(([key, label, Icon]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}><Icon size={16} />{label}</button>)}</div>
    {tab === "skills" && <div className="skill-manager-body">
      <section className={`skill-registry-state ${registryAvailable ? "ready" : "blocked"}`}><span>{registryAvailable ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}</span><div><strong>{registryAvailable ? "SkillHub 连接可用" : "SkillHub 暂不可配置"}</strong><small>{status.data?.message ?? status.data?.registryUrl ?? (registryAvailable ? "添加时固定当前版本，后续手动升级。" : "请检查控制面的 SkillHub Token 和注册表连接。")}</small></div>{status.data?.lastCheckedAt && <time>{relativeTime(status.data.lastCheckedAt)}</time>}</section>
      <section className="skill-add-panel" aria-labelledby="skill-add-title"><div><strong id="skill-add-title">添加 SkillHub 技能</strong><small>输入完整坐标；技能不会替换 Runner 已有的用户级技能。</small></div><div className="skill-add-form"><label><span>技能名称</span><div className="skill-coordinate-input"><Search size={16} /><input aria-label="技能名称" placeholder="例如 @sh01/git-commit" value={coordinate} onChange={(event) => setCoordinate(event.target.value)} /></div></label><label><span>生效范围</span><select aria-label="生效范围" value={scope} onChange={(event) => setScope(event.target.value as "bot" | "chat_context")}><option value="bot">所有聊天</option><option value="chat_context">仅指定 Thread</option></select></label>{scope === "chat_context" && <label><span>聊天 Thread</span><select aria-label="聊天 Thread" value={chatContextId} onChange={(event) => setChatContextId(event.target.value)}><option value="">请选择聊天</option>{contextItems.map((context) => <option key={context.id} value={context.id}>{contextTitle(context)}</option>)}</select></label>}<button className="primary-button" disabled={!registryAvailable || !coordinate.trim() || (scope === "chat_context" && !chatContextId) || add.isPending} onClick={() => add.mutate()}><Plus size={15} />{add.isPending ? "正在固定版本…" : "添加技能"}</button></div>
        <div className="skill-search-row"><input aria-label="搜索 SkillHub" placeholder="不确定坐标？搜索名称或说明" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setSearchQuery(searchTerm.trim()); }} /><button className="ghost-button" disabled={!searchTerm.trim()} onClick={() => setSearchQuery(searchTerm.trim())}>查找</button></div>
        {search.isFetching && <InlineLoading text="正在搜索 SkillHub…" />}{search.error && <QueryError error={search.error} />}{search.data && <div className="skill-search-results">{records(search.data.items ?? search.data.results).length ? records(search.data.items ?? search.data.results).map((result, index) => { const resultCoordinate = firstString(result.coordinate) ?? (result.namespace && result.slug ? `@${result.namespace}/${result.slug}` : ""); return <button key={resultCoordinate || index} onClick={() => setCoordinate(resultCoordinate)}><span><strong>{resultCoordinate}</strong><small>{firstString(result.description) ?? "暂无技能说明"}</small></span><span>选择</span></button>; }) : <small>没有匹配的技能。</small>}</div>}
        {add.error && <QueryError error={add.error} />}
      </section>
      <section className="managed-skill-section"><div className="skill-section-heading"><div><strong>机器人全局 · {items.filter((item) => item.scope === "bot").length}</strong><small>在此机器人的所有聊天工作区中提供。</small></div></div><SkillRows items={items.filter((item) => item.scope === "bot")} onRuntime={pickRuntime} onUpdate={(item) => update.mutate(item)} onRemove={(item) => window.confirm(`确认移除 ${item.coordinate}？如有工作区配置，请先在“运行依赖”中删除并等待清理完成。`) && remove.mutate(item)} pending={update.isPending || remove.isPending} /></section>
      <section className="managed-skill-section"><div className="skill-section-heading"><div><strong>Thread 专属 · {items.filter((item) => item.scope === "chat_context").length}</strong><small>只在所选聊天记忆的下一次正式执行中生效。</small></div></div><SkillRows items={items.filter((item) => item.scope === "chat_context")} onRuntime={pickRuntime} onUpdate={(item) => update.mutate(item)} onRemove={(item) => window.confirm(`确认移除 ${item.coordinate}？如有工作区配置，请先在“运行依赖”中删除并等待清理完成。`) && remove.mutate(item)} pending={update.isPending || remove.isPending} /></section>
      {(skills.error || update.error || remove.error) && <QueryError error={skills.error ?? update.error ?? remove.error} />}
    </div>}
    {tab === "runtime" && <div className="skill-manager-body">{items.length ? <><div className="runtime-binding-picker"><label>配置哪个技能<select aria-label="配置哪个技能" value={runtimeBindingId ?? ""} onChange={(event) => setRuntimeBindingId(event.target.value || null)}><option value="">请选择技能</option>{items.map((item) => <option key={item.id} value={item.id}>{item.coordinate} · {item.scope === "bot" ? "所有聊天" : item.chatName ?? "指定 Thread"}</option>)}</select></label><div className="skill-callout neutral"><LockKeyhole size={16} />敏感值写入后不可回读。Thread 范围不是同一 Runner 内的 OS 隔离；高敏凭证请使用独立 Runner。</div></div>{selectedBinding ? <RuntimeConfigPanel botId={bot.id} binding={selectedBinding} contexts={contextItems} user={user} /> : <SkillEmpty icon={<KeyRound />} title="选择一个技能" text="选择技能后，可配置环境变量和持续保留在工作区的文本文件。" />}</> : <SkillEmpty icon={<Sparkles />} title="还没有可配置的技能" text="先添加一个 SkillHub 技能，再为它准备运行依赖。" />}</div>}
    {tab === "runner" && <div className="skill-manager-body"><div className="skill-callout neutral"><ShieldCheck size={16} />以下技能由 Runner 执行用户继承并已被 Codex 发现，仅用于核对实际环境，后台不能更改。</div>{relevantWorkers.length ? <div className="runner-skill-groups">{relevantWorkers.map((worker) => <WorkerUserSkills key={worker.executor_id} worker={worker} expanded />)}</div> : <SkillEmpty icon={<Server />} title="尚无可核对的 Runner" text="绑定默认执行器或完成聊天首次执行后，这里会显示用户级技能。" />}</div>}
  </SkillModal>;
}

function SkillRows({ items, onRuntime, onUpdate, onRemove, pending }: { items: SkillBindingView[]; onRuntime(item: SkillBindingView): void; onUpdate(item: SkillBindingView): void; onRemove(item: SkillBindingView): void; pending: boolean }) {
  if (!items.length) return <div className="skill-empty-row">尚未配置</div>;
  return <div className="managed-skill-list">{items.map((item) => <article key={item.id}><span className="managed-skill-icon"><Sparkles size={17} /></span><div><div className="managed-skill-title"><strong>{item.coordinate}</strong><span>{item.scope === "bot" ? "所有聊天" : item.chatName ?? "指定 Thread"}</span></div><p>{item.description}</p><small>固定版本 {item.version}{item.environmentCount || item.fileCount ? ` · ${item.environmentCount} 个变量 · ${item.fileCount} 个文件` : " · 尚未配置运行依赖"}</small>{item.declaredDependencies.length > 0 && <small>技能声明依赖：{item.declaredDependencies.map((dependency) => `${dependency.type} ${dependency.value}`).join(" · ")}</small>}</div><StatusPill status={item.syncStatus} /><div className="managed-skill-actions"><button onClick={() => onRuntime(item)}>配置依赖</button><button disabled={pending} onClick={() => onUpdate(item)}>检查升级</button><button className="text-danger" disabled={pending} aria-label={`移除 ${item.coordinate}`} onClick={() => onRemove(item)}><Trash2 size={14} /></button></div></article>)}</div>;
}

function normalizeEnvironment(payload: AnyRecord | undefined): RuntimeEnvironmentView[] {
  return records(payload?.environment ?? payload?.environmentVariables ?? payload?.environment_variables ?? payload?.env).map((item) => ({
    name: firstString(item.name, item.key) ?? "UNNAMED",
    mode: (["inherited", "replace", "disabled", "configured"].includes(item.mode) ? item.mode : item.inherited ? "inherited" : item.desiredState === "absent" || item.desired_state === "absent" ? "disabled" : "configured") as RuntimeEnvironmentView["mode"],
    sourceScope: (firstString(item.sourceScope, item.source_scope, item.scope) === "chat_context" ? "chat_context" : "bot") as RuntimeEnvironmentView["sourceScope"],
    updatedAt: firstString(item.updatedAt, item.updated_at)
  }));
}

function normalizeFiles(payload: AnyRecord | undefined): RuntimeFileView[] {
  return records(payload?.files ?? payload?.configFiles ?? payload?.config_files).map((item, index) => ({
    id: firstString(item.id, item.fileId, item.file_id) ?? `file-${index}`,
    targetPath: firstString(item.targetPath, item.target_path, item.path) ?? "未命名文件",
    mode: (["inherited", "replace", "disabled", "configured"].includes(item.mode) ? item.mode : item.inherited ? "inherited" : item.desiredState === "absent" || item.desired_state === "absent" ? "disabled" : "configured") as RuntimeFileView["mode"],
    sourceScope: (firstString(item.sourceScope, item.source_scope, item.scope) === "chat_context" ? "chat_context" : "bot") as RuntimeFileView["sourceScope"],
    status: firstString(item.status, item.syncStatus, item.sync_status, item.state) ?? "pending",
    revision: String(item.revision ?? item.desiredRevision ?? item.desired_revision ?? "—"),
    size: typeof item.size === "number" ? item.size : typeof item.sizeBytes === "number" ? item.sizeBytes : null,
    desiredSha: firstString(item.desiredSha256, item.desired_sha256, item.sha256),
    actualSha: firstString(item.actualSha256, item.actual_sha256),
    checkedAt: firstString(item.checkedAt, item.checked_at)
  }));
}

function withContext(path: string, chatContextId: string): string {
  return chatContextId ? `${path}?${new URLSearchParams({ chatContextId })}` : path;
}

export function RuntimeConfigPanel({ botId, binding, contexts, user }: { botId: string; binding: SkillBindingView; contexts: AnyRecord[]; user: AdminUser }) {
  const queryClient = useQueryClient();
  const fixedContextId = binding.scope === "chat_context" ? binding.chatContextId ?? "" : "";
  const [chatContextId, setChatContextId] = useState(fixedContextId);
  const [environmentName, setEnvironmentName] = useState("");
  const [environmentValue, setEnvironmentValue] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  useEffect(() => { setChatContextId(fixedContextId); setEnvironmentName(""); setEnvironmentValue(""); setTargetPath(""); setUploadFile(null); }, [binding.id, fixedContextId]);
  const base = `/v1/admin/bots/${botId}/skills/${encodeURIComponent(binding.id)}/runtime-config`;
  const config = useQuery({ queryKey: ["skill", "runtime-config", botId, binding.id, chatContextId], queryFn: () => api<AnyRecord>(withContext(base, chatContextId)), retry: false });
  const environments = normalizeEnvironment(config.data);
  const files = normalizeFiles(config.data);
  const runtimeWritable = config.data?.encryptionAvailable !== false;
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["skill"] }); };
  const envWrite = useMutation({
    mutationFn: ({ name, value, mode = "replace" }: { name: string; value?: string; mode?: "replace" | "disabled" }) => api(`${base}/env/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ ...(mode === "disabled" ? { mode } : {}), ...(value !== undefined ? { value } : {}), ...(chatContextId ? { chatContextId } : {}) }) }, user),
    onSuccess: () => { setEnvironmentName(""); setEnvironmentValue(""); refresh(); }
  });
  const envReset = useMutation({ mutationFn: (name: string) => api(`${base}/env/${encodeURIComponent(name)}`, { method: "DELETE", body: JSON.stringify({ ...(chatContextId ? { chatContextId, ...(binding.scope === "bot" ? { restoreInheritance: true } : {}) } : {}) }) }, user), onSuccess: refresh });
  const fileCreate = useMutation({
    mutationFn: ({ file, path }: { file: File; path: string }) => { const body = new FormData(); body.set("file", file); body.set("targetPath", path); if (chatContextId) body.set("chatContextId", chatContextId); return api(`${base}/files`, { method: "POST", body }, user); },
    onSuccess: () => { setTargetPath(""); setUploadFile(null); refresh(); }
  });
  const fileReplace = useMutation({
    mutationFn: ({ item, file }: { item: RuntimeFileView; file: File }) => { const body = new FormData(); body.set("file", file); body.set("targetPath", item.targetPath); if (chatContextId) body.set("chatContextId", chatContextId); return api(`${base}/files/${encodeURIComponent(item.id)}`, { method: "PUT", body }, user); },
    onSuccess: refresh
  });
  const fileReset = useMutation({ mutationFn: (item: RuntimeFileView) => api(`${base}/files/${encodeURIComponent(item.id)}`, { method: "DELETE", body: JSON.stringify({ ...(chatContextId ? { chatContextId, ...(binding.scope === "bot" ? { restoreInheritance: true } : {}) } : {}) }) }, user), onSuccess: refresh });
  const fileDisable = useMutation({ mutationFn: (item: RuntimeFileView) => api(`${base}/files/${encodeURIComponent(item.id)}`, { method: "DELETE", body: JSON.stringify({ chatContextId, restoreInheritance: false }) }, user), onSuccess: refresh });
  const forceApply = useMutation({ mutationFn: (item: RuntimeFileView) => api(`${base}/files/${encodeURIComponent(item.id)}/force-apply`, { method: "POST", body: JSON.stringify({ ...(chatContextId ? { chatContextId } : {}) }) }, user), onSuccess: refresh });
  const actionError = envWrite.error ?? envReset.error ?? fileCreate.error ?? fileReplace.error ?? fileReset.error ?? fileDisable.error ?? forceApply.error;
  const threadOverride = binding.scope === "bot" && Boolean(chatContextId);
  return <div className="runtime-config-panel">
    <header className="runtime-config-heading"><div><span className="managed-skill-icon"><Sparkles size={17} /></span><span><strong>{binding.coordinate}</strong><small>固定版本 {binding.version} · {binding.scope === "bot" ? "机器人全局技能" : "Thread 专属技能"}</small></span></div>{binding.scope === "bot" && <label>配置范围<select aria-label="运行依赖配置范围" value={chatContextId} onChange={(event) => setChatContextId(event.target.value)}><option value="">所有聊天默认值</option>{contexts.map((context) => <option key={context.id} value={context.id}>{contextTitle(context)} · Thread 覆盖</option>)}</select></label>}</header>
    {threadOverride && <div className="skill-callout neutral"><Layers3 size={16} />当前正在配置 Thread 覆盖。未覆盖的依赖继续继承机器人全局默认值。</div>}
    {config.isLoading ? <InlineLoading text="正在读取运行依赖…" /> : config.error ? <QueryError error={config.error} /> : <>
      {!runtimeWritable && <div className="skill-callout danger"><AlertTriangle size={16} />控制面尚未配置运行依赖加密密钥；现有名称和状态可查看，但暂不能写入新凭证或文件。</div>}
      <section className="runtime-config-section"><div className="skill-section-heading"><div><strong><KeyRound size={16} />环境变量</strong><small>值只在正式任务期间注入，后台不会回显。</small></div><span>{environments.length} 项</span></div>
        <div className="environment-add-form"><label><span>变量名</span><input aria-label="环境变量名" placeholder="例如 LARK_API_TOKEN" value={environmentName} onChange={(event) => setEnvironmentName(event.target.value.toUpperCase())} /></label><label><span>变量值</span><input aria-label="环境变量值" type="password" autoComplete="new-password" placeholder="写入后不可回读" value={environmentValue} onChange={(event) => setEnvironmentValue(event.target.value)} /></label><button className="primary-button" disabled={!runtimeWritable || !environmentName || !environmentValue || envWrite.isPending} onClick={() => envWrite.mutate({ name: environmentName, value: environmentValue })}>{envWrite.isPending ? "保存中…" : "保存变量"}</button></div>
        {environments.length ? <div className="runtime-env-list">{environments.map((item) => <div key={item.name}><span className="runtime-item-icon"><KeyRound size={15} /></span><span><strong>{item.name}</strong><small>{item.mode === "inherited" ? "继承全局默认值" : item.mode === "disabled" ? "此 Thread 不提供" : item.sourceScope === "chat_context" ? "Thread 覆盖 · 已设置" : "所有聊天 · 已设置"}{item.updatedAt ? ` · ${relativeTime(item.updatedAt)}更新` : ""}</small></span><span className="secret-set-label"><LockKeyhole size={12} />{item.mode === "disabled" ? "已停用" : "已配置"}</span><div><button className="ghost-button" onClick={() => { setEnvironmentName(item.name); setEnvironmentValue(""); }}>更新</button>{threadOverride && item.mode === "inherited" && <button className="ghost-button" onClick={() => envWrite.mutate({ name: item.name, mode: "disabled" })}>此聊天不提供</button>}{threadOverride && ["replace", "disabled"].includes(item.mode) ? <button className="ghost-button" onClick={() => envReset.mutate(item.name)}>恢复继承</button> : !threadOverride && <button className="ghost-button text-danger" onClick={() => envReset.mutate(item.name)}>删除</button>}</div></div>)}</div> : <div className="skill-empty-row">尚未配置环境变量</div>}
      </section>
      <section className="runtime-config-section"><div className="skill-section-heading"><div><strong><FileClock size={16} />工作区配置文件</strong><small>明文文件持续保留；后台跟踪修订、实际摘要和漂移。</small></div><span>{files.length} 个</span></div>
        <div className="config-file-upload"><label><span>工作区相对路径</span><input aria-label="工作区相对路径" placeholder="例如 .env 或 config/service.json" value={targetPath} onChange={(event) => setTargetPath(event.target.value)} /></label><label className="file-picker"><span>本地文本文件</span><input aria-label="选择配置文件" type="file" accept="text/*,.env,.json,.yaml,.yml,.toml,.pem,.conf,.ini" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /><small>{uploadFile?.name ?? "尚未选择文件"}</small></label><button className="primary-button" disabled={!runtimeWritable || !targetPath.trim() || !uploadFile || fileCreate.isPending} onClick={() => uploadFile && fileCreate.mutate({ file: uploadFile, path: targetPath.trim() })}><Upload size={15} />{fileCreate.isPending ? "上传中…" : "上传并跟踪"}</button></div>
        {files.length ? <div className="runtime-file-list">{files.map((item) => <article key={item.id} className={`status-${statusTone(item.status)}`}><div className="runtime-file-main"><span className="runtime-item-icon"><FileClock size={16} /></span><span><strong>{item.targetPath}</strong><small>revision {item.revision} · {formatSize(item.size)} · 期望 {shortDigest(item.desiredSha)}</small></span><StatusPill status={item.status} /></div><dl><div><dt>工作区实际摘要</dt><dd>{shortDigest(item.actualSha)}</dd></div><div><dt>最后检查</dt><dd>{item.checkedAt ? relativeTime(item.checkedAt) : "尚未检查"}</dd></div><div><dt>来源</dt><dd>{item.mode === "inherited" ? "继承全局" : item.mode === "disabled" ? "此 Thread 不提供" : item.sourceScope === "chat_context" ? "Thread 覆盖" : "所有聊天"}</dd></div></dl><div className="runtime-file-actions">{["drift", "conflict"].includes(item.status) && !chatContextId && <span className="runtime-file-action-hint">选择异常 Thread 后处理</span>}<label className="secondary-button">上传新版本<input className="visually-hidden" aria-label={`上传 ${item.targetPath} 的新版本`} type="file" accept="text/*,.env,.json,.yaml,.yml,.toml,.pem,.conf,.ini" onChange={(event) => { const file = event.target.files?.[0]; if (file) fileReplace.mutate({ item, file }); event.currentTarget.value = ""; }} /></label>{["drift", "conflict"].includes(item.status) && Boolean(chatContextId) && <button className="secondary-button" onClick={() => forceApply.mutate(item)}>覆盖工作区版本</button>}{threadOverride && item.mode === "inherited" && <button className="ghost-button" onClick={() => fileDisable.mutate(item)}>此聊天不提供</button>}{threadOverride && ["replace", "disabled"].includes(item.mode) ? <button className="ghost-button" onClick={() => fileReset.mutate(item)}>恢复继承</button> : !threadOverride && <button className="danger-button" onClick={() => window.confirm(`确认删除工作区文件 ${item.targetPath}？文件会在 Runner 空闲时清理。`) && fileReset.mutate(item)}>删除文件</button>}</div></article>)}</div> : <div className="skill-empty-row">尚未上传工作区配置文件</div>}
      </section>
    </>}
    {actionError && <QueryError error={actionError} />}
  </div>;
}

export function WorkerUserSkills({ worker, expanded = false }: { worker: AnyRecord; expanded?: boolean }) {
  const id = firstString(worker.executor_id, worker.executorId) ?? "";
  const skills = useQuery({ queryKey: ["worker", "user-skills", id], queryFn: () => api<AnyRecord>(`/v1/admin/workers/${encodeURIComponent(id)}/user-skills`), enabled: Boolean(id), retry: false });
  const items = userSkillRecords(skills.data);
  const state = scanState(skills.data);
  const scannedAt = firstString(skills.data?.scannedAt, skills.data?.scanned_at, skills.data?.userSkillsScannedAt, worker.user_skills_scanned_at);
  const truncated = Boolean(skills.data?.truncated);
  return <details className="worker-user-skills" open={expanded}><summary><span className="managed-skill-icon"><ShieldCheck size={17} /></span><span><strong>用户级技能 · {items.length}{truncated ? "+" : ""}</strong><small>{worker.display_name ?? worker.displayName ?? id} · {scannedAt ? `${relativeTime(scannedAt)}扫描` : "尚未扫描"}</small></span><StatusPill status={state} label={state === "ready" || state === "success" ? "已确认生效" : undefined} /><ChevronDown size={16} /></summary><div className="worker-user-skill-body"><div className="readonly-banner"><LockKeyhole size={14} />只读 · 来自 Runner 执行用户，后台不能安装、更新或删除</div>{skills.isLoading ? <InlineLoading /> : skills.error ? <QueryError error={skills.error} /> : items.length ? <div className="readonly-skill-list">{items.map((item, index) => { const skillhub = item.skillhub ?? {}; const coordinate = firstString(item.coordinate, skillhub.coordinate); const version = firstString(item.version, skillhub.version); return <div key={firstString(item.path, item.relativePath, item.name) ?? index}><span><strong>{firstString(item.displayName, item.display_name, item.name) ?? "未命名技能"}</strong><small>{coordinate || version ? [coordinate, version].filter(Boolean).join(" · ") : firstString(item.shortDescription, item.short_description, item.description) ?? "用户级技能"}</small></span><code>{firstString(item.relativePath, item.relative_path, item.path) ?? "~/.agents/skills"}</code></div>; })}</div> : <div className="skill-empty-row">当前没有被 Codex 确认启用的用户级技能</div>}{truncated && <div className="skill-callout warning"><AlertTriangle size={15} />技能数量超过上报上限，当前列表不完整。</div>}{(Boolean(skills.data?.scanError ?? skills.data?.error) || (Array.isArray(skills.data?.errors) && skills.data.errors.length > 0)) && <div className="skill-callout warning"><AlertTriangle size={15} />扫描失败，正在展示上一次成功快照。</div>}</div></details>;
}

export function ChatSkillOverview({ botId, context, user }: { botId: string; context: AnyRecord; user: AdminUser }) {
  const queryClient = useQueryClient();
  const contextId = firstString(context.id) ?? "";
  const executorId = firstString(context.executorId, context.executor_id);
  const skills = useQuery({ queryKey: ["skill", "chat-context", contextId], queryFn: () => api<AnyRecord>(`/v1/admin/bots/${botId}/skills?${new URLSearchParams({ chatContextId: contextId })}`), enabled: Boolean(contextId), retry: false });
  const userSkills = useQuery({ queryKey: ["worker", "user-skills", executorId], queryFn: () => api<AnyRecord>(`/v1/admin/workers/${encodeURIComponent(executorId ?? "")}/user-skills`), enabled: Boolean(executorId), retry: false });
  const effective = effectiveSkillRecords(skills.data, contextId);
  const inherited = effective.filter((item) => item.scope === "bot").length;
  const local = effective.length - inherited;
  const runtimeFiles = records(skills.data?.runtimeFiles ?? skills.data?.runtime_files);
  const runtimeFileCount = runtimeFiles.length || effective.reduce((total, item) => total + item.fileCount, 0);
  const desiredFingerprint = firstString(skills.data?.skillSetFingerprint, skills.data?.skill_set_fingerprint, context.desiredSkillSetFingerprint, context.desired_skill_set_fingerprint, context.skillSetFingerprint, context.skill_set_fingerprint);
  const appliedFingerprint = firstString(skills.data?.appliedSkillSetFingerprint, skills.data?.applied_skill_set_fingerprint, context.appliedSkillSetFingerprint, context.applied_skill_set_fingerprint);
  const syncError = firstString(skills.data?.skillsSyncError, skills.data?.skills_sync_error, context.skillsSyncError, context.skills_sync_error);
  const matched = Boolean(desiredFingerprint && appliedFingerprint && desiredFingerprint === appliedFingerprint);
  const retrySync = useMutation({
    mutationFn: () => api(`/v1/admin/chat-contexts/${contextId}/skill-runtime/retry`, { method: "POST", body: "{}" }, user),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["skill"] }); void queryClient.invalidateQueries({ queryKey: ["chat-context", contextId] }); }
  });
  return <details className="chat-skill-overview"><summary><Sparkles size={17} /><span><strong>技能与运行依赖 · {effective.length} 个受控技能</strong><small>{inherited} 个全局继承 · {local} 个 Thread 专属 · {userSkillRecords(userSkills.data).length} 个 Runner 用户级技能</small></span><StatusPill status={syncError ? "failed" : matched ? "applied" : desiredFingerprint ? "pending" : "unknown"} label={syncError ? "同步失败" : matched ? "已应用" : desiredFingerprint ? "下次消息同步" : "尚未配置"} /><ChevronDown size={16} /></summary><div className="chat-skill-body">{skills.isLoading ? <InlineLoading /> : skills.error ? <QueryError error={skills.error} /> : <><div className="effective-skill-list">{effective.map((item) => <div key={item.coordinate}><span className="managed-skill-icon"><Sparkles size={14} /></span><span><strong>{item.coordinate}</strong><small>固定版本 {item.version}</small></span><span>{item.scope === "bot" ? "全局继承" : "Thread 专属"}</span></div>)}{!effective.length && <div className="skill-empty-row">此聊天尚未配置受控 SkillHub 技能</div>}</div><dl className="skill-fingerprint-row"><div><dt>期望技能指纹</dt><dd>{shortDigest(desiredFingerprint)}</dd></div><div><dt>已应用指纹</dt><dd>{shortDigest(appliedFingerprint)}</dd></div><div><dt>工作区配置文件</dt><dd>{runtimeFileCount} 个已配置项</dd></div></dl></>}{syncError && <div className="skill-callout danger skill-sync-retry" role="alert"><AlertTriangle size={16} /><span><strong>工作区技能同步失败</strong><small>{syncError}</small></span><button className="secondary-button" disabled={!executorId || retrySync.isPending} onClick={() => retrySync.mutate()}><RefreshCw className={retrySync.isPending ? "spin" : ""} size={14} />{retrySync.isPending ? "正在重新同步…" : "重新同步"}</button></div>}{retrySync.error && <QueryError error={retrySync.error} />}{executorId && <div className="chat-runner-skill-summary"><ShieldCheck size={15} /><span><strong>Runner 用户级技能</strong><small>{userSkills.isLoading ? "正在核对…" : userSkills.error ? "暂时无法读取" : `${userSkillRecords(userSkills.data).length} 个已确认启用 · 只读`}</small></span></div>}</div></details>;
}

function snapshotSkills(data: AnyRecord): AnyRecord[] {
  const snapshot = data.skillSetSnapshot ?? data.skill_set_snapshot ?? data.skillsSnapshot ?? data.skills_snapshot ?? data.skills;
  if (Array.isArray(snapshot)) return records(snapshot);
  return records(snapshot?.items ?? snapshot?.skills);
}

export function TaskSkillSnapshot({ task }: { task: AnyRecord }) {
  const controlled = snapshotSkills(task);
  const userSnapshot = task.userSkillSnapshot ?? task.user_skill_snapshot ?? task.userSkillsSnapshot ?? task.user_skills_snapshot;
  const userSkills = Array.isArray(userSnapshot) ? records(userSnapshot) : records(userSnapshot?.items ?? userSnapshot?.skills);
  const runtime = task.runtimeConfigSnapshot ?? task.runtime_config_snapshot ?? {};
  const environmentNames = records(runtime.environment ?? runtime.environmentVariables ?? runtime.environment_variables ?? runtime.env).map((item) => firstString(item.name, item.key)).filter((value): value is string => Boolean(value));
  const files = records(runtime.files ?? runtime.configFiles ?? runtime.config_files);
  const fingerprint = firstString(task.skillSetFingerprint, task.skill_set_fingerprint, runtime.skillSetFingerprint);
  return <section className="task-skill-snapshot"><div className="skill-section-heading"><div><strong><Sparkles size={16} />技能与依赖快照</strong><small>记录任务实际使用的固定版本；不显示任何凭证值或文件正文。</small></div><span>{controlled.length} 个受控 · {userSkills.length} 个用户级</span></div><div className="task-skill-columns"><div><h4>受控 SkillHub 技能</h4>{controlled.length ? controlled.map((item, index) => <div className="snapshot-skill-row" key={firstString(item.packageId, item.package_id, item.coordinate) ?? index}><span><strong>{firstString(item.coordinate, item.name) ?? "未命名技能"}</strong><small>{firstString(item.sourceScope, item.source_scope, item.scope) === "chat_context" ? "Thread 专属" : "机器人全局"}</small></span><code>{firstString(item.version) ?? "—"}</code></div>) : <p>未配置受控技能</p>}</div><div><h4>Runner 用户级技能</h4>{userSkills.length ? userSkills.map((item, index) => <div className="snapshot-skill-row" key={firstString(item.path, item.relativePath, item.name) ?? index}><span><strong>{firstString(item.displayName, item.display_name, item.name) ?? "未命名技能"}</strong><small>执行时只读快照</small></span><code>{firstString(item.version, item.skillhub?.version) ?? "启用"}</code></div>) : <p>执行时未记录用户级技能</p>}</div></div><dl className="task-runtime-summary"><div><dt>技能集合指纹</dt><dd>{shortDigest(fingerprint)}</dd></div><div><dt>已注入变量名</dt><dd>{environmentNames.length ? environmentNames.join("、") : "无"}</dd></div><div><dt>工作区文件</dt><dd>{files.length ? files.map((item) => firstString(item.targetPath, item.target_path, item.path)).filter(Boolean).join("、") : "无"}</dd></div></dl></section>;
}

function SkillEmpty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="skill-empty"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>;
}
