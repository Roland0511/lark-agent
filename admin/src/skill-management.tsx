import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileClock, Folder, Globe2, KeyRound, Layers3,
  LockKeyhole, MessageSquare, MessagesSquare, MoreHorizontal, Plus, RefreshCw, Search, Server, ShieldCheck, Sparkles, Trash2, Upload, UserRound, X
} from "lucide-react";
import { api, relativeTime, type AdminUser } from "./api";
import { chatDisplayName, chatDisplayNames } from "./chat-display-name";

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
  chatDisplayName?: string | null;
  peerOpenId?: string | null;
  peerDisplayName?: string | null;
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
  offline: "执行环境离线",
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
      chatDisplayName: firstString(item.chatDisplayName, item.chat_display_name),
      peerOpenId: firstString(item.peerOpenId, item.peer_open_id),
      peerDisplayName: firstString(item.peerDisplayName, item.peer_display_name),
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
  return chatDisplayName(context);
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

function SkillModal({ title, registryAvailable, onClose, children }: { title: string; registryAvailable: boolean; onClose(): void; children: ReactNode }) {
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
  return <div className="modal-backdrop" onClick={onClose}><div ref={dialog} className="modal skill-manager-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}><header className="modal-head skill-manager-head"><div><h2>{title}</h2><span className={`skillhub-health ${registryAvailable ? "ready" : "blocked"}`}>{registryAvailable ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{registryAvailable ? "SkillHub 正常" : "SkillHub 不可用"}</span></div><button className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><X /></button></header>{children}</div></div>;
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
      <span><strong id={`bot-skills-${bot.id}`}>技能与运行依赖</strong><small>{skills.error && !skills.data ? "技能服务暂不可用" : items.length ? "机器人配置与聊天配置按作用范围生效" : "尚未配置 SkillHub 技能"}</small></span>
      <span className="bot-skill-stats" aria-label="技能配置摘要"><span><b>{globalCount}</b><small>机器人配置</small></span><span><b>{threadCount}</b><small>聊天配置</small></span>{problemCount > 0 && <span className="danger"><b>{problemCount}</b><small>异常</small></span>}</span>
      <button className="secondary-button" onClick={() => setOpen(true)}>管理技能</button>
    </section>
    {open && <SkillManagerDialog bot={bot} workers={workers} user={user} onClose={() => setOpen(false)} />}
  </>;
}

type SkillManagerView =
  | { kind: "overview" }
  | { kind: "runner" }
  | { kind: "bot" }
  | { kind: "contexts" }
  | { kind: "context"; contextId: string }
  | { kind: "runtime" };

type ManagerSkillEntry = {
  key: string;
  coordinate: string;
  version: string;
  description: string;
  source: "runner" | "bot" | "chat";
  sourceLabel: string;
  status: string;
  environmentCount: number;
  fileCount: number;
  updatedAt: string | null;
  binding?: SkillBindingView;
  workerId?: string;
  workerName?: string;
  path?: string;
};

function sourceLabel(source: ManagerSkillEntry["source"]): string {
  if (source === "runner") return "环境继承 · 所有聊天";
  if (source === "bot") return "机器人配置 · 所有聊天";
  return "聊天配置 · 当前聊天";
}

function managerEntryFromBinding(item: SkillBindingView): ManagerSkillEntry {
  const source = item.scope === "bot" ? "bot" : "chat";
  return {
    key: `binding:${item.id}`,
    coordinate: item.coordinate,
    version: item.version,
    description: item.description,
    source,
    sourceLabel: sourceLabel(source),
    status: item.syncStatus,
    environmentCount: item.environmentCount,
    fileCount: item.fileCount,
    updatedAt: item.updatedAt,
    binding: item
  };
}

function ManagerSkillIcon({ source }: { source: ManagerSkillEntry["source"] }) {
  if (source === "runner") return <Server size={17} />;
  if (source === "bot") return <Globe2 size={17} />;
  return <MessageSquare size={17} />;
}

export function SkillManagerDialog({ bot, workers, user, onClose }: { bot: AnyRecord; workers: AnyRecord[]; user: AdminUser; onClose(): void }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<SkillManagerView>({ kind: "overview" });
  const [selectedSkill, setSelectedSkill] = useState<ManagerSkillEntry | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [coordinate, setCoordinate] = useState("");
  const [scope, setScope] = useState<"bot" | "chat_context">("bot");
  const [chatContextId, setChatContextId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [listSearch, setListSearch] = useState("");
  const [page, setPage] = useState(1);
  const [runtimeBindingId, setRuntimeBindingId] = useState<string | null>(null);
  const status = useQuery({ queryKey: ["skill", "skillhub-status"], queryFn: () => api<AnyRecord>("/v1/admin/skillhub/status"), retry: false });
  const skills = useQuery({ queryKey: ["skill", "bot", bot.id], queryFn: () => api<AnyRecord>(`/v1/admin/bots/${bot.id}/skills`), retry: false });
  const contexts = useQuery({ queryKey: ["chat-context", "skills", bot.id], queryFn: () => api<AnyRecord>(`/v1/admin/chat-contexts?${new URLSearchParams({ bot: bot.id, limit: "100" })}`) });
  const search = useQuery({ queryKey: ["skill", "search", searchQuery], queryFn: () => api<AnyRecord>(`/v1/admin/skillhub/search?${new URLSearchParams({ q: searchQuery })}`), enabled: addOpen && Boolean(searchQuery), retry: false });
  const items = normalizeSkillBindings(skills.data);
  const selectedBinding = items.find((item) => item.id === runtimeBindingId) ?? null;
  const contextItems = contextsFrom(contexts.data);
  const contextTitles = chatDisplayNames(contextItems);
  const titledContext = (context: AnyRecord): string => contextTitles.get(firstString(context.id) ?? "") ?? contextTitle(context);
  const bindingContextTitle = (binding: SkillBindingView): string => {
    const context = contextItems.find((item) => firstString(item.id) === binding.chatContextId);
    return context ? titledContext(context) : binding.chatDisplayName ?? chatDisplayName(binding as unknown as AnyRecord);
  };
  const runnerIds = [...new Set([firstString(bot.defaultExecutorId, bot.default_executor_id), ...contextItems.map((item) => firstString(item.executorId, item.executor_id))].filter((value): value is string => Boolean(value)))];
  const relevantWorkers = runnerIds.length ? workers.filter((worker) => runnerIds.includes(firstString(worker.executor_id, worker.executorId, worker.id) ?? "")) : workers;
  const runnerQueries = useQueries({
    queries: relevantWorkers.map((worker) => {
      const id = firstString(worker.executor_id, worker.executorId, worker.id) ?? "";
      return { queryKey: ["worker", "user-skills", id], queryFn: () => api<AnyRecord>(`/v1/admin/workers/${encodeURIComponent(id)}/user-skills`), enabled: Boolean(id), retry: false };
    })
  });
  const runnerEntries = useMemo(() => relevantWorkers.flatMap((worker, workerIndex) => {
    const payload = runnerQueries[workerIndex]?.data;
    const workerId = firstString(worker.executor_id, worker.executorId, worker.id) ?? `worker-${workerIndex}`;
    const workerName = firstString(worker.display_name, worker.displayName, worker.reported_display_name, worker.reportedDisplayName) ?? workerId;
    const statusValue = scanState(payload);
    return userSkillRecords(payload).map((item, index): ManagerSkillEntry => {
      const skillhub = item.skillhub ?? {};
      const path = firstString(item.relativePath, item.relative_path, item.path);
      const coordinateValue = firstString(item.coordinate, skillhub.coordinate, item.displayName, item.display_name, item.name) ?? `环境技能-${index + 1}`;
      return {
        key: `runner:${workerId}:${path ?? coordinateValue}:${index}`,
        coordinate: coordinateValue,
        version: firstString(item.version, skillhub.version) ?? "本地",
        description: firstString(item.shortDescription, item.short_description, item.description) ?? "由执行环境提供的技能",
        source: "runner",
        sourceLabel: sourceLabel("runner"),
        status: ["ready", "success", "ok"].includes(statusValue) ? statusValue : payload && !runnerQueries[workerIndex]?.error ? "ready" : statusValue,
        environmentCount: 0,
        fileCount: 0,
        updatedAt: firstString(payload?.scannedAt, payload?.scanned_at),
        workerId,
        workerName,
        path: path ?? "~/.agents/skills"
      };
    });
  }), [relevantWorkers, runnerQueries]);
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["skill"] }); };
  const add = useMutation({
    mutationFn: () => api(`/v1/admin/bots/${bot.id}/skills`, { method: "POST", body: JSON.stringify({ coordinate: coordinate.trim(), scope, ...(scope === "chat_context" ? { chatContextId } : {}) }) }, user),
    onSuccess: () => { setCoordinate(""); setSearchTerm(""); setSearchQuery(""); setAddOpen(false); refresh(); }
  });
  const update = useMutation({ mutationFn: (binding: SkillBindingView) => api(`/v1/admin/bots/${bot.id}/skills/${encodeURIComponent(binding.id)}/update`, { method: "POST", body: "{}" }, user), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (binding: SkillBindingView) => api(`/v1/admin/bots/${bot.id}/skills/${encodeURIComponent(binding.id)}`, { method: "DELETE" }, user), onSuccess: () => { setSelectedSkill(null); refresh(); } });
  const registryAvailable = status.data ? status.data.available !== false && status.data.configured !== false && status.data.authenticated !== false : !status.error;
  const openView = (next: SkillManagerView) => { setView(next); setSelectedSkill(null); setAddOpen(false); setListSearch(""); setPage(1); };
  const openAdd = (nextScope: "bot" | "chat_context", nextContextId = "") => { setScope(nextScope); setChatContextId(nextContextId); setCoordinate(""); setSearchTerm(""); setSearchQuery(""); setSelectedSkill(null); setAddOpen(true); };
  const pickRuntime = (binding: SkillBindingView) => { setRuntimeBindingId(binding.id); setView({ kind: "runtime" }); setSelectedSkill(null); setAddOpen(false); };
  const globalItems = items.filter((item) => item.scope === "bot");
  const localItems = items.filter((item) => item.scope === "chat_context");
  const configuredContextCount = new Set(localItems.map((item) => item.chatContextId).filter(Boolean)).size;
  const selectedContext = view.kind === "context" ? contextItems.find((item) => firstString(item.id) === view.contextId) ?? null : null;
  const selectedContextId = selectedContext ? firstString(selectedContext.id) ?? "" : "";
  const selectedExecutorId = selectedContext ? firstString(selectedContext.executorId, selectedContext.executor_id) ?? firstString(bot.defaultExecutorId, bot.default_executor_id) : null;
  const selectedRunnerEntries = selectedExecutorId ? runnerEntries.filter((entry) => entry.workerId === selectedExecutorId) : relevantWorkers.length === 1 ? runnerEntries : [];
  const controlledContextEntries = selectedContextId ? effectiveSkillRecords({ items }, selectedContextId).map(managerEntryFromBinding) : [];
  const listEntries = view.kind === "runner"
    ? runnerEntries
    : view.kind === "bot"
      ? globalItems.map(managerEntryFromBinding)
      : view.kind === "context"
        ? [...selectedRunnerEntries, ...controlledContextEntries]
        : [];
  const filteredEntries = listEntries.filter((entry) => !listSearch.trim() || `${entry.coordinate} ${entry.sourceLabel}`.toLowerCase().includes(listSearch.trim().toLowerCase()));
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / pageSize));
  const visibleEntries = filteredEntries.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize);
  const hasProblems = items.some((item) => ["failed", "error", "drift", "conflict"].includes(item.syncStatus)) || runnerQueries.some((query) => query.error);
  const viewTitle = view.kind === "overview" ? "所有对话" : view.kind === "runner" ? "环境继承" : view.kind === "bot" ? "机器人配置" : view.kind === "contexts" ? "聊天" : view.kind === "context" ? titledContext(selectedContext ?? {}) : "运行依赖";
  const viewSubtitle = view.kind === "overview" ? "共享给此机器人的全部聊天" : view.kind === "runner" ? "由执行环境提供，所有聊天可用" : view.kind === "bot" ? "由后台配置，所有聊天可用" : view.kind === "contexts" ? `${contextItems.length} 个聊天工作区` : view.kind === "context" ? `${listEntries.length} 个技能` : "为技能配置环境变量与工作区文件";
  const canAdd = view.kind === "overview" || view.kind === "bot" || view.kind === "context";
  const addScope = view.kind === "context" ? "chat_context" : "bot";
  const addContextId = view.kind === "context" ? view.contextId : "";
  return <SkillModal title={`${bot.displayName} · 技能管理`} registryAvailable={registryAvailable} onClose={onClose}>
    <div className={`skill-manager-shell ${selectedSkill ? "has-drawer" : ""}`}>
      <aside className="skill-scope-rail" aria-label="技能作用域">
        <div className="skill-scope-main">
          <h3>作用域</h3>
          <button className={["overview", "runner", "bot"].includes(view.kind) ? "active" : ""} onClick={() => openView({ kind: "overview" })}><Folder size={17} /><span>所有对话</span></button>
          <button className={["contexts", "context"].includes(view.kind) ? "parent-active" : ""} onClick={() => openView({ kind: "contexts" })}><ChevronDown size={14} /><Folder size={17} /><span>聊天</span></button>
          <div className="skill-context-tree">{contextItems.map((context) => {
            const id = firstString(context.id) ?? "";
            const isGroup = firstString(context.chatType, context.chat_type) === "group";
            return <button key={id} className={view.kind === "context" && view.contextId === id ? "active" : ""} onClick={() => openView({ kind: "context", contextId: id })}>{isGroup ? <MessagesSquare size={16} /> : <UserRound size={16} />}<span>{titledContext(context)}</span></button>;
          })}</div>
        </div>
        <button className={`skill-runtime-link ${view.kind === "runtime" ? "active" : ""}`} onClick={() => openView({ kind: "runtime" })}><KeyRound size={16} /><span>运行依赖</span></button>
      </aside>
      <main className="skill-manager-workspace">
        <header className="skill-workspace-head">
          <div>{view.kind === "context" && <small>聊天 / {viewTitle}</small>}<h3>{viewTitle}{view.kind === "context" && <span>{listEntries.length} 个技能</span>}</h3>{view.kind !== "context" && <p>{viewSubtitle}</p>}</div>
          <div>{!addOpen && canAdd && <button className="primary-button" disabled={!registryAvailable} onClick={() => openAdd(addScope, addContextId)}><Plus size={16} />{view.kind === "overview" || view.kind === "bot" ? "添加全局技能" : "添加技能"}</button>}<button className="icon-button" aria-label="更多操作"><MoreHorizontal size={18} /></button></div>
        </header>
        {addOpen && <section className="skill-manager-add-panel" aria-label="添加 SkillHub 技能">
          <div className="skill-add-panel-head"><div><strong>添加 SkillHub 技能</strong><small>添加时固定当前版本；环境继承技能不会被替换。</small></div><button className="icon-button" aria-label="关闭添加技能" onClick={() => setAddOpen(false)}><X size={17} /></button></div>
          <div className="skill-add-form"><label><span>技能名称</span><div className="skill-coordinate-input"><Search size={16} /><input aria-label="技能名称" placeholder="例如 @sh01/git-commit" value={coordinate} onChange={(event) => setCoordinate(event.target.value)} /></div></label><label><span>配置范围</span><select aria-label="配置范围" value={scope} onChange={(event) => setScope(event.target.value as "bot" | "chat_context")}><option value="bot">机器人配置 · 所有聊天</option><option value="chat_context">聊天配置 · 当前聊天</option></select></label>{scope === "chat_context" && <label><span>聊天</span><select aria-label="聊天" value={chatContextId} onChange={(event) => setChatContextId(event.target.value)}><option value="">请选择聊天</option>{contextItems.map((context) => <option key={context.id} value={context.id}>{titledContext(context)}</option>)}</select></label>}<button className="primary-button" disabled={!registryAvailable || !coordinate.trim() || (scope === "chat_context" && !chatContextId) || add.isPending} onClick={() => add.mutate()}><Plus size={15} />{add.isPending ? "正在固定版本…" : "添加技能"}</button></div>
          <div className="skill-search-row"><input aria-label="搜索 SkillHub" placeholder="不确定名称？搜索 SkillHub" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setSearchQuery(searchTerm.trim()); }} /><button className="ghost-button" disabled={!searchTerm.trim()} onClick={() => setSearchQuery(searchTerm.trim())}>查找</button></div>
          {search.isFetching && <InlineLoading text="正在搜索 SkillHub…" />}{search.error && <QueryError error={search.error} />}{search.data && <div className="skill-search-results">{records(search.data.items ?? search.data.results).length ? records(search.data.items ?? search.data.results).map((result, index) => { const resultCoordinate = firstString(result.coordinate) ?? (result.namespace && result.slug ? `@${result.namespace}/${result.slug}` : ""); return <button key={resultCoordinate || index} onClick={() => setCoordinate(resultCoordinate)}><span><strong>{resultCoordinate}</strong><small>{firstString(result.description) ?? "暂无技能说明"}</small></span><span>选择</span></button>; }) : <small>没有匹配的技能。</small>}</div>}{add.error && <QueryError error={add.error} />}
        </section>}
        {!addOpen && view.kind === "overview" && <div className="skill-overview-content">
          <section><h4>共享技能来源</h4><div className="skill-scope-list"><button onClick={() => openView({ kind: "runner" })}><span className="scope-row-icon"><Server size={18} /></span><strong>环境继承</strong><b>{runnerEntries.length}</b><span><LockKeyhole size={14} />只读</span><StatusPill status={runnerQueries.some((query) => query.error) ? "error" : "ready"} label={runnerQueries.some((query) => query.error) ? "需检查" : "已生效"} /><ChevronRight size={17} /></button><button onClick={() => openView({ kind: "bot" })}><span className="scope-row-icon"><Globe2 size={18} /></span><strong>机器人配置</strong><b>{globalItems.length}</b><span>可配置</span><StatusPill status={globalItems.some((item) => ["failed", "error"].includes(item.syncStatus)) ? "error" : "ready"} label={globalItems.some((item) => ["failed", "error"].includes(item.syncStatus)) ? "需检查" : "已生效"} /><ChevronRight size={17} /></button></div></section>
          <section><h4>聊天工作区</h4><button className="skill-context-overview-row" onClick={() => openView({ kind: "contexts" })}><span className="scope-row-icon"><MessageSquare size={18} /></span><strong>聊天</strong><b>{contextItems.length}</b><span>{configuredContextCount} 个有本地配置</span><ChevronRight size={17} /></button></section>
          <section className="skill-attention"><h4>需要关注</h4>{hasProblems ? <button onClick={() => openView({ kind: "bot" })}><AlertTriangle size={16} /><span>发现需要处理的技能状态</span><ChevronRight size={16} /></button> : <p><CheckCircle2 size={16} />暂无需要处理的问题</p>}</section>
        </div>}
        {!addOpen && view.kind === "contexts" && <div className="skill-context-list">{contextItems.length ? contextItems.map((context) => { const id = firstString(context.id) ?? ""; const localCount = localItems.filter((item) => item.chatContextId === id).length; const isGroup = firstString(context.chatType, context.chat_type) === "group"; return <button key={id} onClick={() => openView({ kind: "context", contextId: id })}>{isGroup ? <MessagesSquare size={18} /> : <UserRound size={18} />}<span><strong>{titledContext(context)}</strong><small>{localCount ? `${localCount} 个聊天配置` : "无聊天配置"}</small></span><ChevronRight size={17} /></button>; }) : <SkillEmpty icon={<MessageSquare />} title="暂无聊天" text="完成首次聊天后，这里会显示对应的技能工作区。" />}</div>}
        {!addOpen && ["runner", "bot", "context"].includes(view.kind) && <div className="skill-list-view">
          <div className="skill-list-toolbar"><div className="skill-list-search"><Search size={16} /><input aria-label="搜索技能" placeholder="搜索技能" value={listSearch} onChange={(event) => { setListSearch(event.target.value); setPage(1); }} /></div></div>
          <div className="skill-manager-table" role="table" aria-label={`${viewTitle}技能列表`}><div className="skill-manager-table-head" role="row"><span>技能</span><span>来源与范围</span><span>状态</span><span /></div>{skills.isLoading || runnerQueries.some((query) => query.isLoading) ? <InlineLoading /> : visibleEntries.length ? visibleEntries.map((entry) => <button type="button" role="row" key={entry.key} className={selectedSkill?.key === entry.key ? "selected" : ""} onClick={() => setSelectedSkill(entry)}><span><span className="skill-row-icon"><ManagerSkillIcon source={entry.source} /></span><strong>{entry.coordinate}</strong></span><span>{entry.sourceLabel}</span><StatusPill status={entry.status} label={statusTone(entry.status) === "success" ? "已生效" : undefined} /><ChevronRight size={17} /></button>) : <div className="skill-empty-row">没有匹配的技能</div>}</div>
          <footer className="skill-list-footer"><span>共 {filteredEntries.length} 项</span><div><button disabled={page <= 1} aria-label="上一页" onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronRight className="flip" size={16} /></button><span>{Math.min(page, pageCount)} / {pageCount}</span><button disabled={page >= pageCount} aria-label="下一页" onClick={() => setPage((current) => Math.min(pageCount, current + 1))}><ChevronRight size={16} /></button></div></footer>
        </div>}
        {!addOpen && view.kind === "runtime" && <div className="skill-runtime-workspace">{items.length ? <><div className="runtime-binding-picker"><label>配置哪个技能<select aria-label="配置哪个技能" value={runtimeBindingId ?? ""} onChange={(event) => setRuntimeBindingId(event.target.value || null)}><option value="">请选择技能</option>{items.map((item) => <option key={item.id} value={item.id}>{item.coordinate} · {item.scope === "bot" ? "机器人配置 · 所有聊天" : `聊天配置 · ${bindingContextTitle(item)}`}</option>)}</select></label><div className="skill-callout neutral"><LockKeyhole size={16} />敏感值写入后不可回读。聊天范围不是同一执行环境内的系统级隔离；高敏凭证请使用独立执行环境。</div></div>{selectedBinding ? <RuntimeConfigPanel botId={bot.id} binding={selectedBinding} contexts={contextItems} user={user} /> : <SkillEmpty icon={<KeyRound />} title="选择一个技能" text="选择技能后，可配置环境变量和持续保留在工作区的文本文件。" />}</> : <SkillEmpty icon={<Sparkles />} title="还没有可配置的技能" text="先添加一个 SkillHub 技能，再为它准备运行依赖。" />}</div>}
        {(skills.error || update.error || remove.error) && <QueryError error={skills.error ?? update.error ?? remove.error} />}
      </main>
      {selectedSkill && <aside className="skill-detail-drawer" aria-label={`${selectedSkill.coordinate} 技能详情`}>
        <header><div><span className="skill-row-icon"><ManagerSkillIcon source={selectedSkill.source} /></span><span><strong>{selectedSkill.coordinate}</strong><StatusPill status={selectedSkill.status} label={statusTone(selectedSkill.status) === "success" ? "已生效" : undefined} /></span></div><button className="icon-button" aria-label="关闭技能详情" onClick={() => setSelectedSkill(null)}><X size={18} /></button></header>
        <p className="skill-detail-source"><ManagerSkillIcon source={selectedSkill.source} />{selectedSkill.sourceLabel}{selectedSkill.source === "chat" && selectedSkill.binding ? ` · ${bindingContextTitle(selectedSkill.binding)}` : ""}</p>
        {selectedSkill.binding && <div className="skill-detail-actions"><button className="primary-button" onClick={() => pickRuntime(selectedSkill.binding!)}>配置依赖</button><button className="secondary-button" disabled={update.isPending} onClick={() => update.mutate(selectedSkill.binding!)}>检查升级</button><details><summary aria-label="更多操作"><MoreHorizontal size={18} /></summary><button className="text-danger" disabled={remove.isPending} onClick={() => window.confirm(`确认移除 ${selectedSkill.coordinate}？`) && remove.mutate(selectedSkill.binding!)}><Trash2 size={14} />移除技能</button></details></div>}
        <section><h4>基本信息</h4><dl><div><dt>固定版本</dt><dd>{selectedSkill.version}</dd></div><div><dt>作用范围</dt><dd>{selectedSkill.source === "chat" ? "当前聊天" : "所有聊天"}</dd></div><div><dt>管理方式</dt><dd>{selectedSkill.source === "runner" ? "只读" : "可配置"}</dd></div></dl></section>
        <section><h4>运行依赖</h4>{selectedSkill.binding ? <button className="skill-runtime-summary" onClick={() => pickRuntime(selectedSkill.binding!)}><span>环境变量 {selectedSkill.environmentCount} · 工作区文件 {selectedSkill.fileCount}</span><ChevronRight size={17} /></button> : <p className="skill-detail-readonly"><LockKeyhole size={15} />由执行环境提供，后台不修改其运行依赖。</p>}</section>
        <details className="skill-technical-details"><summary>技术信息<ChevronRight size={17} /></summary><dl><div><dt>技术路径</dt><dd>{selectedSkill.path ?? selectedSkill.binding?.id ?? "—"}</dd></div>{selectedSkill.workerName && <div><dt>执行环境</dt><dd>{selectedSkill.workerName}</dd></div>}</dl></details>
        <footer>更新于 {selectedSkill.updatedAt ? relativeTime(selectedSkill.updatedAt) : "刚刚"}</footer>
      </aside>}
    </div>
  </SkillModal>;
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
    <header className="runtime-config-heading"><div><span className="managed-skill-icon"><Sparkles size={17} /></span><span><strong>{binding.coordinate}</strong><small>固定版本 {binding.version} · {binding.scope === "bot" ? "机器人配置 · 所有聊天" : "聊天配置 · 当前聊天"}</small></span></div>{binding.scope === "bot" && <label>配置范围<select aria-label="运行依赖配置范围" value={chatContextId} onChange={(event) => setChatContextId(event.target.value)}><option value="">所有聊天默认值</option>{contexts.map((context) => <option key={context.id} value={context.id}>{contextTitle(context)} · 聊天覆盖</option>)}</select></label>}</header>
    {threadOverride && <div className="skill-callout neutral"><Layers3 size={16} />当前正在配置聊天覆盖。未覆盖的依赖继续使用机器人配置默认值。</div>}
    {config.isLoading ? <InlineLoading text="正在读取运行依赖…" /> : config.error ? <QueryError error={config.error} /> : <>
      {!runtimeWritable && <div className="skill-callout danger"><AlertTriangle size={16} />控制面尚未配置运行依赖加密密钥；现有名称和状态可查看，但暂不能写入新凭证或文件。</div>}
      <section className="runtime-config-section"><div className="skill-section-heading"><div><strong><KeyRound size={16} />环境变量</strong><small>值只在正式任务期间注入，后台不会回显。</small></div><span>{environments.length} 项</span></div>
        <div className="environment-add-form"><label><span>变量名</span><input aria-label="环境变量名" placeholder="例如 LARK_API_TOKEN" value={environmentName} onChange={(event) => setEnvironmentName(event.target.value.toUpperCase())} /></label><label><span>变量值</span><input aria-label="环境变量值" type="password" autoComplete="new-password" placeholder="写入后不可回读" value={environmentValue} onChange={(event) => setEnvironmentValue(event.target.value)} /></label><button className="primary-button" disabled={!runtimeWritable || !environmentName || !environmentValue || envWrite.isPending} onClick={() => envWrite.mutate({ name: environmentName, value: environmentValue })}>{envWrite.isPending ? "保存中…" : "保存变量"}</button></div>
        {environments.length ? <div className="runtime-env-list">{environments.map((item) => <div key={item.name}><span className="runtime-item-icon"><KeyRound size={15} /></span><span><strong>{item.name}</strong><small>{item.mode === "inherited" ? "继承机器人配置" : item.mode === "disabled" ? "当前聊天不提供" : item.sourceScope === "chat_context" ? "聊天覆盖 · 已设置" : "所有聊天 · 已设置"}{item.updatedAt ? ` · ${relativeTime(item.updatedAt)}更新` : ""}</small></span><span className="secret-set-label"><LockKeyhole size={12} />{item.mode === "disabled" ? "已停用" : "已配置"}</span><div><button className="ghost-button" onClick={() => { setEnvironmentName(item.name); setEnvironmentValue(""); }}>更新</button>{threadOverride && item.mode === "inherited" && <button className="ghost-button" onClick={() => envWrite.mutate({ name: item.name, mode: "disabled" })}>当前聊天不提供</button>}{threadOverride && ["replace", "disabled"].includes(item.mode) ? <button className="ghost-button" onClick={() => envReset.mutate(item.name)}>恢复继承</button> : !threadOverride && <button className="ghost-button text-danger" onClick={() => envReset.mutate(item.name)}>删除</button>}</div></div>)}</div> : <div className="skill-empty-row">尚未配置环境变量</div>}
      </section>
      <section className="runtime-config-section"><div className="skill-section-heading"><div><strong><FileClock size={16} />工作区配置文件</strong><small>明文文件持续保留；后台跟踪修订、实际摘要和漂移。</small></div><span>{files.length} 个</span></div>
        <div className="config-file-upload"><label><span>工作区相对路径</span><input aria-label="工作区相对路径" placeholder="例如 .env 或 config/service.json" value={targetPath} onChange={(event) => setTargetPath(event.target.value)} /></label><label className="file-picker"><span>本地文本文件</span><input aria-label="选择配置文件" type="file" accept="text/*,.env,.json,.yaml,.yml,.toml,.pem,.conf,.ini" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /><small>{uploadFile?.name ?? "尚未选择文件"}</small></label><button className="primary-button" disabled={!runtimeWritable || !targetPath.trim() || !uploadFile || fileCreate.isPending} onClick={() => uploadFile && fileCreate.mutate({ file: uploadFile, path: targetPath.trim() })}><Upload size={15} />{fileCreate.isPending ? "上传中…" : "上传并跟踪"}</button></div>
        {files.length ? <div className="runtime-file-list">{files.map((item) => <article key={item.id} className={`status-${statusTone(item.status)}`}><div className="runtime-file-main"><span className="runtime-item-icon"><FileClock size={16} /></span><span><strong>{item.targetPath}</strong><small>revision {item.revision} · {formatSize(item.size)} · 期望 {shortDigest(item.desiredSha)}</small></span><StatusPill status={item.status} /></div><dl><div><dt>工作区实际摘要</dt><dd>{shortDigest(item.actualSha)}</dd></div><div><dt>最后检查</dt><dd>{item.checkedAt ? relativeTime(item.checkedAt) : "尚未检查"}</dd></div><div><dt>来源</dt><dd>{item.mode === "inherited" ? "继承机器人配置" : item.mode === "disabled" ? "当前聊天不提供" : item.sourceScope === "chat_context" ? "聊天覆盖" : "所有聊天"}</dd></div></dl><div className="runtime-file-actions">{["drift", "conflict"].includes(item.status) && !chatContextId && <span className="runtime-file-action-hint">选择异常聊天后处理</span>}<label className="secondary-button">上传新版本<input className="visually-hidden" aria-label={`上传 ${item.targetPath} 的新版本`} type="file" accept="text/*,.env,.json,.yaml,.yml,.toml,.pem,.conf,.ini" onChange={(event) => { const file = event.target.files?.[0]; if (file) fileReplace.mutate({ item, file }); event.currentTarget.value = ""; }} /></label>{["drift", "conflict"].includes(item.status) && Boolean(chatContextId) && <button className="secondary-button" onClick={() => forceApply.mutate(item)}>覆盖工作区版本</button>}{threadOverride && item.mode === "inherited" && <button className="ghost-button" onClick={() => fileDisable.mutate(item)}>当前聊天不提供</button>}{threadOverride && ["replace", "disabled"].includes(item.mode) ? <button className="ghost-button" onClick={() => fileReset.mutate(item)}>恢复继承</button> : !threadOverride && <button className="danger-button" onClick={() => window.confirm(`确认删除工作区文件 ${item.targetPath}？文件会在执行环境空闲时清理。`) && fileReset.mutate(item)}>删除文件</button>}</div></article>)}</div> : <div className="skill-empty-row">尚未上传工作区配置文件</div>}
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
  return <details className="worker-user-skills" open={expanded}><summary><span className="managed-skill-icon"><ShieldCheck size={17} /></span><span><strong>环境继承技能 · {items.length}{truncated ? "+" : ""}</strong><small>{worker.display_name ?? worker.displayName ?? id} · {scannedAt ? `${relativeTime(scannedAt)}扫描` : "尚未扫描"}</small></span><StatusPill status={state} label={state === "ready" || state === "success" ? "已确认生效" : undefined} /><ChevronDown size={16} /></summary><div className="worker-user-skill-body"><div className="readonly-banner"><LockKeyhole size={14} />只读 · 来自执行环境，后台不能安装、更新或删除</div>{skills.isLoading ? <InlineLoading /> : skills.error ? <QueryError error={skills.error} /> : items.length ? <div className="readonly-skill-list">{items.map((item, index) => { const skillhub = item.skillhub ?? {}; const coordinate = firstString(item.coordinate, skillhub.coordinate); const version = firstString(item.version, skillhub.version); return <div key={firstString(item.path, item.relativePath, item.name) ?? index}><span><strong>{firstString(item.displayName, item.display_name, item.name) ?? "未命名技能"}</strong><small>{coordinate || version ? [coordinate, version].filter(Boolean).join(" · ") : firstString(item.shortDescription, item.short_description, item.description) ?? "环境继承技能"}</small></span><code>{firstString(item.relativePath, item.relative_path, item.path) ?? "~/.agents/skills"}</code></div>; })}</div> : <div className="skill-empty-row">当前没有被 Codex 确认启用的环境继承技能</div>}{truncated && <div className="skill-callout warning"><AlertTriangle size={15} />技能数量超过上报上限，当前列表不完整。</div>}{(Boolean(skills.data?.scanError ?? skills.data?.error) || (Array.isArray(skills.data?.errors) && skills.data.errors.length > 0)) && <div className="skill-callout warning"><AlertTriangle size={15} />扫描失败，正在展示上一次成功快照。</div>}</div></details>;
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
  return <details className="chat-skill-overview"><summary><Sparkles size={17} /><span><strong>技能与运行依赖 · {effective.length} 个受控技能</strong><small>{inherited} 个机器人配置 · {local} 个聊天配置 · {userSkillRecords(userSkills.data).length} 个环境继承</small></span><StatusPill status={syncError ? "failed" : matched ? "applied" : desiredFingerprint ? "pending" : "unknown"} label={syncError ? "同步失败" : matched ? "已应用" : desiredFingerprint ? "下次消息同步" : "尚未配置"} /><ChevronDown size={16} /></summary><div className="chat-skill-body">{skills.isLoading ? <InlineLoading /> : skills.error ? <QueryError error={skills.error} /> : <><div className="effective-skill-list">{effective.map((item) => <div key={item.coordinate}><span className="managed-skill-icon"><Sparkles size={14} /></span><span><strong>{item.coordinate}</strong><small>固定版本 {item.version}</small></span><span>{item.scope === "bot" ? "机器人配置" : "聊天配置"}</span></div>)}{!effective.length && <div className="skill-empty-row">此聊天尚未配置受控 SkillHub 技能</div>}</div><dl className="skill-fingerprint-row"><div><dt>期望技能指纹</dt><dd>{shortDigest(desiredFingerprint)}</dd></div><div><dt>已应用指纹</dt><dd>{shortDigest(appliedFingerprint)}</dd></div><div><dt>工作区配置文件</dt><dd>{runtimeFileCount} 个已配置项</dd></div></dl></>}{syncError && <div className="skill-callout danger skill-sync-retry" role="alert"><AlertTriangle size={16} /><span><strong>工作区技能同步失败</strong><small>{syncError}</small></span><button className="secondary-button" disabled={!executorId || retrySync.isPending} onClick={() => retrySync.mutate()}><RefreshCw className={retrySync.isPending ? "spin" : ""} size={14} />{retrySync.isPending ? "正在重新同步…" : "重新同步"}</button></div>}{retrySync.error && <QueryError error={retrySync.error} />}{executorId && <div className="chat-runner-skill-summary"><ShieldCheck size={15} /><span><strong>环境继承技能</strong><small>{userSkills.isLoading ? "正在核对…" : userSkills.error ? "暂时无法读取" : `${userSkillRecords(userSkills.data).length} 个已确认启用 · 只读`}</small></span></div>}</div></details>;
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
  return <section className="task-skill-snapshot"><div className="skill-section-heading"><div><strong><Sparkles size={16} />技能与依赖快照</strong><small>记录任务实际使用的固定版本；不显示任何凭证值或文件正文。</small></div><span>{controlled.length} 个受控 · {userSkills.length} 个环境继承</span></div><div className="task-skill-columns"><div><h4>受控 SkillHub 技能</h4>{controlled.length ? controlled.map((item, index) => <div className="snapshot-skill-row" key={firstString(item.packageId, item.package_id, item.coordinate) ?? index}><span><strong>{firstString(item.coordinate, item.name) ?? "未命名技能"}</strong><small>{firstString(item.sourceScope, item.source_scope, item.scope) === "chat_context" ? "聊天配置" : "机器人配置"}</small></span><code>{firstString(item.version) ?? "—"}</code></div>) : <p>未配置受控技能</p>}</div><div><h4>环境继承技能</h4>{userSkills.length ? userSkills.map((item, index) => <div className="snapshot-skill-row" key={firstString(item.path, item.relativePath, item.name) ?? index}><span><strong>{firstString(item.displayName, item.display_name, item.name) ?? "未命名技能"}</strong><small>执行时只读快照</small></span><code>{firstString(item.version, item.skillhub?.version) ?? "启用"}</code></div>) : <p>执行时未记录环境继承技能</p>}</div></div><dl className="task-runtime-summary"><div><dt>技能集合指纹</dt><dd>{shortDigest(fingerprint)}</dd></div><div><dt>已注入变量名</dt><dd>{environmentNames.length ? environmentNames.join("、") : "无"}</dd></div><div><dt>工作区文件</dt><dd>{files.length ? files.map((item) => firstString(item.targetPath, item.target_path, item.path)).filter(Boolean).join("、") : "无"}</dd></div></dl></section>;
}

function SkillEmpty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="skill-empty"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>;
}
