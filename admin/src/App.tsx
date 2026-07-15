import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleGauge, Clock3, FileClock, Inbox,
  Check, Copy, Cpu, GitBranch, HardDrive, KeyRound, ListFilter, LogOut, Menu, MessageCircle, MessagesSquare, MoreHorizontal,
  Paperclip, Plus, RefreshCw, RotateCcw, Search, Server, ShieldCheck, Sparkles, Timer, Trash2, UserRound, Wifi, WifiOff, Wrench, X
} from "lucide-react";
import { adminPath, api, ApiError, commandBody, publicPath, relativeTime, type AdminUser } from "./api";

type AnyRecord = Record<string, any>;
const stateLabel: Record<string, string> = {
  queued: "已排队", waiting_worker: "等待执行器", running: "执行中", waiting_input: "等待输入", waiting_approval: "等待审批",
  held_draft: "草稿搁置", human_owned: "人工接管", completed: "已完成", failed: "失败", cancelled: "已取消"
};
const flowStageLabel: Record<string, string> = { message: "飞书消息", inbox: "Agent 收件箱", attention: "注意力判断", routing: "任务路由", codex: "Codex 执行", draft: "草稿检查", outbox: "发件箱", reply: "飞书回复" };
const decisionLabel: Record<string, string> = { pending: "待判断", consume: "已消费", merge: "已合并", defer: "已延后", dismiss: "已忽略" };

export function App({ queryClient }: { queryClient: QueryClient }) {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<AdminUser>("/v1/admin/me"), retry: false, refetchInterval: false });
  useEffect(() => {
    if (!me.data) return;
    const stream = new EventSource(publicPath("/v1/admin/stream"));
    stream.addEventListener("change", (event) => {
      const change = JSON.parse((event as MessageEvent).data) as { type: string; id?: string };
      void queryClient.invalidateQueries({ queryKey: [change.type] });
      if (change.type === "chat_context") void queryClient.invalidateQueries({ queryKey: ["chat-context"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      if (change.type === "task" && change.id) void queryClient.invalidateQueries({ queryKey: ["task", change.id] });
    });
    return () => stream.close();
  }, [me.data, queryClient]);
  if (me.isLoading) return <FullPage><div className="loading-orb" /><p>正在确认运维身份…</p></FullPage>;
  if (me.error instanceof ApiError && [401, 403].includes(me.error.status)) return <Login {...(me.error.status === 403 ? { error: me.error.message } : {})} />;
  if (!me.data) return <FullPage><AlertTriangle size={28} /><h2>后台暂时不可用</h2><p>{me.error instanceof Error ? me.error.message : "请稍后重试"}</p></FullPage>;
  return <Shell user={me.data} queryClient={queryClient} />;
}

function Login({ error }: { error?: string }) {
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!token) return;
    setConnecting(true);
    void api<{ ok: boolean }>("/auth/lark/consume", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => {
        window.history.replaceState({}, "", adminPath("/"));
        window.location.replace(adminPath("/"));
      })
      .catch((reason: unknown) => {
        setConnecting(false);
        setConnectError(reason instanceof Error ? reason.message : "专属通行链接不可用");
      });
  }, []);
  const copyCommand = () => {
    const fallback = () => {
      const input = document.createElement("textarea");
      input.value = "/连接控制台";
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand?.("copy");
      input.remove();
    };
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText("/连接控制台").catch(fallback);
    else fallback();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  if (connecting) return <FullPage><div className="loading-orb" /><p>正在确认飞书身份并连接控制台…</p></FullPage>;
  return <div className="login-page"><div className="login-panel">
    <div className="brand-mark"><Sparkles size={24} /></div><p className="eyebrow">LARK AGENT OPERATIONS</p>
    <h1>用飞书身份，<br />连接 Agent 控制台。</h1>
    <p className="login-copy">在飞书中私聊机器人，发送下面的专属指令。机器人会返回一条 2 分钟有效、仅可使用一次的通行链接。</p>
    {(error || connectError) && <div className="inline-alert"><AlertTriangle size={18} />{connectError ?? error}</div>}
    <button className="command-card" onClick={() => void copyCommand()}><span><MessageCircle size={18} />发送给机器人</span><strong>/连接控制台</strong><small>{copied ? <><Check size={14} />已复制</> : <><Copy size={14} />复制指令</>}</small></button>
    <p className="login-footnote"><ShieldCheck size={15} /> 身份确认后，控制台连接最长保持 12 小时</p>
  </div><div className="login-visual"><div className="signal-radar"><span /><span /><span /><Bot size={42} /></div><div className="visual-caption"><strong>信号正在流动</strong><span>消息、判断、执行与回复形成一条可追溯链路</span></div></div></div>;
}

function Shell({ user, queryClient }: { user: AdminUser; queryClient: QueryClient }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const logout = async () => { await api("/auth/logout", { method: "POST" }, user); queryClient.clear(); navigate(0); };
  const nav = [
    ["/", "运行总览", CircleGauge], ["/tasks", "任务中心", Inbox], ["/bots", "机器人", Bot], ["/workers", "执行器", Server],
    ["/pending", "待处理", FileClock], ["/incidents", "故障中心", AlertTriangle]
  ] as const;
  return <div className="app-shell">
    <aside className={open ? "sidebar open" : "sidebar"}>
      <div className="sidebar-brand"><div className="brand-mark small"><Sparkles size={19} /></div><div><strong>{user.agentDisplayName}</strong><span>运维驾驶舱</span></div><button className="icon-button mobile-only" aria-label="关闭导航" onClick={() => setOpen(false)}><X /></button></div>
      <nav>{nav.map(([to, label, Icon]) => <NavLink key={to} to={to} end={to === "/"} onClick={() => setOpen(false)}><Icon size={19} /><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-status"><span className="pulse" /><div><strong>控制面运行中</strong><span>状态自动同步</span></div></div>
    </aside>
    <main><header className="topbar"><button className="icon-button mobile-only" aria-label="打开导航" onClick={() => setOpen(true)}><Menu /></button><div className="topbar-spacer" /><div className="identity"><div className="avatar">{(user.displayName ?? "主").slice(0, 1)}</div><div><strong>{user.displayName ?? "飞书主人"}</strong><span>主人</span></div></div><button className="icon-button" aria-label="断开控制台" onClick={() => void logout()}><LogOut size={18} /></button></header>
      <div className="page-area"><Routes>
        <Route path="/" element={<Overview />} /><Route path="/flow" element={<LegacyFlowRedirect />} /><Route path="/bots" element={<Bots user={user} />} /><Route path="/bots/:botId/chat-memory" element={<ChatMemoryWorkspace user={user} />} /><Route path="/bots/:botId/chat-memory/:contextId" element={<ChatMemoryWorkspace user={user} />} /><Route path="/tasks" element={<Tasks />} /><Route path="/tasks/:id" element={<TaskDetail user={user} />} />
        <Route path="/workers" element={<Workers user={user} />} /><Route path="/pending" element={<Pending user={user} />} />
        <Route path="/incidents" element={<Incidents user={user} />} /><Route path="*" element={<Navigate to="/" />} />
      </Routes></div>
    </main>
  </div>;
}

function LegacyFlowRedirect() {
  const [params] = useSearchParams();
  if (!params.has("view")) params.set("view", "flow");
  return <Navigate to={`/tasks?${params.toString()}`} replace />;
}

function Bots({ user }: { user: AdminUser }) {
  const [params, setParams] = useSearchParams();
  const bots = useQuery({ queryKey: ["bot"], queryFn: () => api<AnyRecord>("/v1/admin/bots"), refetchInterval: 30_000 });
  const workers = useQuery({ queryKey: ["worker"], queryFn: () => api<AnyRecord>("/v1/admin/workers") });
  const dialogue = useQuery({ queryKey: ["settings", "bot-dialogue"], queryFn: () => api<AnyRecord>("/v1/admin/settings/bot-dialogue") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AnyRecord | null>(null);
  const selectedBotId = params.get("bot") ?? "";
  const refresh = () => { void bots.refetch(); setAdding(false); setEditing(null); };
  const continueSetup = (bot: AnyRecord) => { void bots.refetch(); setAdding(false); setEditing(bot); };
  const items = bots.data?.items ?? [];
  const selected = items.find((bot: AnyRecord) => bot.id === selectedBotId) ?? items[0];
  useEffect(() => {
    if (!items.length || items.some((bot: AnyRecord) => bot.id === selectedBotId)) return;
    setParams({ bot: items[0].id }, { replace: true });
  }, [items, selectedBotId, setParams]);
  return <><PageTitle eyebrow="飞书身份" title="机器人" description="先确认接入是否正常，再按需查看角色、路由与长期聊天记忆。" action={<button className="primary-button" onClick={() => setAdding(true)}><Plus size={17} />添加机器人</button>} />
    {!bots.data ? <PageLoading /> : items.length ? <div className="master-detail-layout bot-master-detail">
      <aside className="master-list-panel" aria-label="机器人列表">
        <div className="master-list-search"><Search size={17} /><span>机器人与角色</span><span>{items.length}</span></div>
        <div className="master-list">{items.map((bot: AnyRecord) => {
          const message = bot.runtime?.[`${bot.id}:message`];
          const state = !bot.enabled ? "disabled" : message?.ready ? "online" : message?.state === "error" ? "error" : "starting";
          return <button key={bot.id} aria-pressed={selected?.id === bot.id} className={selected?.id === bot.id ? "master-list-item selected" : "master-list-item"} onClick={() => setParams({ bot: bot.id })}>
            <span className="list-item-icon"><Bot size={20} /></span><span><strong>{bot.displayName}</strong><small>{bot.roleInstructions || "通用助理机器人"}</small><small>默认执行器：{bot.defaultExecutorId ?? "自动选择"}</small></span><StateBadge state={state} label={state === "online" ? "已启用" : undefined} />
          </button>;
        })}</div>
        <details className="master-list-foot"><summary><ShieldCheck size={16} />机器人互聊保护<ChevronRight size={15} /></summary><div className="master-list-foot-body"><div className="bot-routing-note compact"><GitBranch size={16} /><div><strong>群聊路由规则</strong><span>明确 @ 时只交给被提及机器人；普通续聊由活跃 Agent 独立判断。</span></div></div><BotDialogueSettings user={user} value={dialogue.data} loading={dialogue.isLoading} onSaved={() => void dialogue.refetch()} /></div></details>
      </aside>
      {selected && <BotMasterDetailPane bot={selected} user={user} onEdit={() => setEditing(selected)} onRefreshed={() => void bots.refetch()} />}
    </div> : <article className="panel"><Empty icon={<Bot />} title="还没有机器人" text="添加飞书机器人后，可在这里配置角色与运行路由。" /></article>}
    {adding && <AddBotDialog user={user} workers={workers.data?.items ?? []} onClose={() => setAdding(false)} onCreated={continueSetup} />}
    {editing && <BotSettingsDialog user={user} bot={editing} workers={workers.data?.items ?? []} onClose={() => setEditing(null)} onSaved={refresh} />}
  </>;
}

function BotMasterDetailPane({ bot, user, onEdit, onRefreshed }: { bot: AnyRecord; user: AdminUser; onEdit(): void; onRefreshed(): void }) {
  const message = bot.runtime?.[`${bot.id}:message`];
  const reconnect = useMutation({ mutationFn: () => api(`/v1/admin/bots/${bot.id}/commands`, { method: "POST", body: JSON.stringify({ command: "reconnect" }) }, user), onSuccess: onRefreshed });
  const permissionCheck = useMutation({ mutationFn: () => api(`/v1/admin/bots/${bot.id}/permission-check`, { method: "POST", body: "{}" }, user), onSuccess: onRefreshed });
  const online = Boolean(bot.enabled && message?.ready);
  const accessReady = Boolean(online && bot.permissionState === "valid" && bot.credentialState === "verified");
  const conclusion = !bot.enabled ? ["机器人已停用", "消息不会进入该机器人的任务链路。", "disabled"] : !online ? ["消息连接尚未就绪", explainBotRuntimeError(message?.lastError), "blocked"] : accessReady ? ["接入正常，正在监听消息", "消息连接、应用权限与凭据均可用，可继续处理聊天。", "ready"] : ["消息连接正常，仍有接入项需确认", "消息可以进入，但权限或凭据仍需按下方独立状态处理。", "warning"];
  const statusItems = [
    ["应用权限", bot.permissionState === "valid" ? "ok" : "warning", bot.permissionState === "valid" ? "已授权" : "需检测"],
    ["消息订阅", message?.ready ? "ok" : "warning", message?.ready ? "已订阅" : "未就绪"],
    ["凭据", bot.credentialState === "verified" ? "ok" : "warning", bot.credentialState === "verified" ? "有效" : "需更新"],
    ["主人绑定", bot.ownerBound ? "ok" : "warning", bot.ownerBound ? "已绑定" : "未绑定"],
    ["启用状态", bot.enabled ? "ok" : "warning", bot.enabled ? "已启用" : "已停用"],
    ["系统通知身份", bot.isSystem ? "ok" : "neutral", bot.isSystem ? "已绑定" : "普通机器人"]
  ] as const;
  return <section className="master-detail-panel bot-detail-pane">
    <header className="entity-header"><div className="entity-heading"><span className="entity-icon"><Bot size={27} /></span><div><h2>{bot.displayName}</h2><p>{bot.roleInstructions || "通用助理机器人"}</p><small className="mono">ID：{bot.id}</small></div></div><div className="entity-actions"><button className="secondary-button" disabled={permissionCheck.isPending} onClick={() => permissionCheck.mutate()}><ShieldCheck size={15} />{permissionCheck.isPending ? "检测中…" : "重新检测权限"}</button>{!online && bot.enabled && <button className="secondary-button" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}><RefreshCw size={15} />{reconnect.isPending ? "连接中…" : "重新连接"}</button>}<button className="secondary-button" onClick={onEdit}>配置</button></div></header>
    <div className={`entity-conclusion conclusion-${conclusion[2]}`}><span>{conclusion[2] === "ready" ? <CheckCircle2 /> : <AlertTriangle />}</span><div><strong>{conclusion[0]}</strong><p>{conclusion[1]}</p></div></div>
    <div className="status-check-grid">{statusItems.map(([label, tone, detail]) => <div className={`status-check ${tone}`} key={label}>{tone === "ok" ? <CheckCircle2 size={17} /> : tone === "warning" ? <AlertTriangle size={17} /> : <ShieldCheck size={17} />}<span><strong>{label}</strong><small>{detail}</small></span></div>)}</div>
    {(reconnect.error || permissionCheck.error) && <ErrorBox error={reconnect.error ?? permissionCheck.error} />}
    <BotChatMemorySummary bot={bot} />
    <div className="layered-sections">
      <details open><summary><GitBranch size={17} /><span><strong>角色与路由</strong><small>角色、模型、默认执行器与工作区</small></span><ChevronDown size={17} /></summary><dl className="layered-detail-list"><Detail label="角色" value={bot.roleInstructions || "通用助理"} /><Detail label="默认执行器" value={bot.defaultExecutorId ?? "自动选择"} /><Detail label="默认总工作区" value={bot.defaultWorkspaceAlias ?? "自动选择"} /><Detail label="注意力模型" value={formatModelPolicy(bot.attentionModel, bot.attentionReasoningEffort)} /><Detail label="执行模型" value={formatModelPolicy(bot.executionModel, bot.executionReasoningEffort)} /></dl></details>
      <details><summary><UserRound size={17} /><span><strong>群聊与主人</strong><small>{bot.ownerBound ? "主人已绑定" : "等待主人绑定"} · {bot.bindings?.filter((item: AnyRecord) => item.enabled).length ?? 0} 个群聊</small></span><ChevronDown size={17} /></summary><dl className="layered-detail-list"><Detail label="主人绑定" value={bot.ownerBound ? "已完成" : "尚未绑定"} /><Detail label="已绑定群" value={`${bot.bindings?.filter((item: AnyRecord) => item.enabled).length ?? 0} 个`} /><Detail label="活跃会话" value={`${bot.activeConversations ?? 0} 个`} /></dl></details>
      <details><summary><ShieldCheck size={17} /><span><strong>接入与安全</strong><small>权限、凭据、消息订阅与系统身份</small></span><ChevronDown size={17} /></summary><dl className="layered-detail-list"><Detail label="应用权限" value={bot.permissionState === "valid" ? "完整" : "需要检测或补齐"} /><Detail label="凭据" value={bot.credentialState === "verified" ? "已验证（只写）" : bot.credentialError ?? bot.credentialState} /><Detail label="消息订阅" value={message?.ready ? "正常" : "未就绪"} /><Detail label="配置版本" value={`v${bot.configRevision}`} /></dl></details>
    </div>
  </section>;
}

function BotChatMemorySummary({ bot }: { bot: AnyRecord }) {
  const contexts = useQuery({ queryKey: ["chat-context", "summary", bot.id], queryFn: () => api<AnyRecord>(`/v1/admin/chat-contexts?${new URLSearchParams({ bot: bot.id, limit: "100" })}`), refetchInterval: 30_000 });
  const items = contexts.data?.items ?? [];
  const summary = contexts.data?.summary ?? {};
  const total = summary.total ?? items.length;
  const blocked = summary.blocked ?? items.filter((item: AnyRecord) => item.state === "blocked").length;
  const recent = summary.lastActivityAt ?? items[0]?.lastActivityAt ?? null;
  return <NavLink className="chat-memory-entry" to={`/bots/${bot.id}/chat-memory`}><span className="entry-icon"><MessagesSquare size={20} /></span><span><strong>聊天记忆</strong><small>固定保存每个聊天的 Thread、执行环境与独立工作区</small></span><span className="chat-memory-stats"><span><b>{total}</b><small>聊天</small></span><span className={blocked ? "danger" : ""}><b>{blocked}</b><small>阻塞</small></span><span><b>{recent ? relativeTime(recent) : "—"}</b><small>最近活动</small></span></span><ChevronRight size={18} /></NavLink>;
}

function BotDialogueSettings({ user, value, loading, onSaved }: { user: AdminUser; value: AnyRecord | undefined; loading: boolean; onSaved(): void }) {
  const [depth, setDepth] = useState(30);
  useEffect(() => { if (value?.maxConsecutiveDepth) setDepth(value.maxConsecutiveDepth); }, [value?.maxConsecutiveDepth]);
  const mutation = useMutation({
    mutationFn: () => api("/v1/admin/settings/bot-dialogue", { method: "PATCH", body: JSON.stringify({ maxConsecutiveDepth: depth }) }, user),
    onSuccess: onSaved
  });
  return <section className="bot-dialogue-settings"><div><ShieldCheck size={18} /><div><strong>机器人互聊保护</strong><span>只处理当前控制台注册的机器人，并且只传播最终回复；流式进度、审批、故障和保护提示不会进入其他机器人的收件箱。</span></div></div><div className="dialogue-depth-control"><label htmlFor="bot-dialogue-depth">连续因果轮次上限</label><input id="bot-dialogue-depth" type="number" min={1} max={200} value={depth} disabled={loading || mutation.isPending} onChange={(event) => setDepth(Math.max(1, Math.min(200, Number(event.target.value) || 1)))} /><button className="secondary-button" disabled={loading || mutation.isPending || depth === value?.maxConsecutiveDepth} onClick={() => mutation.mutate()}>{mutation.isPending ? "保存中…" : "保存"}</button><small>达到上限后，本轮回复仍会发送，但不再传播；群内只提示一次并等待下一条人类消息自动恢复。</small></div>{mutation.error && <ErrorBox error={mutation.error} />}</section>;
}

function BotCard({ bot, user, onEdit, onRefreshed }: { bot: AnyRecord; user: AdminUser; onEdit(): void; onRefreshed(): void }) {
  const message = bot.runtime?.[`${bot.id}:message`];
  const reconnect = useMutation({
    mutationFn: () => api(`/v1/admin/bots/${bot.id}/commands`, { method: "POST", body: JSON.stringify({ command: "reconnect" }) }, user),
    onSuccess: onRefreshed
  });
  const permissionCheck = useMutation({
    mutationFn: () => api(`/v1/admin/bots/${bot.id}/permission-check`, { method: "POST", body: "{}" }, user),
    onSuccess: onRefreshed
  });
  const runtimeState = !bot.enabled ? "disabled" : message?.ready ? "online" : message?.state === "error" ? "error" : "starting";
  const runtimeLabel = runtimeState === "error" ? "消息接入异常" : runtimeState === "starting" ? "正在连接" : undefined;
  const runtimeError = runtimeState === "error" ? explainBotRuntimeError(message?.lastError) : null;
  return <article className="worker-card bot-card"><div className="worker-card-top"><div className="machine-icon"><Bot /></div><div><h3>{bot.displayName}</h3><p>{bot.appId}</p></div><StateBadge state={runtimeState} label={runtimeLabel} /></div>
    <div className="bot-badges">{bot.isSystem && <span><ShieldCheck size={13} />系统通知</span>}<span>{bot.ownerBound ? "主人已绑定" : "等待主人绑定"}</span><PermissionBadge bot={bot} /><span>配置 v{bot.configRevision}</span></div>
    {bot.permissionState !== "valid" && <PermissionAlert bot={bot} />}
    {runtimeError && <div className="bot-runtime-alert" title={message?.lastError ?? undefined}><AlertTriangle size={17} /><div><strong>消息消费者没有运行</strong><span>{runtimeError}</span></div></div>}
    {bot.routeWarning && <div className="bot-runtime-alert"><AlertTriangle size={17} /><div><strong>执行路由不明确</strong><span>{bot.routeWarning}</span></div></div>}
    <dl className="detail-list"><Detail label="角色" value={bot.roleInstructions || "通用助理"} /><Detail label="默认执行器" value={bot.defaultExecutorId} /><Detail label="默认总工作区" value={bot.defaultWorkspaceAlias} /><Detail label="注意力模型" value={formatModelPolicy(bot.attentionModel, bot.attentionReasoningEffort)} /><Detail label="正式执行模型" value={formatModelPolicy(bot.executionModel, bot.executionReasoningEffort)} /><Detail label="聊天工作区" value={`${bot.defaultWorkspaceAlias ?? "自动选择"}/${bot.appId}/chats/<Chat Context ID>`} /><Detail label="已绑定群" value={`${bot.bindings?.filter((x: AnyRecord) => x.enabled).length ?? 0} 个`} /><Detail label="活跃会话" value={`${bot.activeConversations} 个`} /><Detail label="凭据" value={bot.credentialState === "verified" ? "已验证（只写）" : bot.credentialError ?? bot.credentialState} /></dl>
    {(reconnect.error || permissionCheck.error) && <ErrorBox error={reconnect.error ?? permissionCheck.error} />}
    <div className="card-actions"><button className="secondary-button" disabled={permissionCheck.isPending} onClick={() => permissionCheck.mutate()}><ShieldCheck size={15} />{permissionCheck.isPending ? "检测中…" : bot.permissionState === "unchecked" ? "检测权限" : "重新检测"}</button>{runtimeError && <button className="secondary-button" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}><RefreshCw size={15} />{reconnect.isPending ? "正在重连…" : "重新连接"}</button>}<button className="secondary-button" onClick={onEdit}>配置</button></div>
  </article>;
}

function ChatMemoryPanel({ bots, loadingBots }: { bots: AnyRecord[]; loadingBots: boolean }) {
  const [botId, setBotId] = useState("");
  const [chatType, setChatType] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const params = new URLSearchParams({ ...(botId && { bot: botId }), ...(chatType && { chatType }), ...(q && { q }) });
  const contexts = useQuery({
    queryKey: ["chat-context", "list", botId, chatType, q],
    queryFn: () => api<AnyRecord>(`/v1/admin/chat-contexts?${params}`),
    refetchInterval: 30_000
  });
  return <section className="chat-memory-section" aria-labelledby="chat-memory-title">
    <div className="chat-memory-heading"><div><span className="eyebrow">长期上下文</span><h2 id="chat-memory-title">聊天记忆</h2><p>每个机器人与群聊或私聊永久绑定一个 Codex Thread 和独立目录；这里仅提供只读观测。</p></div><span className="chat-memory-count">{contexts.data?.items?.length ?? 0} 个聊天</span></div>
    <div className="filterbar chat-memory-filters"><select aria-label="按机器人筛选聊天记忆" value={botId} disabled={loadingBots} onChange={(event) => setBotId(event.target.value)}><option value="">全部机器人</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.displayName}</option>)}</select><select aria-label="按聊天类型筛选聊天记忆" value={chatType} onChange={(event) => setChatType(event.target.value)}><option value="">全部类型</option><option value="group">群聊</option><option value="p2p">私聊</option></select><div className="search"><Search size={17} /><input aria-label="搜索聊天记忆" placeholder="聊天名称、Chat ID 或 Thread" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setQ(search.trim()); }} /></div><button className="secondary-button" onClick={() => setQ(search.trim())}>搜索</button></div>
    <article className="panel table-panel">{contexts.isLoading ? <PageLoading compact /> : contexts.error ? <ErrorBox error={contexts.error} /> : <ChatMemoryTable items={contexts.data?.items ?? []} onOpen={setSelectedId} />}</article>
    {selectedId && <ChatMemoryDetailDialog id={selectedId} onClose={() => setSelectedId(null)} />}
  </section>;
}

export function ChatMemoryTable({ items, onOpen }: { items: AnyRecord[]; onOpen(id: string): void }) {
  if (!items.length) return <Empty icon={<MessageCircle />} title="还没有聊天记忆" text="机器人首次收到该聊天的有效消息后，会在这里建立长期绑定。" />;
  return <div className="table-wrap"><table className="chat-memory-table"><thead><tr><th>机器人与聊天</th><th>Chat ID</th><th>Codex Thread</th><th>状态</th><th>固定执行器</th><th>总工作区</th><th>升级后自动压缩</th><th>最后活动</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id} onClick={() => onOpen(item.id)}><td><strong>{item.botDisplayName}</strong><small>{item.chatType === "group" ? `群聊 · ${item.chatName ?? "未命名群聊"}` : "私聊"}</small></td><td className="mono" title={item.chatId}>{shortId(item.chatId) ?? "—"}</td><td className="mono" title={item.threadId ?? undefined}>{shortId(item.threadId) ?? "尚未建立"}</td><td><StateBadge state={item.state} label={chatContextStateLabel(item.state)} /></td><td>{item.executorId ?? "首次执行时固定"}</td><td>{item.workspaceRootAlias ?? "首次执行时固定"}</td><td>{Number(item.autoCompactionCount ?? 0)} 次<small>{item.lastCompactedAt ? relativeTime(item.lastCompactedAt) : "尚未观测到"}</small></td><td>{relativeTime(item.lastActivityAt)}</td><td><button className="icon-button" aria-label={`查看 ${item.chatName ?? item.chatId} 的聊天记忆`} onClick={(event) => { event.stopPropagation(); onOpen(item.id); }}><ChevronRight size={17} /></button></td></tr>)}</tbody></table></div>;
}

function ChatMemoryDetailDialog({ id, onClose }: { id: string; onClose(): void }) {
  const detail = useQuery({ queryKey: ["chat-context", id], queryFn: () => api<AnyRecord>(`/v1/admin/chat-contexts/${id}`) });
  return <Modal title="聊天记忆详情" onClose={onClose}>{detail.isLoading ? <PageLoading compact /> : detail.error ? <ErrorBox error={detail.error} /> : detail.data && <div className="chat-memory-detail"><div className="chat-memory-summary"><div><span>{detail.data.chatType === "group" ? "群聊" : "私聊"}</span><strong>{detail.data.chatName ?? (detail.data.chatType === "group" ? "未命名群聊" : detail.data.chatId)}</strong><small>{detail.data.botDisplayName} · {detail.data.botAppId}</small></div><StateBadge state={detail.data.state} label={chatContextStateLabel(detail.data.state)} /></div>{detail.data.blockedReason && <div className="inline-alert"><AlertTriangle size={17} />{detail.data.blockedReason}</div>}<dl className="detail-list"><Detail label="Chat Context ID" value={detail.data.id} /><Detail label="Chat ID" value={detail.data.chatId} /><Detail label="Codex Thread" value={detail.data.threadId} /><Detail label="固定执行器" value={detail.data.executorId} /><Detail label="Codex Profile" value={detail.data.executorProfile} /><Detail label="配置指纹" value={detail.data.executorConfigFingerprint} /><Detail label="总工作区别名" value={detail.data.workspaceRootAlias} /><Detail label="聊天工作区" value={detail.data.workspaceKey ? `${detail.data.workspaceRootAlias ?? "<总工作区>"}/${detail.data.botAppId}/chats/${detail.data.workspaceKey}` : null} /><Detail label="最后活动" value={formatDateTime(detail.data.lastActivityAt)} /><Detail label="最近自动压缩" value={formatDateTime(detail.data.lastCompactedAt)} /></dl><section className="chat-compaction-history"><strong>Codex 自动压缩记录</strong><p>自动压缩只减少上下文占用，不会更换 Thread 或聊天工作区。</p>{detail.data.compactions?.length ? <div>{detail.data.compactions.map((item: AnyRecord) => <article key={item.id}><div><span>{formatDateTime(item.occurredAt)}</span><strong className="mono">Turn {shortId(item.turnId) ?? "—"}</strong></div><small className="mono">Thread {shortId(item.threadId) ?? "—"}{item.itemId ? ` · Item ${shortId(item.itemId)}` : ""}</small></article>)}</div> : <Empty icon={<FileClock />} title="尚未观测到自动压缩" text="Codex 触发原生上下文压缩后，审计记录会显示在这里。" />}</section></div>}</Modal>;
}

function ChatMemoryWorkspace({ user }: { user: AdminUser }) {
  const { botId = "", contextId } = useParams();
  const navigate = useNavigate();
  const [stateFilter, setStateFilter] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const bots = useQuery({ queryKey: ["bot", "chat-memory-workspace"], queryFn: () => api<AnyRecord>("/v1/admin/bots") });
  const allContexts = useQuery({
    queryKey: ["chat-context", "workspace-summary", botId],
    queryFn: () => api<AnyRecord>(`/v1/admin/chat-contexts?${new URLSearchParams({ bot: botId, limit: "1" })}`),
    enabled: Boolean(botId),
    refetchInterval: 30_000
  });
  const query = new URLSearchParams({ bot: botId, limit: "100", ...(stateFilter && { state: stateFilter }), ...(q && { q }) });
  const contexts = useQuery({ queryKey: ["chat-context", "workspace", botId, stateFilter, q], queryFn: () => api<AnyRecord>(`/v1/admin/chat-contexts?${query}`), enabled: Boolean(botId), refetchInterval: 30_000 });
  const items = contexts.data?.items ?? [];
  const visibleItems = stateFilter && !contexts.data?.summary ? items.filter((item: AnyRecord) => item.state === stateFilter) : items;
  const selectedVisible = visibleItems.some((item: AnyRecord) => item.id === contextId);
  useEffect(() => {
    if (!visibleItems.length || (contextId && selectedVisible)) return;
    if (!contextId && window.matchMedia("(max-width: 760px)").matches) return;
    void navigate(`/bots/${botId}/chat-memory/${visibleItems[0].id}`, { replace: true });
  }, [botId, contextId, navigate, selectedVisible, visibleItems]);
  const bot = bots.data?.items?.find((item: AnyRecord) => item.id === botId);
  const summary = allContexts.data?.summary ?? {};
  const total = summary.total ?? 0;
  const blocked = summary.blocked ?? 0;
  const latest = summary.lastActivityAt ?? null;
  return <><div className="workspace-breadcrumb"><NavLink to="/bots"><ArrowLeft size={16} />返回机器人</NavLink><span>机器人 / {bot?.displayName ?? "…"} / 聊天记忆</span></div>
    <PageTitle eyebrow="长期上下文" title="聊天记忆" description={`${total} 个聊天 · ${blocked} 个阻塞 · 最近活动 ${latest ? relativeTime(latest) : "暂无"}`} />
    <div className={`chat-memory-workspace ${contextId ? "has-selection" : "showing-list"}`}>
      <aside className="chat-memory-list-panel">
        <div className="chat-memory-search"><Search size={17} /><input aria-label="搜索聊天记忆" placeholder="搜索聊天名称或类型" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setQ(search.trim()); }} /><button aria-label="执行搜索" onClick={() => setQ(search.trim())}><ArrowRight size={16} /></button></div>
        <div className="memory-state-tabs" role="tablist" aria-label="聊天记忆状态筛选">{([["", "全部"], ["blocked", "已阻塞"], ["uninitialized", "待初始化"]] as const).map(([value, label]) => <button key={label} role="tab" aria-selected={stateFilter === value} className={stateFilter === value ? "active" : ""} onKeyDown={moveTabFocus} onClick={() => setStateFilter(value)}>{label}</button>)}</div>
        {contexts.isLoading ? <PageLoading compact /> : contexts.error ? <ErrorBox error={contexts.error} /> : visibleItems.length ? <div className="chat-memory-list">{visibleItems.map((item: AnyRecord) => <button key={item.id} aria-pressed={contextId === item.id} className={contextId === item.id ? "selected" : ""} onClick={() => navigate(`/bots/${botId}/chat-memory/${item.id}`)}><span className={`chat-avatar state-${item.state}`}>{item.chatType === "group" ? <MessagesSquare size={19} /> : <UserRound size={19} />}</span><span><strong>{item.chatName ?? (item.chatType === "group" ? "未命名群聊" : "私聊")}</strong><small><StateText state={item.state} /> · {relativeTime(item.lastActivityAt)}</small></span><ChevronRight size={17} /></button>)}</div> : <Empty icon={<MessageCircle />} title="没有匹配的聊天" text="调整状态或搜索条件后再试。" />}
      </aside>
      <section className="chat-memory-canvas"><button className="mobile-chat-list-back" onClick={() => navigate(`/bots/${botId}/chat-memory`)}><ArrowLeft size={16} />返回聊天列表</button>{contextId ? <ChatMemoryWorkspaceDetail id={contextId} botId={botId} user={user} /> : <Empty icon={<MessagesSquare />} title="选择一个聊天" text="从左侧选择聊天后查看长期绑定与恢复条件。" />}</section>
    </div>
  </>;
}

function ChatMemoryWorkspaceDetail({ id, botId, user }: { id: string; botId: string; user: AdminUser }) {
  const queryClient = useQueryClient();
  const [recoveryResult, setRecoveryResult] = useState<AnyRecord | null>(null);
  const detail = useQuery({ queryKey: ["chat-context", id], queryFn: () => api<AnyRecord>(`/v1/admin/chat-contexts/${id}`) });
  useEffect(() => setRecoveryResult(null), [id]);
  const recovery = useMutation({
    mutationFn: () => api<AnyRecord>(`/v1/admin/chat-contexts/${id}/recover`, { method: "POST", body: "{}" }, user),
    onSuccess: (result) => { setRecoveryResult(result); void queryClient.invalidateQueries({ queryKey: ["chat-context"] }); void queryClient.invalidateQueries({ queryKey: ["task"] }); }
  });
  if (detail.isLoading) return <PageLoading compact />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return null;
  const d = detail.data;
  const state = recoveryResult?.state ?? d.state;
  const defaultChecks = [
    { key: "thread", label: "原 Thread", state: "pending", detail: d.threadId ?? "尚未建立" },
    { key: "executor", label: "执行器", state: "pending", detail: d.executorId ?? "尚未固定" },
    { key: "claimable", label: "领取状态", state: "pending", detail: "等待后台核验" },
    { key: "capability", label: "永久聊天记忆能力", state: "pending", detail: "等待后台核验" },
    { key: "homeIdentity", label: "CODEX_HOME 身份", state: "pending", detail: "等待后台核验" },
    { key: "profile", label: "Codex Profile", state: "pending", detail: d.executorProfile ?? "尚未固定" },
    { key: "workspaceAlias", label: "总工作区", state: "pending", detail: d.workspaceRootAlias ?? "尚未固定" },
    { key: "configFingerprint", label: "配置指纹", state: "pending", detail: d.executorConfigFingerprint ?? "等待后台核验" }
  ];
  const checks = recovery.isPending ? defaultChecks.map((item) => ({ ...item, state: "checking", detail: "正在检测原固定环境…" })) : recoveryResult?.checks ?? defaultChecks;
  const taskLink = `/tasks?view=tasks&bot=${botId}&chatContextId=${id}`;
  const taskLinkLabel = "查看关联任务";
  return <div className="memory-detail-canvas">
    <div className={`memory-state-hero state-${state}`}><span>{state === "ready" ? <CheckCircle2 /> : state === "blocked" ? <AlertTriangle /> : <Clock3 />}</span><div><strong>{state === "ready" ? "长期记忆绑定正常" : state === "blocked" ? "长期记忆已暂停" : "聊天记忆等待首次初始化"}</strong><p>{state === "ready" ? "固定 Thread、执行环境和工作区保持一致。" : state === "blocked" ? (d.blockedReason ?? "当前固定环境与首次绑定不一致，关联任务暂时不能继续。") : "首次有效任务执行时，会固定 Thread、执行器、Profile 与工作区。"}</p></div><StateBadge state={state} label={chatContextStateLabel(state)} /></div>
    {state === "blocked" && <section className="recovery-panel" aria-live="polite"><div className="section-heading"><div><h3>恢复条件核验</h3><p>只核验原绑定，不会更换执行器、创建新 Thread 或迁移工作区。</p></div>{recoveryResult?.checkedAt && <small>检测于 {formatDateTime(recoveryResult.checkedAt)}</small>}</div><RecoveryCheckList checks={checks} />
      {recoveryResult?.recovered && <div className="recovery-feedback success"><CheckCircle2 size={18} /><div><strong>固定环境已恢复</strong><span>聊天记忆已解除阻塞；关联任务不会自动重试，请回到任务中心手动继续。</span></div></div>}
      {recoveryResult && !recoveryResult.recovered && <div className="recovery-feedback failed"><AlertTriangle size={18} /><div><strong>仍有条件不一致</strong><span>聊天记忆保持阻塞。请恢复原执行器环境后再次检测。</span></div></div>}
      {recovery.error && <ErrorBox error={recovery.error} />}
      <div className="recovery-actions"><button className="primary-button" disabled={recovery.isPending || recoveryResult?.recovered} onClick={() => recovery.mutate()}><RotateCcw size={16} />{recovery.isPending ? "正在检测固定环境…" : recoveryResult?.recovered ? "已恢复" : "检测并恢复"}</button><NavLink className="secondary-button" to={taskLink}>{taskLinkLabel}</NavLink></div>
    </section>}
    {state === "ready" && recoveryResult?.recovered && <div className="recovery-feedback success" aria-live="polite"><CheckCircle2 size={18} /><div><strong>恢复完成</strong><span>关联任务未自动重试，可前往任务中心确认后继续。</span></div><NavLink className="secondary-button" to={taskLink}>{taskLinkLabel}</NavLink></div>}
    <div className="layered-sections memory-layered-sections">
      <details><summary><HardDrive size={17} /><span><strong>技术绑定信息</strong><small>Thread、执行环境与独立聊天工作区</small></span><ChevronDown size={17} /></summary><dl className="layered-detail-list two-column"><Detail label="Chat Context ID" value={d.id} /><Detail label="Chat ID" value={d.chatId} /><Detail label="Codex Thread" value={d.threadId ?? "首次执行时建立"} /><Detail label="固定执行器" value={d.executorId ?? "首次执行时固定"} /><Detail label="Codex Profile" value={d.executorProfile ?? "首次执行时固定"} /><Detail label="Codex 版本" value={d.codexVersion} /><Detail label="总工作区" value={d.workspaceRootAlias ?? "首次执行时固定"} /><Detail label="聊天工作区" value={d.workspaceKey ? `${d.workspaceRootAlias ?? "<总工作区>"}/${d.botAppId}/chats/${d.workspaceKey}` : null} /><Detail label="配置指纹" value={d.executorConfigFingerprint} /><Detail label="首次绑定时间" value={formatDateTime(d.createdAt)} /><Detail label="最后活动" value={formatDateTime(d.lastActivityAt)} /></dl></details>
      <details><summary><ShieldCheck size={17} /><span><strong>自动压缩记录 · {Number(d.autoCompactionCount ?? 0)} 次</strong><small>压缩上下文但不更换 Thread 或工作区</small></span><ChevronDown size={17} /></summary><div className="chat-compaction-history compact">{d.compactions?.length ? <div>{d.compactions.map((item: AnyRecord) => <article key={item.id}><div><span>{formatDateTime(item.occurredAt)}</span><strong className="mono">Turn {shortId(item.turnId) ?? "—"}</strong></div><small className="mono">Thread {shortId(item.threadId) ?? "—"}{item.itemId ? ` · Item ${shortId(item.itemId)}` : ""}</small></article>)}</div> : <Empty icon={<FileClock />} title="尚未观测到自动压缩" text="Codex 触发原生上下文压缩后会显示在这里。" />}</div></details>
    </div>
  </div>;
}

function RecoveryCheckList({ checks }: { checks: AnyRecord[] }) {
  return <div className="recovery-check-list">{checks.map((item: AnyRecord) => {
    const passed = ["pass", "passed", "success", "matched", "match", "ready", "ok"].includes(item.state);
    const checking = ["checking", "pending", "running"].includes(item.state);
    return <div className={passed ? "passed" : checking ? "checking" : "failed"} key={item.key}><span>{passed ? <CheckCircle2 size={17} /> : checking ? <RefreshCw className={item.state === "checking" ? "spin" : ""} size={17} /> : <AlertTriangle size={17} />}</span><strong>{item.label}</strong><small>{item.detail}</small><b>{passed ? "一致" : checking ? (item.state === "checking" ? "检测中" : "待检测") : "不一致"}</b></div>;
  })}</div>;
}

function StateText({ state }: { state: string }) {
  return <span className={`state-text state-${state}`}>{chatContextStateLabel(state)}</span>;
}

function chatContextStateLabel(state: string): string {
  return state === "ready" ? "已绑定" : state === "blocked" ? "已阻塞" : state === "uninitialized" ? "待初始化" : displayState(state);
}

function formatDateTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

function PermissionBadge({ bot }: { bot: AnyRecord }) {
  const missing = bot.permissionCheck?.items?.filter((item: AnyRecord) => item.status === "missing").length ?? 0;
  const label = bot.permissionState === "valid" ? "权限完整" : bot.permissionState === "missing" ? `缺少 ${missing} 项权限` : bot.permissionState === "error" ? "权限检测失败" : "权限未检测";
  return <span className={`permission-badge permission-${bot.permissionState ?? "unchecked"}`}>{bot.permissionState === "valid" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{label}</span>;
}

function PermissionAlert({ bot }: { bot: AnyRecord }) {
  const missing = bot.permissionCheck?.items?.filter((item: AnyRecord) => item.status === "missing").map((item: AnyRecord) => item.label) ?? [];
  const text = bot.permissionState === "missing"
    ? `缺少：${missing.join("、")}。在飞书开发者后台开通权限并发布应用版本后重新检测。`
    : bot.permissionState === "error"
      ? `无法读取应用权限：${bot.permissionCheck?.error ?? "未知错误"}`
      : "尚未读取该应用的权限。已有机器人可继续运行，但建议立即检测并补齐必需权限。";
  return <div className="bot-runtime-alert permission-alert"><AlertTriangle size={17} /><div><strong>应用权限未确认</strong><span>{text}</span></div></div>;
}

function explainBotRuntimeError(error?: string | null): string {
  if (!error) return "消息长连接未就绪。可以重新连接；如果仍失败，请检查飞书事件订阅和应用权限。";
  if (/another event bus is already connected/i.test(error)) return "飞书平台检测到该应用还有另一个消息长连接。请停止占用连接的机器或进程，等待平台释放后再重新连接，避免消息被重复消费。";
  if (/not subscribed/i.test(error)) return "飞书开发者后台尚未订阅所需的消息事件。完成订阅并发布应用版本后，再重新连接。";
  if (/consumer exited with 2/i.test(error)) return "启动检查未通过（退出码 2）。常见原因是消息事件尚未订阅或配置刚修改尚未生效；可以先重新连接。";
  if (/consumer exited with 3/i.test(error)) return "机器人认证失败（退出码 3）。请检查或轮换 App Secret 后重试。";
  return error;
}

function AddBotDialog({ user, workers, onClose, onCreated }: { user: AdminUser; workers: AnyRecord[]; onClose(): void; onCreated(bot: AnyRecord): void }) {
  const [form, setForm] = useState({ displayName: "", appId: "", appSecret: "", roleInstructions: "", defaultExecutorId: "", defaultWorkspaceAlias: "", attentionModel: "", attentionReasoningEffort: "", executionModel: "", executionReasoningEffort: "" });
  const aliases = availableWorkspaceAliases(workers, form.defaultExecutorId);
  const mutation = useMutation({ mutationFn: () => api<AnyRecord>("/v1/admin/bots", { method: "POST", body: JSON.stringify(normalizeBotForm(form)) }, user), onSuccess: onCreated });
  return <Modal title="添加飞书机器人" onClose={onClose}><p>App Secret 只会通过 HTTPS 写入服务器上的 lark-cli profile，控制台和数据库不会保存或再次显示。添加时会自动验证凭据并检查完整应用权限；权限不完整时会保留机器人配置但暂不启用，补齐并发布应用版本后可重新检测。</p><div className="bot-form"><label>显示名称<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="例如：项目助理" /></label><label>App ID<input value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} placeholder="cli_xxx" /></label><label>App Secret<input type="password" autoComplete="new-password" value={form.appSecret} onChange={(e) => setForm({ ...form, appSecret: e.target.value })} /></label><label className="span-2">角色提示词<textarea rows={5} value={form.roleInstructions} onChange={(e) => setForm({ ...form, roleInstructions: e.target.value })} placeholder="描述这个机器人负责什么、如何回答。只对新会话生效。" /></label><label>默认执行器<select value={form.defaultExecutorId} onChange={(e) => { const executorId = e.target.value; const nextAliases = availableWorkspaceAliases(workers, executorId); setForm({ ...form, defaultExecutorId: executorId, defaultWorkspaceAlias: nextAliases.includes(form.defaultWorkspaceAlias) ? form.defaultWorkspaceAlias : "" }); }}><option value="">自动选择</option>{workers.map((worker) => <option key={worker.executor_id} value={worker.executor_id}>{worker.display_name}</option>)}</select></label><label>默认总工作区<select value={form.defaultWorkspaceAlias} onChange={(e) => setForm({ ...form, defaultWorkspaceAlias: e.target.value })}><option value="">自动选择（仅单总工作区）</option>{aliases.map((alias) => <option key={alias}>{alias}</option>)}</select></label><ModelPolicyFields form={form} setForm={setForm} workers={workers} /></div>{mutation.error && <ErrorBox error={mutation.error} />}<div className="modal-actions"><button className="ghost-button" onClick={onClose}>取消</button><button className="primary-button" disabled={mutation.isPending || !form.displayName || !form.appId || !form.appSecret} onClick={() => mutation.mutate()}>{mutation.isPending ? "正在验证凭据与权限…" : "添加、检测权限并连接"}</button></div></Modal>;
}

function BotSettingsDialog({ user, bot, workers, onClose, onSaved }: { user: AdminUser; bot: AnyRecord; workers: AnyRecord[]; onClose(): void; onSaved(): void }) {
  const detail = useQuery({ queryKey: ["bot", bot.id], queryFn: () => api<AnyRecord>(`/v1/admin/bots/${bot.id}`), refetchInterval: (query) => query.state.data?.ownerBound ? false : 5_000 });
  const chats = useQuery({ queryKey: ["bot", bot.id, "chats"], queryFn: () => api<AnyRecord>(`/v1/admin/bots/${bot.id}/chats`), retry: false });
  const data = detail.data ?? bot;
  const [form, setForm] = useState({ displayName: bot.displayName, roleInstructions: bot.roleInstructions ?? "", defaultExecutorId: bot.defaultExecutorId ?? "", defaultWorkspaceAlias: bot.defaultWorkspaceAlias ?? "", attentionModel: bot.attentionModel ?? "", attentionReasoningEffort: bot.attentionReasoningEffort ?? "", executionModel: bot.executionModel ?? "", executionReasoningEffort: bot.executionReasoningEffort ?? "" });
  const [selected, setSelected] = useState<Set<string>>(new Set((bot.bindings ?? []).filter((x: AnyRecord) => x.enabled).map((x: AnyRecord) => x.chatId)));
  const [bindingCommand, setBindingCommand] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState("");
  const [manualChatId, setManualChatId] = useState("");
  const [manualChats, setManualChats] = useState<AnyRecord[]>([]);
  const aliases = availableWorkspaceAliases(workers, form.defaultExecutorId);
  useEffect(() => { if (chats.data?.items) setSelected(new Set(chats.data.items.filter((x: AnyRecord) => x.bound).map((x: AnyRecord) => x.chatId))); }, [chats.data]);
  const save = useMutation({ mutationFn: async () => { await api(`/v1/admin/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(normalizeBotForm(form)) }, user); const known = [...new Map([...(data.bindings ?? []).map((x: AnyRecord) => [x.chatId, { chatId: x.chatId, name: x.chatName, preferredExecutorId: x.preferredExecutorId, workspaceAlias: x.workspaceAlias }]), ...(chats.data?.items ?? []).map((x: AnyRecord) => [x.chatId, x]), ...manualChats.map((x: AnyRecord) => [x.chatId, x])]).values()] as AnyRecord[]; await api(`/v1/admin/bots/${bot.id}/chat-bindings`, { method: "PUT", body: JSON.stringify({ bindings: known.filter((x: AnyRecord) => selected.has(x.chatId)).map((x: AnyRecord) => ({ chatId: x.chatId, chatName: x.name ?? x.chatName ?? null, enabled: true, preferredExecutorId: x.preferredExecutorId ?? null, workspaceAlias: x.workspaceAlias ?? null })) }) }, user); }, onSuccess: onSaved });
  const command = useMutation({ mutationFn: (value: string) => api(`/v1/admin/bots/${bot.id}/commands`, { method: "POST", body: JSON.stringify({ command: value }) }, user), onSuccess: () => void detail.refetch() });
  const owner = useMutation({ mutationFn: () => api<AnyRecord>(`/v1/admin/bots/${bot.id}/owner-binding`, { method: "POST", body: "{}" }, user), onSuccess: (result) => setBindingCommand(result.command) });
  const credentials = useMutation({ mutationFn: () => api(`/v1/admin/bots/${bot.id}/credentials`, { method: "POST", body: JSON.stringify({ appSecret: newSecret }) }, user), onSuccess: () => { setNewSecret(""); void detail.refetch(); } });
  const permissionCheck = useMutation({ mutationFn: () => api(`/v1/admin/bots/${bot.id}/permission-check`, { method: "POST", body: "{}" }, user), onSuccess: () => void detail.refetch() });
  const remove = useMutation({ mutationFn: () => api(`/v1/admin/bots/${bot.id}`, { method: "DELETE" }, user), onSuccess: onSaved });
  return <Modal title={`配置 ${data.displayName}`} onClose={onClose}><div className="bot-form"><label>显示名称<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label><label>App ID<input value={data.appId} disabled /></label><label className="span-2">角色提示词<textarea rows={4} value={form.roleInstructions} onChange={(e) => setForm({ ...form, roleInstructions: e.target.value })} /></label><label>默认执行器<select value={form.defaultExecutorId} onChange={(e) => { const executorId = e.target.value; const nextAliases = availableWorkspaceAliases(workers, executorId); setForm({ ...form, defaultExecutorId: executorId, defaultWorkspaceAlias: nextAliases.includes(form.defaultWorkspaceAlias) ? form.defaultWorkspaceAlias : "" }); }}><option value="">自动选择</option>{workers.map((worker) => <option key={worker.executor_id} value={worker.executor_id}>{worker.display_name}</option>)}</select></label><label>默认总工作区<select value={form.defaultWorkspaceAlias} onChange={(e) => setForm({ ...form, defaultWorkspaceAlias: e.target.value })}><option value="">自动选择（仅单总工作区）</option>{aliases.map((alias) => <option key={alias}>{alias}</option>)}</select></label><ModelPolicyFields form={form} setForm={setForm} workers={workers} /></div><div className="workspace-isolation-note">聊天工作区模板：<code>{form.defaultWorkspaceAlias || "自动选择"}/{data.appId}/chats/&lt;Chat Context ID&gt;</code>。每个机器人与聊天各自使用一个 UUID 目录，在首次执行任务时由对应 Runner 安全创建。模型与推理强度修改仍按新会话快照生效，不会更换长期 Thread。</div>
    <BotPermissionSection bot={data} pending={permissionCheck.isPending} onCheck={() => permissionCheck.mutate()} />
    <section className="bot-settings-section"><strong>主人身份</strong><p>{data.ownerBound ? "已完成该飞书应用下的主人 Open ID 绑定。" : "尚未绑定。生成指令后，请在飞书中私聊该机器人发送。"}</p><button className="secondary-button" disabled={owner.isPending} onClick={() => owner.mutate()}>生成绑定指令</button>{bindingCommand && <div className="binding-command"><code>{bindingCommand}</code><CopyButton value={bindingCommand} label="复制" /></div>}</section>
    <section className="bot-settings-section"><strong>群绑定</strong>{chats.isLoading ? <PageLoading compact /> : chats.error ? <ErrorBox error={chats.error} /> : <div className="chat-checklist">{[...(chats.data?.items ?? []), ...manualChats].map((chat: AnyRecord) => <label key={chat.chatId}><input type="checkbox" checked={selected.has(chat.chatId)} onChange={(e) => { const next = new Set(selected); e.target.checked ? next.add(chat.chatId) : next.delete(chat.chatId); setSelected(next); }} /><span><strong>{chat.name ?? "手工添加的群"}</strong><small>{chat.chatId}</small></span></label>)}</div>}<div className="inline-field"><input value={manualChatId} onChange={(e) => setManualChatId(e.target.value)} placeholder="无法拉取时手工输入 chat_id" /><button className="secondary-button" disabled={!manualChatId.trim()} onClick={() => { const chatId = manualChatId.trim(); setManualChats((current) => current.some((item) => item.chatId === chatId) ? current : [...current, { chatId, name: "手工添加的群" }]); setSelected((current) => new Set([...current, chatId])); setManualChatId(""); }}>添加</button></div></section>
    {data.credentialRotatable && <section className="bot-settings-section"><strong>轮换 App Secret</strong><div className="inline-field"><input type="password" autoComplete="new-password" value={newSecret} onChange={(e) => setNewSecret(e.target.value)} placeholder="输入新 Secret" /><button className="secondary-button" disabled={!newSecret || credentials.isPending} onClick={() => credentials.mutate()}>更新凭据</button></div></section>}
    {(save.error || command.error || owner.error || credentials.error || permissionCheck.error || remove.error) && <ErrorBox error={save.error ?? command.error ?? owner.error ?? credentials.error ?? permissionCheck.error ?? remove.error} />}
    <div className="bot-control-row">{!data.isSystem && <button className="secondary-button" onClick={() => command.mutate("set_system")}>设为系统通知机器人</button>}{data.enabled ? <button className="danger-button" disabled={data.isSystem} onClick={() => window.confirm("停用后将不再接收新消息，确认继续？") && command.mutate("disable")}>停用接入</button> : <><button className="secondary-button" onClick={() => command.mutate("enable")}>重新启用</button><button className="danger-button" onClick={() => window.confirm("确认删除该机器人？历史任务仍会保留。") && remove.mutate()}>删除</button></>}</div>
    <div className="modal-actions"><button className="ghost-button" onClick={onClose}>关闭</button><button className="primary-button" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "保存中…" : "保存设置与群绑定"}</button></div></Modal>;
}

function BotPermissionSection({ bot, pending, onCheck }: { bot: AnyRecord; pending: boolean; onCheck(): void }) {
  const items = bot.permissionCheck?.items ?? [];
  const event = bot.eventSubscription ?? { state: "pending", label: "等待消息长连接验证" };
  return <section className="bot-settings-section permission-section"><div className="permission-section-head"><div><strong>应用权限与事件订阅</strong><p>权限由飞书应用授权接口实时读取；消息事件订阅由真实长连接状态单独验证。</p></div><button className="secondary-button" disabled={pending} onClick={onCheck}><RefreshCw size={15} />{pending ? "检测中…" : bot.permissionState === "unchecked" ? "检测权限" : "重新检测"}</button></div>
    {bot.permissionCheckedAt && <small className="permission-checked-at">上次检测：{relativeTime(bot.permissionCheckedAt)}</small>}
    {items.length ? <div className="permission-checklist">{items.map((item: AnyRecord) => <div key={item.key} className={item.status}>{item.status === "granted" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<div><strong>{item.label}</strong><span>{item.description}</span><code>{item.status === "granted" ? item.matchedScopes.join(" + ") : item.alternatives?.[0]?.join(" + ")}</code></div><b>{item.status === "granted" ? "已开通" : item.status === "missing" ? "缺失" : "未确认"}</b></div>)}</div> : <p className="permission-empty">尚未检测。点击“检测权限”读取当前已发布应用版本的实际授权状态。</p>}
    <div className={`event-subscription-row event-${event.state}`}>{event.state === "ready" ? <CheckCircle2 size={17} /> : <WifiOff size={17} />}<div><strong>接收消息事件</strong><span>{event.label}</span>{event.error && <code>{explainBotRuntimeError(event.error)}</code>}</div><b>{event.state === "ready" ? "正常" : event.state === "error" ? "异常" : "待验证"}</b></div>
  </section>;
}

function Overview() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<AnyRecord>("/v1/admin/overview") });
  const recentTasks = useQuery({ queryKey: ["task", "overview-recent"], queryFn: () => api<AnyRecord>("/v1/admin/tasks?limit=7") });
  if (!overview.data) return <PageLoading />;
  const d = overview.data; const states = d.taskStates ?? {};
  const active = ["queued", "waiting_worker", "running", "waiting_input", "waiting_approval", "held_draft", "human_owned"].reduce((n, key) => n + (states[key] ?? 0), 0);
  const botObjects = (d.bots ?? []).map((bot: AnyRecord) => {
    const messageReady = Boolean(bot.message?.ready);
    const rowState = !bot.enabled ? "neutral" : messageReady && bot.credentialState === "verified" && bot.permissionState === "valid" ? "normal" : "warning";
    return { ...bot, messageReady, rowState };
  });
  const workerObjects = d.workers.map((worker: AnyRecord) => ({
    ...worker,
    rowState: worker.operationalMode === "enabled" && worker.availability === "online" && worker.credentialActive ? "normal" : "warning"
  }));
  const objectWarnings = [...botObjects, ...workerObjects].filter((item: AnyRecord) => item.rowState === "warning").length;
  const attention = Number(d.pendingApprovals ?? 0) + Number(d.outboxUnknown ?? 0) + Number(d.incidents?.length ?? 0) + objectWarnings;
  const healthy = !d.incidents?.length && objectWarnings === 0;
  return <><PageTitle eyebrow="实时态势" title="运行总览" description="先看系统结论，再按运行对象和最近任务逐层下钻。" action={<Freshness />} />
    <section className={`overview-verdict ${healthy ? "healthy" : "attention"}`}><span className="verdict-icon">{healthy ? <CheckCircle2 size={30} /> : <AlertTriangle size={30} />}</span><div><small>系统判定</small><strong>{healthy ? "系统运行正常，正在处理任务" : "系统仍在运行，有事项需要关注"}</strong><p>{healthy ? "所有核心能力可用，暂未发现会阻断处理的问题。" : `${attention} 个当前事项需要确认；其余链路继续运行。`}</p></div><span className="verdict-refresh">最近更新：刚刚 <RefreshCw size={14} /></span></section>
    <section className="panel overview-objects"><PanelHead title="运行对象" subtitle="逐个查看机器人与执行器；每项只保留独立健康维度" /><div className="object-groups">
      <section className="object-group"><h3><Bot size={18} />机器人 <span>{botObjects.length}</span></h3><div className="entity-health-list">{botObjects.map((bot: AnyRecord) => <NavLink to={`/bots?bot=${bot.id}`} className={`entity-health-row ${bot.rowState}`} key={bot.id}><span className={`object-icon ${bot.rowState}`}><Bot size={21} /></span><span className="entity-health-primary"><span><strong>{bot.displayName}</strong><b className={`health-label ${bot.rowState}`}><StatusDot state={bot.rowState} />{bot.rowState === "normal" ? "正常运行" : bot.rowState === "neutral" ? "已停用" : "需要关注"}</b></span><small>{bot.isSystem ? "系统通知机器人" : "业务机器人"}</small></span><span className="health-dimension"><small>应用权限</small><b className={bot.permissionState === "valid" ? "normal" : bot.enabled ? "warning" : "neutral"}>{bot.permissionState === "valid" ? "已授权" : bot.permissionState === "missing" ? "需补齐" : "待核验"}</b></span><span className="health-dimension"><small>凭据状态</small><b className={bot.credentialState === "verified" ? "normal" : bot.enabled ? "warning" : "neutral"}>{bot.credentialState === "verified" ? "有效" : "需更新"}</b></span><span className="health-dimension"><small>启用意图</small><b className={bot.enabled ? "normal" : "neutral"}>{bot.enabled ? "已启用" : "已停用"}</b></span><span className="health-dimension"><small>消息事件</small><b className={bot.messageReady ? "normal" : bot.enabled ? "warning" : "neutral"}>{bot.messageReady ? "已订阅" : bot.enabled ? "待验证" : "未启用"}</b></span><ChevronRight size={17} /></NavLink>)}</div></section>
      <section className="object-group"><h3><Server size={18} />执行器 <span>{workerObjects.length}</span></h3><div className="entity-health-list">{workerObjects.map((worker: AnyRecord) => <NavLink to="/workers" className={`entity-health-row ${worker.rowState}`} key={worker.executorId}><span className={`object-icon ${worker.rowState}`}><Server size={21} /></span><span className="entity-health-primary"><span><strong>{worker.displayName}</strong><b className={`health-label ${worker.rowState}`}><StatusDot state={worker.rowState} />{worker.rowState === "normal" ? "在线可用" : "需要关注"}</b></span><small>{worker.profile ? `Codex Profile · ${worker.profile}` : "等待 Profile 上报"}</small></span><span className="health-dimension"><small>在线状态</small><b className={worker.availability === "online" ? "normal" : "warning"}>{displayState(worker.availability)}</b></span><span className="health-dimension"><small>领取模式</small><b className={worker.operationalMode === "enabled" ? "normal" : "warning"}>{displayState(worker.operationalMode)}</b></span><span className="health-dimension"><small>设备凭据</small><b className={worker.credentialActive ? "normal" : "warning"}>{worker.credentialActive ? "有效" : "无效"}</b></span><span className="health-dimension"><small>最近心跳</small><b className={worker.availability === "online" ? "normal" : "warning"}>{relativeTime(worker.lastSeenAt)}</b></span><ChevronRight size={17} /></NavLink>)}</div></section>
    </div></section>
    <details className="panel overview-attention"><summary><span><AlertTriangle size={17} /><span><strong>需要关注（{attention}）</strong><small>{objectWarnings} 个运行对象异常 · {d.pendingApprovals ?? 0} 个待审批 · {d.outboxUnknown ?? 0} 个发送结果待确认 · {d.incidents?.length ?? 0} 个故障</small></span></span><ChevronDown size={17} /></summary><div className="attention-list"><NavLink to="/pending?type=approval"><Clock3 size={18} /><span><strong>{d.pendingApprovals ?? 0}</strong><small>待审批任务</small></span><ChevronRight size={16} /></NavLink><NavLink to="/pending?type=outbox"><AlertTriangle size={18} /><span><strong>{d.outboxUnknown ?? 0}</strong><small>发送结果不确定</small></span><ChevronRight size={16} /></NavLink><NavLink to="/incidents"><ShieldCheck size={18} /><span><strong>{d.incidents?.length ?? 0}</strong><small>未恢复故障 · {objectWarnings} 个对象异常</small></span><ChevronRight size={16} /></NavLink></div></details>
    <section className="panel recent-task-panel"><PanelHead title="最近任务" subtitle="低密度浏览当前进展，点击任务查看八阶段链路" link="/tasks" />{recentTasks.data?.items?.length ? <div className="recent-task-list">{recentTasks.data.items.map((item: AnyRecord) => <NavLink to={`/tasks/${item.id}`} key={item.id}><span><strong>{item.summary || item.latest_signal_content || `第 ${item.turn_index} 回合消息处理`}</strong><small>{item.bot_display_name} · {item.chat_type === "p2p" ? "私聊" : "群聊"} · 任务 {shortId(item.id)}</small></span><StateBadge state={item.state} /><span><small>执行器</small><strong>{item.executor_id ?? "等待分配"}</strong></span><time>{relativeTime(item.updated_at)}</time><ChevronRight size={17} /></NavLink>)}</div> : <Empty icon={<Inbox />} title="还没有任务" text="机器人收到有效消息后，最近任务会显示在这里。" />}</section>
  </>;
}

function Flow() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const view = params.get("view") ?? "flow";
  const range = params.get("range") ?? "24h";
  const stage = params.get("stage") ?? "";
  const state = params.get("state") ?? "";
  const chatType = params.get("chat_type") ?? "";
  const executor = params.get("executor") ?? "";
  const workspace = params.get("workspace") ?? "";
  const bot = params.get("bot") ?? "";
  const before = params.get("before") ?? "";
  const q = params.get("q") ?? "";
  const summary = useQuery({ queryKey: ["flow", "summary", range], queryFn: () => api<AnyRecord>(`/v1/admin/flow/summary?range=${range}`), refetchInterval: 30_000 });
  const bots = useQuery({ queryKey: ["bot", "flow-filter"], queryFn: () => api<AnyRecord>("/v1/admin/bots") });
  const query = new URLSearchParams({ view, range, ...(stage && { stage }), ...(state && { state }), ...(chatType && { chat_type: chatType }), ...(executor && { executor }), ...(workspace && { workspace }), ...(bot && { bot }), ...(q && { q }), ...(before && { before }) });
  const items = useQuery({ queryKey: ["flow", "items", query.toString()], queryFn: () => api<AnyRecord>(`/v1/admin/flow/items?${query}`), refetchInterval: 30_000 });
  const stageItems = summary.data?.stages ?? [];
  const activeStageCount = stageItems.reduce((total: number, item: AnyRecord) => total + Number(item.active ?? 0), 0);
  const abnormalStageCount = stageItems.reduce((total: number, item: AnyRecord) => total + Number(item.failed ?? 0) + Number(item.warnings ?? 0), 0);
  const update = (next: Record<string, string>) => setParams({ view, range, ...(stage && { stage }), ...(state && { state }), ...(chatType && { chat_type: chatType }), ...(executor && { executor }), ...(workspace && { workspace }), ...(bot && { bot }), ...(q && { q }), ...next });
  const nextPage = () => items.data?.nextCursor && setParams(new URLSearchParams({ ...Object.fromEntries(query), before: items.data.nextCursor }));
  return <div className="task-flow-workspace">
    <details className="flow-overview-details"><summary><span><GitBranch size={17} /><span><strong>全链路概况</strong><small>八阶段数量与耗时按需展开，不遮挡正在处理的任务</small></span></span><span className={abnormalStageCount ? "warning" : "normal"}>{summary.data ? `${activeStageCount} 个处理中 · ${abnormalStageCount} 个异常` : "正在汇总"}</span><ChevronDown size={17} /></summary><div className="flow-overview-body"><section className="flow-stage-strip">{stageItems.map((item: AnyRecord, index: number) => <div className="flow-stage-wrap" key={item.stage}><button className={`flow-stage-card ${stage === item.stage ? "selected" : ""} ${item.failed ? "failed" : item.warnings ? "warning" : ""}`} onClick={() => update({ view: "flow", stage: stage === item.stage ? "" : item.stage })}><span>{flowStageLabel[item.stage] ?? item.stage}</span><strong>{item.active}</strong><small>通过 {item.passed} · 异常 {item.failed + item.warnings}</small><small>{item.oldestWaitingSeconds == null ? "无等待" : `最久 ${formatDuration(item.oldestWaitingSeconds)}`}</small></button>{index < stageItems.length - 1 && <ArrowRight className="flow-arrow" size={18} />}</div>)}</section><section className="latency-summary">{(summary.data?.latencyStages ?? []).map((item: AnyRecord) => <div key={item.key}><span>{item.label}</span><strong>{item.p50Seconds == null ? "暂无" : `P50 ${formatDurationPrecise(item.p50Seconds)}`}</strong><small>{item.p95Seconds == null ? "尚无完整样本" : `P95 ${formatDurationPrecise(item.p95Seconds)} · ${item.count} 个样本`}</small></div>)}</section></div></details>
    <div className="flow-toolbar"><select aria-label="时间范围" value={range} onChange={(e) => update({ range: e.target.value })}><option value="1h">最近 1 小时</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="all">全部</option></select><select aria-label="机器人筛选" value={bot} onChange={(e) => update({ bot: e.target.value })}><option value="">全部机器人</option>{bots.data?.items?.map((item: AnyRecord) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><select aria-label="会话类型" value={chatType} onChange={(e) => update({ chat_type: e.target.value })}><option value="">全部会话</option><option value="p2p">私聊</option><option value="group">群聊</option></select><select aria-label="流水状态" value={state} onChange={(e) => update({ state: e.target.value })}><option value="">全部状态</option>{(view === "inbox" ? ["pending", "consume", "merge", "defer", "dismiss"] : view === "outbox" ? ["pending", "sent", "unknown", "failed", "discarded"] : Object.keys(stateLabel)).map((key) => <option key={key} value={key}>{displayState(key)}</option>)}</select><div className="search compact"><Search size={17} /><input aria-label="搜索流水" placeholder="正文、任务或会话 ID" defaultValue={q} onKeyDown={(e) => e.key === "Enter" && update({ q: e.currentTarget.value })} /></div><details className="flow-advanced"><summary>更多筛选</summary><div><input aria-label="执行器筛选" placeholder="executor_id" defaultValue={executor} onKeyDown={(e) => e.key === "Enter" && update({ executor: e.currentTarget.value })} /><input aria-label="总工作区筛选" placeholder="总工作区别名" defaultValue={workspace} onKeyDown={(e) => e.key === "Enter" && update({ workspace: e.currentTarget.value })} /></div></details></div>
    {!items.data ? <PageLoading /> : <>{view === "inbox" ? <InboxFlow items={items.data.items} onTask={(id) => navigate(`/tasks/${id}`)} /> : view === "outbox" ? <OutboxFlow items={items.data.items} onTask={(id) => navigate(`/tasks/${id}`)} onPending={() => navigate("/pending")} /> : <div className="flow-run-list">{items.data.items.length ? items.data.items.map((item: AnyRecord, index: number) => <FlowRun key={item.id} item={item} defaultOpen={index === 0} onOpen={() => navigate(`/tasks/${item.id}`)} />) : <Empty icon={<GitBranch />} title="当前范围没有处理记录" text="调整时间或阶段筛选后再试。" />}</div>}{items.data.nextCursor && <div className="flow-pagination"><button className="secondary-button" onClick={nextPage}>查看更早记录</button></div>}</>}
  </div>;
}

function FlowRun({ item, defaultOpen, onOpen }: { item: AnyRecord; defaultOpen: boolean; onOpen(): void }) {
  const [open, setOpen] = useState(defaultOpen);
  const cells = [
    { key: "message", title: "消息", state: item.signal ? "received" : "missing", body: item.signal?.content ?? "没有 Signal", attachments: item.signal?.attachments, meta: item.signal ? `${signalSenderLabel(item.signal)} · ${item.signal.ingress_source ?? "lark"} · depth ${item.signal.bot_dialogue_depth ?? 0} · origin ${shortId(item.signal.origin_message_id)}` : null },
    { key: "inbox", title: "收件箱", state: item.signal ? "received" : "pending", body: item.signal ? `已建立 ${item.signalCount ?? 1} 条 Signal` : "等待建立 Signal", meta: item.signal ? `任务 ${shortId(item.id)} · 回合 ${item.turn_index}` : null },
    { key: "attention", title: "注意力", state: item.signal?.decision ?? "pending", body: decisionLabel[item.signal?.decision] ?? "待判断", meta: item.signal?.decision_rationale },
    { key: "routing", title: "路由", state: item.chat_context_state === "blocked" ? "blocked" : item.executor_id ? "ready" : item.state, body: item.chat_context_state === "blocked" ? "固定环境核验未通过" : item.executor_id ? `已路由至 ${item.executor_id}` : "等待执行器", meta: [workspaceLabel(item), item.executor_profile].filter(Boolean).join(" · ") || null },
    { key: "codex", title: "Codex", state: item.state, body: stateLabel[item.state] ?? item.state, meta: [item.codex_thread_id && `thread ${shortId(item.codex_thread_id)}`, item.executor_config_fingerprint && `cfg ${shortId(item.executor_config_fingerprint)}`, item.lease_expires_at && `lease ${new Date(item.lease_expires_at).toLocaleTimeString("zh-CN")}`].filter(Boolean).join(" · ") || "尚未建立 Thread" },
    { key: "draft", title: "草稿", state: item.draft?.state ?? "skipped", body: item.draft?.content ?? (item.signal?.decision === "dismiss" ? "静默跳过" : "尚无草稿"), meta: item.draft ? `room ${item.draft.base_room_seq} → ${item.draft.observed_room_seq} · held ${item.draft.hold_count}` : null },
    { key: "outbox", title: "发件箱", state: item.outbox?.state ?? item.output?.state ?? "skipped", body: item.outbox?.content ?? item.output?.current_content ?? "尚无输出", meta: [item.output?.transport, item.output && `seq ${item.output.sequence}`, item.outbox?.platform_message_id].filter(Boolean).join(" · ") || null },
    { key: "reply", title: "回复", state: item.conversation_disposition ?? item.state, body: item.conversation_disposition === "awaiting_followup" ? "等待续聊" : item.conversation_disposition === "complete" ? "会话结束" : stateLabel[item.state], meta: [item.disposition_reason, item.followup_expires_at && `截止 ${new Date(item.followup_expires_at).toLocaleString("zh-CN")}`].filter(Boolean).join(" · ") || null }
  ];
  const stages = Object.entries(flowStageLabel);
  const currentIndex = Math.max(0, stages.findIndex(([key]) => key === item.currentStage));
  return <details className={`flow-run health-${item.health}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="flow-run-summary"><span className="flow-run-identity"><strong>{item.signal?.content || `任务 ${item.id.slice(0, 8)}`}</strong><small>{item.bot_display_name} · {item.chat_type === "group" ? "群聊" : "私聊"} · 第 {item.turn_index} 回合</small></span><span className="flow-run-stage"><small>当前阶段</small><strong>{flowStageLabel[item.currentStage] ?? item.currentStage}（{currentIndex + 1}/8）</strong></span><StateBadge state={item.state} /><span className="flow-run-executor"><small>执行器</small><strong>{item.executor_id ?? "等待分配"}</strong></span><time className="flow-run-time">{relativeTime(item.updated_at)}</time><ChevronDown size={17} /></summary><div className="flow-run-expanded"><div className="task-stage-track compact-flow-track">{stages.map(([key, label], index) => { const complete = item.state === "completed" || index < currentIndex; const current = item.state !== "completed" && index === currentIndex; const abnormal = current && ["failed", "warning"].includes(item.health); return <div className={`task-stage ${complete ? "complete" : current ? abnormal ? "abnormal" : "current" : "future"}`} key={key}><span className="stage-node">{complete ? <Check size={16} /> : index + 1}</span><strong>{label}</strong>{index < stages.length - 1 && <span className="stage-line" />}</div>; })}</div><div className="flow-run-conclusion"><span><strong>{flowStageLabel[item.currentStage] ?? item.currentStage}</strong><small>{item.chat_context_state === "blocked" ? "固定聊天环境核验未通过，任务已安全停在路由阶段。" : item.bottleneck ? `主要耗时：${item.bottleneck.label} ${formatDurationPrecise(item.bottleneck.durationSeconds)}` : `最近更新 ${relativeTime(item.updated_at)}`}</small></span><button className="secondary-button" onClick={onOpen}>查看完整诊断 <ChevronRight size={15} /></button></div><details className="flow-technical-preview"><summary>查看八阶段数据<ChevronDown size={15} /></summary><div className="flow-lane">{cells.map((cell, index) => <div className={`flow-cell ${item.currentStage === cell.key ? "current" : ""}`} key={cell.key}><div className="flow-cell-head"><span>{cell.title}</span><code>{cell.state}</code></div><p>{cell.body}</p><AttachmentBadges items={cell.attachments} />{cell.meta && <small title={cell.meta}>{cell.meta}</small>}{index < cells.length - 1 && <ArrowRight className="lane-arrow" size={16} />}</div>)}</div></details></div></details>;
}

function InboxFlow({ items, onTask }: { items: AnyRecord[]; onTask(id: string): void }) {
  return <article className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>信号</th><th>接收机器人</th><th>发送者</th><th>正文与附件</th><th>判断</th><th>因果链</th><th>耗时</th><th>Codex</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong className="mono">#{item.seq}</strong><small>{item.chat_type === "group" ? "群聊" : "私聊"} · 回合 {item.turn_index}</small><small className="mono">{shortId(item.message_id)}</small></td><td>{item.bot_display_name}</td><td>{signalSenderLabel(item)}<small>{item.ingress_source === "internal" ? "历史内部投递" : item.ingress_source === "history" ? "历史补偿" : "飞书事件"}</small></td><td><pre className="message-content">{item.content}</pre><AttachmentBadges items={item.attachments} /></td><td><StateBadge state={item.decision} /><small>{item.decision_rationale ?? "尚未判断"}</small></td><td>深度 {item.bot_dialogue_depth ?? 0}<small className="mono">origin {shortId(item.origin_message_id)}</small></td><td>{item.decisionSeconds == null ? "等待中" : formatDuration(item.decisionSeconds)}</td><td>{item.enteredCodex ? shortId(item.codex_thread_id) : "未进入"}</td><td><button className="icon-button" aria-label="查看任务" onClick={() => onTask(item.task_id)}><ChevronRight size={17} /></button></td></tr>)}</tbody></table></div></article>;
}

function OutboxFlow({ items, onTask, onPending }: { items: AnyRecord[]; onTask(id: string): void; onPending(): void }) {
  return <article className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>发件</th><th>机器人</th><th>最终正文</th><th>传输</th><th>版本</th><th>状态</th><th>平台回执</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong className="mono">{item.task_id.slice(0, 8)}</strong><small>回合 {item.turn_index} · 尝试 {item.attempt}</small><small className="mono">{shortId(item.idempotency_key)}</small></td><td>{item.bot_display_name}</td><td><pre className="message-content">{item.content}</pre>{item.last_error && <small className="text-danger">{item.last_error}</small>}</td><td>{item.transport ?? item.operation_kind}<small>{item.card_id ? `card ${shortId(item.card_id)}` : ""}</small></td><td>seq {item.sequence ?? "—"}<small>room {item.base_room_seq ?? "—"} → {item.observed_room_seq ?? "—"}</small></td><td><StateBadge state={item.state} /><small>{item.deliverySeconds == null ? relativeTime(item.created_at) : formatDuration(item.deliverySeconds)}</small>{item.state === "unknown" && <button className="flow-action-link" onClick={onPending}>前往处置</button>}{item.state === "failed" && <small>请进入任务诊断</small>}</td><td className="mono">{shortId(item.platform_message_id) ?? "—"}</td><td><button className="icon-button" aria-label="查看任务" onClick={() => onTask(item.task_id)}><ChevronRight size={17} /></button></td></tr>)}</tbody></table></div></article>;
}

function Tasks() {
  const [params, setParams] = useSearchParams(); const navigate = useNavigate();
  const view = params.get("view") ?? "flow";
  const state = params.get("state") ?? ""; const q = params.get("q") ?? ""; const bot = params.get("bot") ?? ""; const chatContextId = params.get("chatContextId") ?? "";
  const bots = useQuery({ queryKey: ["bot", "task-filter"], queryFn: () => api<AnyRecord>("/v1/admin/bots") });
  const tasks = useQuery({ queryKey: ["task", "list", state, bot, q, chatContextId], queryFn: () => api<AnyRecord>(`/v1/admin/tasks?${new URLSearchParams({ ...(state && { state }), ...(bot && { bot }), ...(q && { q }), ...(chatContextId && { chatContextId }) })}`) });
  const visibleTasks = tasks.data?.items ?? [];
  const switchView = (next: string) => setParams({ view: next, ...(next === "tasks" && bot ? { bot } : {}) });
  return <><PageTitle eyebrow="工作流" title="任务中心" description="任务、收件、发件与链路诊断在同一处按需展开。" action={<Freshness />} />
    <div className="task-center-tabs" role="tablist" aria-label="任务中心视图">{[["flow", "正在处理", GitBranch], ["tasks", "全部任务", Inbox], ["inbox", "Agent 收件箱", MessageCircle], ["outbox", "发件箱", ArrowRight]].map(([key, label, Icon]) => { const TabIcon = Icon as typeof Inbox; return <button key={key as string} role="tab" aria-selected={view === key} className={view === key ? "active" : ""} onKeyDown={moveTabFocus} onClick={() => switchView(key as string)}><TabIcon size={16} />{label as string}</button>; })}</div>
    {view === "tasks" ? <><div className="filterbar"><div className="search"><Search size={18} /><input aria-label="搜索任务" placeholder="输入任务 ID 或会话 ID" defaultValue={q} onKeyDown={(e) => { if (e.key === "Enter") setParams({ view: "tasks", ...(state && { state }), ...(bot && { bot }), ...(chatContextId && { chatContextId }), ...((e.currentTarget.value) && { q: e.currentTarget.value }) }); }} /></div><select aria-label="机器人" value={bot} onChange={(e) => setParams({ view: "tasks", ...(state && { state }), ...(e.target.value && { bot: e.target.value }), ...(q && { q }), ...(chatContextId && { chatContextId }) })}><option value="">全部机器人</option>{bots.data?.items?.map((item: AnyRecord) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><select aria-label="任务状态" value={state} onChange={(e) => setParams({ view: "tasks", ...(e.target.value && { state: e.target.value }), ...(bot && { bot }), ...(q && { q }), ...(chatContextId && { chatContextId }) })}><option value="">全部状态</option>{Object.entries(stateLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      {chatContextId && <div className="active-filter-note"><ListFilter size={16} />仅显示当前聊天记忆的关联任务<button onClick={() => setParams({ view: "tasks", ...(bot && { bot }) })}>清除筛选</button></div>}
      <article className="panel table-panel">{!tasks.data ? <PageLoading compact /> : visibleTasks.length ? <div className="table-wrap"><table><thead><tr><th>任务</th><th>机器人</th><th>状态</th><th>当前阶段</th><th>专属工作区</th><th>执行器</th><th>更新时间</th><th /></tr></thead><tbody>{visibleTasks.map((task: AnyRecord) => <tr key={task.id} role="link" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") navigate(`/tasks/${task.id}`); }} onClick={() => navigate(`/tasks/${task.id}`)}><td><strong className="mono">{shortId(task.id)}</strong><small>{task.chat_type === "p2p" ? "私聊" : "群聊"} · 第 {task.turn_index} 回合</small></td><td>{task.bot_display_name}</td><td><StateBadge state={task.state} /></td><td>{task.current_stage ? flowStageLabel[task.current_stage] ?? task.current_stage : task.state === "completed" ? "飞书回复" : "按需诊断"}</td><td>{workspaceLabel(task)}</td><td>{task.executor_id ?? "等待分配"}</td><td>{relativeTime(task.updated_at)}</td><td><button className="icon-button" aria-label={`查看任务 ${shortId(task.id)} 的详情`}><ChevronRight size={17} /></button></td></tr>)}</tbody></table></div> : <Empty icon={<Inbox />} title="没有符合条件的任务" text="调整筛选条件后再试。" />}</article></> : <Flow />}
  </>;
}

function TaskDetail({ user }: { user: AdminUser }) {
  const { id = "" } = useParams(); const task = useQuery({ queryKey: ["task", id], queryFn: () => api<AnyRecord>(`/v1/admin/tasks/${id}`) });
  const timeline = useQuery({ queryKey: ["task", id, "timeline"], queryFn: () => api<AnyRecord>(`/v1/admin/tasks/${id}/timeline`) });
  const trace = useQuery({ queryKey: ["task", id, "trace"], queryFn: () => api<AnyRecord>(`/v1/admin/tasks/${id}/trace`) });
  const [dialog, setDialog] = useState<string | null>(null);
  if (task.error) return <ErrorBox error={task.error} />;
  if (!task.data) return <PageLoading />; const d = task.data;
  const blocked = d.chat_context_state === "blocked";
  const allowed = (d.state === "failed" || d.state === "waiting_input") && !blocked ? ["retry"] : d.state === "running" ? ["cancel", ...(d.worker?.capabilities?.includes("app_handoff") ? ["handoff"] : [])] : d.state === "human_owned" ? ["return_agent", "mark_completed"] : !["completed", "cancelled", "failed", "waiting_input"].includes(d.state) ? ["cancel"] : [];
  const memoryLink = `/bots/${d.bot_id}/chat-memory/${d.chat_context_id}`;
  const threadSame = Boolean(d.codex_thread_id && d.chat_context_thread_id && d.codex_thread_id === d.chat_context_thread_id);
  return <><div className="workspace-breadcrumb"><NavLink to="/tasks"><ArrowLeft size={16} />返回任务中心</NavLink><span>任务中心 / 任务 {shortId(id)}</span></div>
    <PageTitle eyebrow="任务详情" title={`任务 ${shortId(id)}`} description={`${d.bot_display_name} · ${d.chat_type === "p2p" ? "私聊" : (d.chat_name ?? "群聊")} · 第 ${d.turn_index} 回合 · ${relativeTime(d.created_at)}创建`} action={<StateBadge state={d.state} />} />
    {blocked && <div className="task-memory-blocked-banner"><AlertTriangle size={22} /><div><strong>聊天长期记忆已阻塞，任务停在路由阶段</strong><span>普通重试不会改变固定环境；先完成聊天记忆检测与恢复。</span></div><NavLink className="primary-button" to={memoryLink}>前往聊天记忆恢复</NavLink></div>}
    <section className="task-stage-panel"><div className="task-stage-heading"><div><strong>{taskStageProgress(d, trace.data).current + 1} / 8 · {blocked ? "已暂停" : stateLabel[d.state] ?? d.state}</strong><span>最近更新 {relativeTime(d.updated_at)} · 已尝试 {d.attempt} 次</span></div><div className="action-group">{allowed.map((command) => <button key={command} className={command === "cancel" ? "danger-button" : "secondary-button"} onClick={() => setDialog(command)}>{commandLabel(command)}</button>)}</div></div>
      <TaskStageCanvas task={d} trace={trace.data} />
      <div className="thread-comparison"><div><span>任务实际 Thread</span><strong className="mono" title={d.codex_thread_id}>{shortId(d.codex_thread_id) ?? "尚未建立"}</strong></div><div><span>聊天长期 Thread</span><strong className="mono" title={d.chat_context_thread_id}>{shortId(d.chat_context_thread_id) ?? "尚未建立"}</strong></div><div><span>状态</span><strong className={threadSame ? "thread-match" : "thread-note"}>{threadSame ? <><CheckCircle2 size={16} />相同，均保留</> : d.chat_context_thread_id ? "分别观测，不自动替换" : "等待首次固定"}</strong></div></div>
      <div className="task-context-strip"><span><Bot size={15} />{d.bot_display_name}</span><span>{d.chat_type === "group" ? <MessagesSquare size={15} /> : <UserRound size={15} />}{d.chat_type === "group" ? (d.chat_name ?? "群聊") : "私聊"}</span><span>第 {d.turn_index} 回合</span><span><HardDrive size={15} />{workspaceLabel(d)}</span></div>
    </section>
    <div className="task-diagnostic-layers">
      <details><summary><Timer size={18} /><span><strong>阶段耗时与瓶颈</strong><small>{trace.data?.bottleneck ? `${trace.data.bottleneck.label} · ${formatDurationPrecise(trace.data.bottleneck.durationSeconds)}` : "展开查看每个阶段耗时"}</small></span><ChevronDown size={17} /></summary><div className="diagnostic-layer-body">{trace.data ? <><div className="stage-timing-grid">{trace.data.stageTimings.map((item: AnyRecord) => <article className={`stage-timing state-${item.state}`} key={item.key}><span>{item.label}</span><strong>{item.durationSeconds == null ? item.state === "running" ? "进行中" : item.state === "skipped" ? "未产生" : "未经过" : formatDurationPrecise(item.durationSeconds)}</strong><small>{item.startedAt ? new Date(item.startedAt).toLocaleTimeString("zh-CN") : "—"} → {item.completedAt ? new Date(item.completedAt).toLocaleTimeString("zh-CN") : "—"}</small>{(item.model || item.effort) && <small>模型 {item.model ?? "继承 Profile"} · {item.effort ?? "默认强度"}</small>}{item.tokenUsage && <small>Token：输入 {item.tokenUsage.inputTokens ?? "—"} · 输出 {item.tokenUsage.outputTokens ?? "—"} · Reasoning {item.tokenUsage.reasoningOutputTokens ?? "—"}</small>}</article>)}</div>{trace.data.bottleneck && <div className="bottleneck-banner"><Clock3 size={17} /><strong>主要瓶颈：{trace.data.bottleneck.label}</strong><span>{formatDurationPrecise(trace.data.bottleneck.durationSeconds)}{trace.data.bottleneck.share != null ? `，约占端到端 ${Math.round(trace.data.bottleneck.share * 100)}%` : ""}</span></div>}</> : <PageLoading compact />}</div></details>
      <details><summary><Activity size={18} /><span><strong>链路诊断与时间线</strong><small>按需查看完整性检查和技术事件</small></span><ChevronDown size={17} /></summary><div className="diagnostic-layer-body"><PanelHead title="链路诊断" subtitle="检查每个阶段的数据完整性与上下游一致性" />{trace.data ? <div className="trace-check-grid">{trace.data.checks.map((item: AnyRecord, index: number) => <article className={`trace-check trace-${item.state}`} key={item.key}><div><span>{index + 1}</span><strong>{traceCheckLabel[item.key] ?? item.key}</strong><StateBadge state={item.state} /></div><p>{item.detail}</p><small>{item.startedAt ? new Date(item.startedAt).toLocaleTimeString("zh-CN") : "未开始"} → {item.completedAt ? new Date(item.completedAt).toLocaleTimeString("zh-CN") : "等待中"}{item.durationSeconds != null ? ` · ${formatDurationPrecise(item.durationSeconds)}` : ""}</small>{item.relatedIds?.length > 0 && <code title={item.relatedIds.join("\n")}>{item.relatedIds.map(shortId).join(" · ")}</code>}</article>)}</div> : <PageLoading compact />}<div className="diagnostic-divider" /><PanelHead title="任务时间线" subtitle="按收件、执行、草稿、发送和生命周期分组" />{timeline.data?.items?.length ? <TimelineGroups items={timeline.data.items} /> : <Empty icon={<Activity />} title="尚无执行事件" text="执行器领取后会在这里记录进展。" />}</div></details>
      <details><summary><Cpu size={18} /><span><strong>运行绑定与会话信息</strong><small>执行器、Profile、模型快照和会话回合</small></span><ChevronDown size={17} /></summary><div className="diagnostic-layer-body two-panel"><section><PanelHead title="Codex 绑定" subtitle="任务执行环境快照" />{d.route_mismatch && <div className="inline-alert"><AlertTriangle size={16} />机器人当前绑定 {d.bot_default_executor_id}，本任务保留创建时路由 {d.executor_id}。</div>}<dl className="layered-detail-list"><Detail label="机器人配置执行器" value={d.bot_default_executor_id} /><Detail label="任务实际执行器" value={d.executor_id} /><Detail label="Codex Home" value={d.executor_home_ref} /><Detail label="Profile" value={d.executor_profile} /><Detail label="配置指纹" value={d.executor_config_fingerprint} /><Detail label="注意力模型" value={formatModelPolicy(d.attention_model_snapshot, d.attention_reasoning_effort_snapshot)} /><Detail label="执行模型" value={formatModelPolicy(d.execution_model_snapshot, d.execution_reasoning_effort_snapshot)} /></dl></section><section><PanelHead title="会话回合" subtitle="聊天长期 Thread 连续处理" /><dl className="layered-detail-list">{d.conversation_turns?.map((turn: AnyRecord) => <Detail key={turn.id} label={`第 ${turn.turn_index} 回合 · ${stateLabel[turn.state] ?? turn.state}`} value={turn.conversation_disposition === "awaiting_followup" ? "等待续聊" : turn.conversation_disposition === "complete" ? "会话结束" : "处理中"} />)}<Detail label="请求者" value={`${d.requester_role === "owner" ? "主人" : "成员"} · ${d.requester_id}`} /><Detail label="续聊截止" value={d.followup_expires_at ? new Date(d.followup_expires_at).toLocaleString("zh-CN") : "—"} /><Detail label="状态版本" value={`revision ${d.revision}`} /></dl></section></div></details>
      <details><summary><Wrench size={18} /><span><strong>原始 Trace · 技术排障</strong><small>最深层数据；敏感凭据与租约令牌不会返回</small></span><ChevronDown size={17} /></summary><div className="diagnostic-layer-body">{trace.data ? <TraceData data={trace.data} /> : <PageLoading compact />}</div></details>
    </div>{dialog && <CommandDialog command={dialog} task={d} user={user} onClose={() => setDialog(null)} />}</>;
}

function taskStageProgress(task: AnyRecord, trace?: AnyRecord): { current: number; abnormal: boolean } {
  if (task.chat_context_state === "blocked") return { current: 3, abnormal: true };
  if (task.state === "completed") return { current: 7, abnormal: false };
  const abnormalCheck = trace?.checks?.findIndex((item: AnyRecord) => ["警告", "错误", "failed", "error"].includes(item.state)) ?? -1;
  const checkToStage = [0, 1, 2, 3, 4, 5, 6, 6, 7, 7];
  if (abnormalCheck >= 0) return { current: checkToStage[abnormalCheck] ?? 4, abnormal: true };
  if (["waiting_approval", "held_draft"].includes(task.state)) return { current: 5, abnormal: false };
  if (["running", "human_owned", "waiting_input", "failed"].includes(task.state)) return { current: 4, abnormal: task.state === "failed" };
  if (task.state === "waiting_worker") return { current: 3, abnormal: false };
  return { current: task.state === "queued" ? 1 : 0, abnormal: false };
}

function TaskStageCanvas({ task, trace }: { task: AnyRecord; trace?: AnyRecord | undefined }) {
  const stages = Object.entries(flowStageLabel);
  const progress = taskStageProgress(task, trace);
  const blocked = task.chat_context_state === "blocked";
  const executorCheck = trace?.checks?.find((item: AnyRecord) => item.key === "executor");
  return <div className="task-stage-canvas"><div className="task-stage-track">{stages.map(([key, label], index) => {
    const complete = task.state === "completed" || index < progress.current;
    const current = task.state !== "completed" && index === progress.current;
    return <div className={`task-stage ${complete ? "complete" : current ? progress.abnormal ? "abnormal" : "current" : "future"}`} key={key}><span className="stage-node">{complete ? <Check size={16} /> : index + 1}</span><strong>{label}</strong>{index < stages.length - 1 && <span className="stage-line" />}</div>;
  })}</div>{progress.abnormal && <div className="stage-cause-panel"><section><h3>进入条件</h3><p><MessageCircle size={16} />{task.chat_context_thread_id ? "聊天长期 Thread 已存在" : "任务已进入当前阶段"}</p><p><HardDrive size={16} />{task.resolved_workspace_alias ? "原工作区已记录" : "等待固定工作区"}</p></section><ArrowRight size={21} /><section><h3>安全核验</h3>{blocked ? <><p className="recorded"><Server size={16} />记录的执行器：{task.executor_id ?? "未知"}（待核验）</p><p className="recorded"><UserRound size={16} />记录的 Profile：{task.executor_profile ?? "未知"}（待核验）</p><p className="failed"><ShieldCheck size={16} />固定环境一致性未通过</p></> : <p className="failed"><AlertTriangle size={16} />{executorCheck?.detail ?? "当前阶段出现异常，请展开链路诊断"}</p>}</section><ArrowRight size={21} /><section><h3>处理结果</h3><p><Clock3 size={16} />{blocked ? "保持等待输入，不继续 Codex 执行" : "任务停留在异常阶段，等待处置"}</p></section><div className="stage-cause-note"><ShieldCheck size={16} />{blocked ? "这里仅展示任务快照；通过/未通过必须以聊天记忆中的恢复核验结果为准。" : "展开下方链路诊断，可查看完整错误和相关记录。"}</div></div>}</div>;
}

function Workers({ user }: { user: AdminUser }) {
  const queryClient = useQueryClient();
  const workers = useQuery({ queryKey: ["worker"], queryFn: () => api<AnyRecord>("/v1/admin/workers") });
  const release = useQuery({ queryKey: ["runner-release"], queryFn: () => api<AnyRecord>("/v1/admin/runner-release"), refetchInterval: 300_000 });
  const enrollments = useQuery({ queryKey: ["worker-enrollments"], queryFn: () => api<AnyRecord>("/v1/admin/worker-enrollments") });
  const [target, setTarget] = useState<{ worker: AnyRecord; command: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const upgradeCommand = release.data?.installUrl && release.data?.publicBaseUrl ? `curl -fsSL '${release.data.installUrl}' | /bin/zsh -s -- --artifact-base '${release.data.publicBaseUrl}' --upgrade` : null;
  const recommendedVersion = release.data?.recommendedVersion as string | null | undefined;
  const recentEnrollments = enrollments.data?.items?.slice(0, 8) ?? [];
  const openEnrollment = () => {
    queryClient.removeQueries({ queryKey: ["new-worker-enrollment"] });
    setAdding(true);
  };
  const items = workers.data?.items ?? [];
  const selected = items.find((worker: AnyRecord) => worker.executor_id === selectedId) ?? items[0];
  return <><PageTitle eyebrow="本地能力" title="执行器" description="通过一次性注册指令挂载 Mac；每个实例固定绑定一组 Codex Home 与 Profile。" action={<button className="primary-button" disabled={release.data?.source === "unavailable"} onClick={openEnrollment}><Plus size={17} />添加执行器</button>} />
    {release.data?.source === "unavailable" && <div className="inline-alert"><AlertTriangle size={17} />Runner CDN manifest 当前不可用，暂时不能生成可靠的安装指令。</div>}
    {!workers.data ? <PageLoading /> : items.length ? <div className="master-detail-layout worker-master-detail"><aside className="master-list-panel" aria-label="执行器列表"><div className="master-list-search"><Search size={17} /><span>执行器</span><span>{items.length}</span></div><div className="master-list">{items.map((worker: AnyRecord) => { const state = worker.operational_mode !== "enabled" ? worker.operational_mode : worker.availability; return <button key={worker.executor_id} aria-pressed={selected?.executor_id === worker.executor_id} className={selected?.executor_id === worker.executor_id ? "master-list-item selected" : "master-list-item"} onClick={() => setSelectedId(worker.executor_id)}><span className="list-item-icon"><Server size={20} /></span><span><strong>{worker.display_name}</strong><small>{worker.codex_profile} · {worker.architecture}</small><small>心跳 {relativeTime(worker.last_seen_at)}</small></span><StateBadge state={state} /></button>; })}</div>{recentEnrollments.length > 0 && <details className="master-list-foot"><summary><KeyRound size={16} />最近注册指令<ChevronRight size={15} /></summary><div className="compact-enrollments">{recentEnrollments.map((item: AnyRecord) => <div key={item.id}><code>{shortId(item.id)}</code><StateBadge state={item.state} label={({ pending: "待使用", used: "已使用", expired: "已过期", revoked: "已撤销" } as AnyRecord)[item.state]} /></div>)}</div></details>}</aside>
      {selected && <WorkerMasterDetailPane worker={selected} recommendedVersion={recommendedVersion} upgradeCommand={upgradeCommand} onCommand={(command) => setTarget({ worker: selected, command })} />}</div> : <article className="panel"><Empty icon={<Server />} title="还没有执行器" text="使用一次性注册指令挂载第一台 Mac。" /></article>}
    {target && <WorkerDialog {...target} user={user} onClose={() => { setTarget(null); void workers.refetch(); }} />}{adding && <EnrollmentDialog user={user} onClose={() => { setAdding(false); void enrollments.refetch(); void workers.refetch(); }} />}</>;
}

function WorkerMasterDetailPane({ worker, recommendedVersion, upgradeCommand, onCommand }: { worker: AnyRecord; recommendedVersion: string | null | undefined; upgradeCommand: string | null; onCommand(command: string): void }) {
  const updateAvailable = Boolean(recommendedVersion && worker.runner_version && recommendedVersion !== worker.runner_version);
  const managementAvailable = Boolean(recommendedVersion && worker.runner_version === recommendedVersion);
  const state = worker.operational_mode !== "enabled" ? worker.operational_mode : worker.availability;
  const canAcceptTasks = state === "online" && Boolean(worker.credentialActive);
  const capabilities = (worker.capabilities ?? []).map((capability: string) => humanCapability(capability)) as string[];
  return <section className="master-detail-panel worker-detail-pane"><header className="entity-header"><div className="entity-heading"><span className="entity-icon"><Server size={27} /></span><div><h2>{worker.display_name}</h2><p className="mono">{worker.executor_id}</p><small>{worker.architecture} · 心跳 {relativeTime(worker.last_seen_at)}</small></div></div><div className="entity-actions">{updateAvailable && upgradeCommand && <CopyButton value={`${upgradeCommand} --executor-id '${worker.executor_id}'`} label="复制升级指令" />}{worker.operational_mode === "enabled" ? <button className="secondary-button" onClick={() => onCommand("maintenance")}><Wrench size={15} />进入维护</button> : <button className="secondary-button" disabled={!worker.credentialActive} onClick={() => onCommand("enable")}><RefreshCw size={15} />重新启用</button>}<details className="more-actions"><summary className="icon-button" aria-label="更多执行器操作"><MoreHorizontal size={19} /></summary><div>{worker.operational_mode !== "disabled" && <button onClick={() => onCommand("disable")}>停用执行器</button>}{worker.credentialActive && <button onClick={() => onCommand("revoke_credentials")}>撤销设备凭据</button>}{worker.operational_mode === "disabled" && <button className="text-danger" onClick={() => onCommand("delete")}><Trash2 size={15} />删除执行器</button>}</div></details></div></header>
    <div className={`entity-conclusion conclusion-${canAcceptTasks ? "ready" : state === "maintenance" ? "warning" : "blocked"}`}><span>{canAcceptTasks ? <CheckCircle2 /> : <AlertTriangle />}</span><div><strong>{canAcceptTasks ? "执行器在线并可领取任务" : !worker.credentialActive ? "设备凭据无效，当前不可安全领取任务" : state === "maintenance" ? "执行器处于维护模式" : "执行器当前不可领取任务"}</strong><p>结论同时考虑在线状态、领取模式与设备凭据；各项仍在上方独立呈现。</p></div><StateBadge state={state} /></div>
    <div className="worker-status-grid"><div><span><Wifi size={18} />在线状态</span><strong>{displayState(worker.availability)}</strong><small>最近心跳 {relativeTime(worker.last_seen_at)}</small></div><div><span><Activity size={18} />领取任务模式</span><strong>{displayState(worker.operational_mode)}</strong><small>{worker.operational_mode === "enabled" ? "可领取新任务" : "不领取新任务"}</small></div><div><span><KeyRound size={18} />设备凭据</span><strong>{worker.credentialActive ? "有效" : "无效"}</strong><small>{worker.credentialActive ? `最近使用 ${relativeTime(worker.credentialLastUsedAt)}` : "需要重新注册"}</small></div><div><span><Cpu size={18} />活跃任务 / 容量</span><strong>{worker.activeTasks} / {worker.capacity}</strong><small>当前并行占用</small></div></div>
    <div className="layered-sections">
      <details open><summary><Cpu size={17} /><span><strong>环境与能力</strong><small>Codex Profile、工作区、模型与永久聊天记忆</small></span><ChevronDown size={17} /></summary><div className="worker-environment"><dl className="layered-detail-list"><Detail label="Codex Profile" value={worker.codex_profile} /><Detail label="Codex 版本" value={worker.codex_version} /><Detail label="Runner" value={worker.runner_version ? `${worker.runner_version}${updateAvailable ? `（可升级至 ${recommendedVersion}）` : "（最新）"}` : "版本未知"} /><Detail label="架构" value={worker.architecture} /><Detail label="总工作区" value={worker.workspace_aliases.join("、")} /><Detail label="模型目录" value={`${worker.model_catalog?.length ?? 0} 个${worker.model_catalog_updated_at ? ` · ${relativeTime(worker.model_catalog_updated_at)}更新` : " · 等待上报"}`} /></dl><div className="capability-list">{capabilities.map((capability) => <span key={capability}><CheckCircle2 size={15} />{capability}</span>)}</div></div></details>
      <details><summary><Wrench size={17} /><span><strong>设备端管理</strong><small>复制命令并在目标 Mac 本机执行</small></span><ChevronDown size={17} /></summary><RunnerManagement worker={worker} available={managementAvailable} upgradeCommand={updateAvailable && upgradeCommand ? `${upgradeCommand} --executor-id '${worker.executor_id}'` : null} /></details>
      <details><summary><ShieldCheck size={17} /><span><strong>安全与生命周期</strong><small>注册、凭据与停用策略</small></span><ChevronDown size={17} /></summary><dl className="layered-detail-list"><Detail label="注册方式" value={worker.registration_source === "quick_install" ? "快速注册" : "尚未通过设备注册"} /><Detail label="设备凭据" value={worker.credentialActive ? "有效" : "未注册或已撤销"} /><Detail label="当前模式" value={displayState(worker.operational_mode)} /><Detail label="固定聊天影响" value="维护、停用、撤销或删除可能使永久聊天绑定进入阻塞" /></dl></details>
    </div></section>;
}

function humanCapability(value: string): string {
  return ({ chat_context_v1: "永久聊天记忆（固定 Thread 与工作区）", app_handoff: "本机接手与归还", attachments_v1: "消息附件读取", cardkit_streaming: "CardKit 流式更新" } as Record<string, string>)[value] ?? value.replaceAll("_", " ");
}

function RunnerManagement({ worker, available, upgradeCommand }: { worker: AnyRecord; available: boolean; upgradeCommand: string | null }) {
  const command = (action: string) => `lark-agent-runner ${action} ${worker.executor_id}`;
  if (!available) return <div className="runner-management unavailable"><strong>设备端管理</strong><p>当前 Runner 尚未包含本机管理命令，请先升级后再使用。</p>{upgradeCommand && <CopyButton value={upgradeCommand} label="复制升级指令" />}</div>;
  return <details className="runner-management"><summary>设备端管理</summary><p>请在“{worker.display_name}”上执行。后台的维护和停用只控制任务领取，不会关闭 Mac 上的 Runner 进程。</p>{worker.availability === "offline" && worker.operational_mode === "enabled" && <div className="runner-offline-hint"><AlertTriangle size={15} />设备可能已关机，或本机 Runner 已停止。可在该设备执行启动命令。</div>}<div className="runner-command-grid"><CopyButton value={command("status")} label="查看状态" /><CopyButton value={command("start")} label="启动" /><CopyButton value={command("stop")} label="停止" /><CopyButton value={command("restart")} label="重启" /><CopyButton value={command("logs")} label="查看日志" /><CopyButton value="lark-agent-runner help" label="全部命令" /></div><small>停止会跨重启保持；卸载会撤销设备凭据并保留后台历史记录。</small></details>;
}

function EnrollmentDialog({ user, onClose }: { user: AdminUser; onClose(): void }) {
  const enrollment = useQuery({
    queryKey: ["new-worker-enrollment"],
    queryFn: () => api<AnyRecord>("/v1/admin/worker-enrollments", { method: "POST" }, user),
    staleTime: Infinity,
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  });
  return <Modal title="添加 Mac 执行器" onClose={onClose}>{enrollment.isLoading ? <PageLoading compact /> : enrollment.error ? <ErrorBox error={enrollment.error} /> : <div className="enrollment-dialog"><p>在目标 Mac 的工作区目录执行下面这条命令。安装器会检查 Codex、选择 Profile，并安装独立 Node 运行时和 launchd 服务。</p><pre>{enrollment.data?.command}</pre><div className="enrollment-expiry"><Clock3 size={15} />该指令将在 {new Date(enrollment.data?.expiresAt).toLocaleTimeString("zh-CN")} 失效，且只能使用一次。</div><div className="modal-actions"><button className="ghost-button" onClick={onClose}>关闭</button><CopyButton value={enrollment.data?.command ?? ""} label="复制安装指令" primary /></div></div>}</Modal>;
}

function CopyButton({ value, label, primary = false }: { value: string; label: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1_500); };
  return <button className={primary ? "primary-button" : "secondary-button"} onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "已复制" : label}</button>;
}

function Pending({ user }: { user: AdminUser }) {
  const [params, setParams] = useSearchParams();
  const approvals = useQuery({ queryKey: ["approval"], queryFn: () => api<AnyRecord>("/v1/admin/approvals") });
  const outbox = useQuery({ queryKey: ["outbox"], queryFn: () => api<AnyRecord>("/v1/admin/outbox") });
  const selectedKey = params.get("item") ?? "";
  const requestedType = params.get("type");
  const items = [
    ...(approvals.data?.items?.filter((item: AnyRecord) => item.state === "pending").map((item: AnyRecord) => ({ ...item, kind: "approval", selectionKey: `approval:${item.id}` })) ?? []),
    ...(outbox.data?.items?.filter((item: AnyRecord) => item.state === "unknown").map((item: AnyRecord) => ({ ...item, kind: "outbox", selectionKey: `outbox:${item.id}` })) ?? [])
  ];
  const selected = items.find((item: AnyRecord) => item.selectionKey === selectedKey)
    ?? items.find((item: AnyRecord) => item.kind === requestedType)
    ?? items[0];
  const approvalCount = items.filter((item: AnyRecord) => item.kind === "approval").length;
  const outboxCount = items.length - approvalCount;
  const refreshed = () => { void approvals.refetch(); void outbox.refetch(); setParams({}); };
  return <><PageTitle eyebrow="行动收件箱" title="待处理" description="集中处理审批决定与发送结果确认；不同语义分别处置。" action={<span className="pending-total">{items.length} 项待确认</span>} />
    {!approvals.data || !outbox.data ? <PageLoading /> : items.length ? <div className="master-detail-layout pending-master-detail"><aside className="master-list-panel" aria-label="待处理事项列表"><div className="pending-list-summary"><span><b>{approvalCount}</b> 待审批</span><span><b>{outboxCount}</b> 发送结果不确定</span></div><div className="master-list pending-master-list">{items.map((item: AnyRecord) => <button key={item.selectionKey} aria-pressed={selected?.selectionKey === item.selectionKey} className={selected?.selectionKey === item.selectionKey ? "master-list-item selected" : "master-list-item"} onClick={() => setParams({ type: item.kind, item: item.selectionKey })}><span className={`list-item-icon ${item.kind}`} >{item.kind === "approval" ? <ShieldCheck size={20} /> : <AlertTriangle size={20} />}</span><span><strong>{item.kind === "approval" ? item.method : "消息发送结果不确定"}</strong><small>任务 {shortId(item.task_id)}</small><small>{relativeTime(item.created_at)}{item.expires_at ? ` · ${relativeTime(item.expires_at)}到期` : ""}</small></span><ChevronRight size={17} /></button>)}</div></aside>
      {selected && <PendingDetail item={selected} user={user} onDone={refreshed} />}</div> : <article className="panel"><Empty icon={<CheckCircle2 />} title="没有待处理事项" text="当前没有需要审批或确认发送结果的事项。" /></article>}
  </>;
}

function PendingDetail({ item, user, onDone }: { item: AnyRecord; user: AdminUser; onDone(): void }) {
  const navigate = useNavigate();
  const approval = useMutation({ mutationFn: (approved: boolean) => api(`/v1/admin/approvals/${item.id}/decision`, { method: "POST", body: JSON.stringify({ approved }) }, user), onSuccess: onDone });
  const outbox = useMutation({ mutationFn: (command: string) => api(`/v1/admin/outbox/${item.id}/commands`, { method: "POST", body: commandBody(command) }, user), onSuccess: onDone });
  const pending = approval.isPending || outbox.isPending;
  return <section className="master-detail-panel pending-detail-pane"><header className="pending-detail-header"><span className={`pending-detail-icon ${item.kind}`}>{item.kind === "approval" ? <ShieldCheck /> : <AlertTriangle />}</span><div><small>{item.kind === "approval" ? "待审批" : "发送结果不确定"}</small><h2>{item.kind === "approval" ? item.method : "确认这条消息是否已经送达"}</h2><p>任务 {shortId(item.task_id)} · {relativeTime(item.created_at)}</p></div><StateBadge state={item.state} /></header>
    {item.kind === "approval" ? <><div className="pending-context-card"><h3>本次动作</h3><p>{item.method}</p><div className="pending-semantic-facts"><span><small>关联任务</small><strong>{shortId(item.task_id)}</strong></span><span><small>创建时间</small><strong>{formatDateTime(item.created_at)}</strong></span><span><small>到期时间</small><strong>{formatDateTime(item.expires_at)}</strong></span></div><details className="pending-technical-details"><summary>查看技术记录<ChevronDown size={15} /></summary><dl className="layered-detail-list"><Detail label="完整任务 ID" value={item.task_id} /><Detail label="审批记录 ID" value={item.id} /><Detail label="幂等键" value={item.idempotency_key} /></dl></details></div><div className="decision-note"><ShieldCheck size={18} /><div><strong>批准与拒绝只作用于本次动作</strong><span>拒绝仅阻止本次动作，任务随后继续执行；不会取消整个任务。</span></div></div>{approval.error && <ErrorBox error={approval.error} />}<div className="pending-primary-actions"><button className="primary-button" disabled={pending} onClick={() => approval.mutate(true)}>批准本次动作</button><button className="danger-button" disabled={pending} onClick={() => approval.mutate(false)}>拒绝本次动作</button><button className="ghost-button" onClick={() => navigate(`/tasks/${item.task_id}`)}>查看任务上下文</button></div></> : <><div className="pending-context-card"><h3>待确认的消息</h3><p>{item.content ?? "消息正文已保留在原发件记录中。"}</p><div className="pending-semantic-facts"><span><small>关联任务</small><strong>{shortId(item.task_id)}</strong></span><span><small>已尝试</small><strong>{item.attempt} 次</strong></span><span><small>传输方式</small><strong>{item.transport ?? item.operation_kind ?? "默认消息通道"}</strong></span></div><details className="pending-technical-details"><summary>查看发送技术记录<ChevronDown size={15} /></summary><dl className="layered-detail-list"><Detail label="完整任务 ID" value={item.task_id} /><Detail label="发件记录 ID" value={item.id} /><Detail label="平台回执" value={item.platform_message_id ?? "尚未确认"} /><Detail label="最近错误" value={item.last_error} /><Detail label="幂等键" value={item.idempotency_key} /></dl></details></div><div className="decision-note warning"><AlertTriangle size={18} /><div><strong>系统不会自动重发</strong><span>“原键重试”会复用原幂等键，降低重复发送风险；请根据平台侧结果选择。</span></div></div>{outbox.error && <ErrorBox error={outbox.error} />}<div className="pending-primary-actions"><button className="primary-button" disabled={pending} onClick={() => outbox.mutate("retry")}><RefreshCw size={15} />原键重试</button><button className="secondary-button" disabled={pending} onClick={() => outbox.mutate("mark_sent")}>标记已发送</button><button className="danger-button" disabled={pending} onClick={() => window.confirm("确认放弃这条发件记录？") && outbox.mutate("discard")}>放弃</button><button className="ghost-button" onClick={() => navigate(`/tasks/${item.task_id}`)}>查看任务上下文</button></div></>}
  </section>;
}

function Incidents({ user }: { user: AdminUser }) {
  const incidents = useQuery({ queryKey: ["incident"], queryFn: () => api<AnyRecord>("/v1/admin/incidents") });
  const items = incidents.data?.items ?? [];
  const current = items.filter((item: AnyRecord) => item.state !== "resolved").sort((a: AnyRecord, b: AnyRecord) => Number(b.severity === "critical") - Number(a.severity === "critical"));
  const resolved = items.filter((item: AnyRecord) => item.state === "resolved");
  const critical = current.filter((item: AnyRecord) => item.severity === "critical").length;
  return <><PageTitle eyebrow="系统健康" title="故障中心" description="当前故障按紧急度排列，恢复历史降级展示。" action={<Freshness />} />
    {!incidents.data ? <PageLoading /> : <div className="incident-register"><section className={`incident-register-summary ${current.length ? "attention" : "healthy"}`}><span>{current.length ? <AlertTriangle size={28} /> : <CheckCircle2 size={28} />}</span><div><small>当前未恢复</small><strong>{current.length} 个故障</strong><p>{current.length ? `${critical} 个严重 · ${current.length - critical} 个警告` : "所有已知故障均已由系统检测恢复。"}</p></div><div><span>严重程度</span><b>{critical ? "存在严重故障" : current.length ? "仅警告" : "正常"}</b></div></section>
      <section className="panel incident-current-panel"><PanelHead title="当前故障" subtitle="“确认已知”不代表解决；底层恢复后由系统自动关闭" />{current.length ? <div className="incident-register-list">{current.map((item: AnyRecord) => <IncidentRegisterRow key={item.id} item={item} user={user} onUpdated={() => void incidents.refetch()} />)}</div> : <Empty icon={<CheckCircle2 />} title="当前没有未恢复故障" text="核心链路处于预期状态。" />}</section>
      {resolved.length > 0 && <details className="resolved-history"><summary>已恢复历史 · {resolved.length} 条<ChevronDown size={17} /></summary><div className="incident-register-list resolved">{resolved.map((item: AnyRecord) => <IncidentRegisterRow key={item.id} item={item} />)}</div></details>}
    </div>}
  </>;
}

function IncidentRegisterRow({ item, user, onUpdated }: { item: AnyRecord; user?: AdminUser; onUpdated?(): void }) {
  const mutation = useMutation({ mutationFn: () => api(`/v1/admin/incidents/${item.id}/acknowledge`, { method: "POST", body: JSON.stringify({}) }, user), ...(onUpdated ? { onSuccess: onUpdated } : {}) });
  const severityLabel = item.severity === "critical" ? "严重" : "警告";
  return <details className={`incident-register-row severity-${item.severity}`}><summary><span className="incident-register-icon"><AlertTriangle size={19} /></span><span><strong>{item.title}</strong><small>{item.summary}</small></span><span className={`severity-label severity-${item.severity}`}>{severityLabel}</span><StateBadge state={item.state} /><time>{relativeTime(item.last_seen_at)}</time><ChevronDown size={17} /></summary><div className="incident-register-detail"><p>{item.summary}</p><dl className="layered-detail-list two-column"><Detail label="严重程度" value={severityLabel} /><Detail label="生命周期" value={displayState(item.state)} /><Detail label="首次发现" value={formatDateTime(item.first_seen_at)} /><Detail label="最近出现" value={formatDateTime(item.last_seen_at)} /><Detail label="出现次数" value={`${item.occurrence_count} 次`} /><Detail label="恢复时间" value={formatDateTime(item.resolved_at)} /></dl>{mutation.error && <ErrorBox error={mutation.error} />}{user && item.state === "open" && <button className="secondary-button" disabled={mutation.isPending} onClick={(event) => { event.preventDefault(); mutation.mutate(); }}>{mutation.isPending ? "确认中…" : "确认已知"}</button>}</div></details>;
}
function CommandDialog({ command, task, user, onClose }: { command: string; task: AnyRecord; user: AdminUser; onClose(): void }) { const mutation = useMutation({ mutationFn: () => api(`/v1/admin/tasks/${task.id}/commands`, { method: "POST", body: commandBody(command, { expectedRevision: task.revision }) }, user), onSuccess: onClose }); return <Modal title={commandLabel(command)} onClose={onClose}><p>这会改变任务当前的“{stateLabel[task.state]}”状态。系统仍会使用状态版本防止并发覆盖。</p>{mutation.error && <ErrorBox error={mutation.error} />}<div className="modal-actions"><button className="ghost-button" onClick={onClose}>取消</button><button className={command === "cancel" ? "danger-button" : "primary-button"} disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "处理中…" : "确认执行"}</button></div></Modal>; }
function WorkerDialog({ worker, command, user, onClose }: { worker: AnyRecord; command: string; user: AdminUser; onClose(): void }) {
  const deleting = command === "delete";
  const revoke = command === "revoke_credentials";
  const mutation = useMutation({ mutationFn: () => api(`/v1/admin/workers/${worker.executor_id}${deleting ? "" : "/commands"}`, { method: deleting ? "DELETE" : "POST", ...(deleting ? {} : { body: commandBody(command) }) }, user), onSuccess: onClose });
  const title = deleting ? "删除执行器" : revoke ? "撤销设备凭据" : command === "maintenance" ? "进入维护模式" : command === "disable" ? "停用执行器" : "重新启用执行器";
  const message = deleting
    ? "执行器会从后台列表移除并撤销设备凭据；历史任务保留，目标 Mac 文件不会删除。已有永久聊天的固定绑定可能因此进入阻塞。"
    : revoke
      ? "现有 Session 会立即失效，目标 Mac 必须重新注册；已有永久聊天的固定绑定可能进入阻塞。"
      : command === "maintenance"
        ? "执行器将停止领取新任务，不会关闭 Mac 上的 Runner 进程或强制中断活跃任务；固定到该环境的永久聊天可能在后续执行时进入阻塞。"
        : command === "disable"
          ? "执行器将停止领取任务，Runner 进程不会关闭；固定到该环境的永久聊天可能进入阻塞。"
          : "恢复领取新任务前，请确认原 Codex Home、Profile、工作区和配置指纹未发生变化。";
  return <Modal title={title} onClose={onClose}><p>{message}</p>{mutation.error && <ErrorBox error={mutation.error} />}<div className="modal-actions"><button className="ghost-button" onClick={onClose}>取消</button><button className={command === "disable" || revoke || deleting ? "danger-button" : "primary-button"} disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "处理中…" : deleting ? "确认删除" : "确认"}</button></div></Modal>;
}
function ApprovalItem({ item, user }: { item: AnyRecord; user: AdminUser }) { const mutation = useMutation({ mutationFn: (approved: boolean) => api(`/v1/admin/approvals/${item.id}/decision`, { method: "POST", body: JSON.stringify({ approved }) }, user) }); return <div className="pending-item"><div className="pending-icon purple"><ShieldCheck /></div><div><strong>{item.method}</strong><span>任务 {item.task_id.slice(0, 8)} · {relativeTime(item.created_at)}</span></div><div className="vertical-actions"><button disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>批准</button><button className="text-danger" disabled={mutation.isPending} onClick={() => mutation.mutate(false)}>拒绝</button></div></div>; }
function OutboxItem({ item, user }: { item: AnyRecord; user: AdminUser }) { const mutation = useMutation({ mutationFn: (command: string) => api(`/v1/admin/outbox/${item.id}/commands`, { method: "POST", body: commandBody(command) }, user) }); return <div className="pending-item"><div className="pending-icon red"><AlertTriangle /></div><div><strong>消息发送结果不确定</strong><span>任务 {item.task_id.slice(0, 8)} · 已尝试 {item.attempt} 次</span><small>{item.last_error}</small></div><div className="vertical-actions"><button disabled={mutation.isPending} onClick={() => mutation.mutate("retry")}>原键重试</button><button disabled={mutation.isPending} onClick={() => mutation.mutate("mark_sent")}>标记已发送</button><button className="text-danger" disabled={mutation.isPending} onClick={() => window.confirm("确认放弃这条发件记录？") && mutation.mutate("discard")}>放弃</button></div></div>; }
function IncidentRow({ item, user }: { item: AnyRecord; user?: AdminUser }) { const mutation = useMutation({ mutationFn: () => api(`/v1/admin/incidents/${item.id}/acknowledge`, { method: "POST", body: JSON.stringify({}) }, user) }); return <div className={`incident-row ${item.severity}`}><div className="incident-severity"><AlertTriangle /></div><div><div className="row-title"><strong>{item.title}</strong><StateBadge state={item.state} /></div><p>{item.summary}</p><span>{relativeTime(item.last_seen_at)} · 已出现 {item.occurrence_count} 次</span>{user && item.state === "open" && <div className="ack-row"><button disabled={mutation.isPending} onClick={() => mutation.mutate()}>确认已知</button></div>}</div></div>; }

function TraceData({ data }: { data: AnyRecord }) {
  const sections = [["任务与会话", { task: data.task, conversation: data.conversation }], ["事件去重账本", data.processed_events], ["飞书信号", data.signals], ["任务事件", data.events], ["草稿", data.drafts], ["审批", data.approvals], ["单消息输出", data.output], ["输出更新", data.updates], ["发件箱", data.outbox], ["动作回执", data.actions]] as const;
  return <div className="trace-data">{sections.map(([title, value], index) => <details className="trace-data-section" key={title} open={index < 2}><summary>{title}<span>{Array.isArray(value) ? `${value.length} 条` : value ? "有记录" : "无记录"}</span></summary><pre>{JSON.stringify(value, null, 2)}</pre></details>)}</div>;
}

function FullPage({ children }: { children: ReactNode }) { return <div className="full-page">{children}</div>; }
function PageLoading({ compact = false }: { compact?: boolean }) { return <div className={compact ? "page-loading compact" : "page-loading"} role="status" aria-live="polite"><RefreshCw className="spin" /><span>正在读取最新状态…</span></div>; }
function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) { return <div className="page-title"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>; }
function PanelHead({ title, subtitle, link }: { title: string; subtitle: string; link?: string }) { return <div className="panel-head"><div><h2>{title}</h2><p>{subtitle}</p></div>{link && <NavLink to={link}>查看全部 <ChevronRight size={15} /></NavLink>}</div>; }
function Freshness() { return <div className="freshness"><span className="pulse" />实时更新</div>; }
function StateBadge({ state, label }: { state: string; label?: string | undefined }) { return <span className={`state-badge state-${state}`}>{label ?? displayState(state)}</span>; }
function StatusDot({ state }: { state: string }) { return <span className={`status-dot ${state}`} />; }
function SummaryStat({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function MiniBars({ values }: { values: number[] }) { const list = values.length ? values : Array(24).fill(0); const max = Math.max(...list, 1); return <div className="mini-bars" aria-label="过去24小时任务量">{list.map((v, i) => <span key={i} style={{ height: `${Math.max(5, v / max * 100)}%` }} title={`${v} 个任务`} />)}</div>; }
function Fact({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Detail({ label, value }: { label: string; value?: string | null }) { return <div><dt>{label}</dt><dd title={value ?? ""}>{value ?? "—"}</dd></div>; }
function TimelineItem({ item }: { item: AnyRecord }) { const title = item.type === "signal" ? `收到${signalSenderLabel(item)}信号` : item.type === "event" ? item.event_type : item.type === "draft" ? `草稿 · ${item.state}` : item.type === "approval" ? `审批 · ${item.method}` : item.type === "outbox" ? `发件箱 · ${item.state}` : item.type === "output" ? `单消息回复 · ${item.state}` : item.type === "output_update" ? `回复更新 · ${item.operation}` : `动作 · ${item.action_type}`; return <div className={`timeline-item type-${item.type}`}><div className="timeline-dot" /><div><div><strong>{title}</strong><time>{relativeTime(item.created_at)}</time></div><p>{item.summary ?? (item.decision ? `注意力判断：${item.decision} · ${item.ingress_source ?? "lark"} · depth ${item.bot_dialogue_depth ?? 0}` : item.last_error ?? `状态：${item.state ?? "已记录"}`)}</p><AttachmentBadges items={item.attachments} /></div></div>; }
function TimelineGroups({ items }: { items: AnyRecord[] }) { const groups = [["收件", items.filter((item) => item.type === "signal")], ["执行", items.filter((item) => item.type === "event" && !String(item.event_type).startsWith("conversation."))], ["草稿", items.filter((item) => ["draft", "approval"].includes(item.type))], ["发送", items.filter((item) => ["output", "output_update", "outbox", "action"].includes(item.type))], ["生命周期", items.filter((item) => item.type === "event" && String(item.event_type).startsWith("conversation."))]] as const; return <div className="timeline-groups">{groups.filter(([, entries]) => entries.length).map(([title, entries]) => <section key={title}><h3>{title}<span>{entries.length}</span></h3><div className="timeline">{entries.map((item) => <TimelineItem key={`${item.type}-${item.id}`} item={item} />)}</div></section>)}</div>; }
function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="empty"><div>{icon}</div><strong>{title}</strong><p>{text}</p></div>; }
function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []);
    focusable()[0]?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (!candidates.length) { event.preventDefault(); return; }
      const first = candidates[0]!;
      const last = candidates[candidates.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onClick={onClose}><div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}><div className="modal-head"><h2>{title}</h2><button className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><X /></button></div>{children}</div></div>;
}
function ErrorBox({ error }: { error: unknown }) { return <div className="inline-alert" role="alert"><AlertTriangle size={17} />{error instanceof Error ? error.message : "操作失败"}</div>; }
function formatDuration(seconds: number) { return seconds < 60 ? `${Math.round(seconds)} 秒` : seconds < 3600 ? `${Math.round(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`; }
function formatDurationPrecise(seconds: number) { return seconds < 1 ? `${Math.round(seconds * 1000)} 毫秒` : seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒` : formatDuration(seconds); }
function moveTabFocus(event: ReactKeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']") ?? []);
  if (!tabs.length) return;
  const current = Math.max(0, tabs.indexOf(event.currentTarget));
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}
function signalSenderLabel(signal: AnyRecord) { return signal.sender_type === "bot" ? `机器人 ${signal.sender_display_name ?? shortId(signal.sender_bot_id) ?? "未知"}` : signal.sender_role === "owner" ? "主人" : "成员"; }
function AttachmentBadges({ items }: { items?: AnyRecord[] }) { if (!items?.length) return null; return <div className="attachment-badges" aria-label={`${items.length} 个附件`}>{items.map((item) => <span key={item.id} title={`${item.type === "image" ? "图片" : "文件"}：${item.fileName}`}><Paperclip size={13} />{item.type === "image" ? "图片" : "文件"} · {item.fileName}</span>)}</div>; }
function workspaceLabel(task: AnyRecord) {
  const suffix = task.bot_app_id ? `/${task.bot_app_id}${task.chat_context_id ? `/chats/${task.chat_context_id}` : ""}` : "";
  if (task.resolved_workspace_alias) return task.requested_workspace_alias ? `${task.resolved_workspace_alias}${suffix}` : `${task.resolved_workspace_alias}${suffix}（自动选择）`;
  if (task.requested_workspace_alias) return `${task.requested_workspace_alias}${suffix}（等待匹配）`;
  return "未指定";
}
function availableWorkspaceAliases(workers: AnyRecord[], executorId: string): string[] {
  const candidates = executorId ? workers.filter((worker) => worker.executor_id === executorId) : workers;
  return [...new Set(candidates.flatMap((worker) => worker.workspace_aliases ?? []))] as string[];
}
function normalizeBotForm(form: AnyRecord) {
  const nullable = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    ...form,
    defaultExecutorId: nullable(form.defaultExecutorId),
    defaultWorkspaceAlias: nullable(form.defaultWorkspaceAlias),
    attentionModel: nullable(form.attentionModel),
    attentionReasoningEffort: nullable(form.attentionReasoningEffort),
    executionModel: nullable(form.executionModel),
    executionReasoningEffort: nullable(form.executionReasoningEffort)
  };
}
function formatModelPolicy(model?: string | null, effort?: string | null) {
  if (!model && !effort) return "继承执行器 Profile";
  return `${model ?? "继承模型"} · ${effort ?? "继承推理强度"}`;
}
function ModelPolicyFields({ form, setForm, workers }: { form: AnyRecord; setForm: Dispatch<SetStateAction<any>>; workers: AnyRecord[] }) {
  const selectedWorker = workers.find((worker) => worker.executor_id === form.defaultExecutorId);
  const catalog = Array.isArray(selectedWorker?.model_catalog) ? selectedWorker.model_catalog as AnyRecord[] : [];
  const effortOptions = (modelId: string) => {
    const model = catalog.find((entry) => entry.id === modelId);
    return [...new Set(model?.supportedReasoningEfforts ?? ["minimal", "low", "medium", "high", "xhigh"])] as string[];
  };
  const set = (key: string, value: string) => setForm((current: AnyRecord) => ({ ...current, [key]: value }));
  const stages = [
    { title: "注意力判断", modelKey: "attentionModel", effortKey: "attentionReasoningEffort", hint: "用于 consume / merge / defer / dismiss 判断" },
    { title: "正式执行", modelKey: "executionModel", effortKey: "executionReasoningEffort", hint: "用于完整 Codex 回合与最终回答" }
  ];
  return <>
    {!form.defaultExecutorId && workers.length > 1 && <div className="inline-alert span-2"><AlertTriangle size={16} />存在多个可用执行器，请先绑定默认执行器，避免新任务因路由不明确而暂停。</div>}
    {stages.map((stage) => <div className="model-policy-block span-2" key={stage.modelKey}>
      <div><strong>{stage.title}</strong><small>{stage.hint}</small></div>
      <label>模型
        <input list={`${stage.modelKey}-catalog`} value={form[stage.modelKey]} onChange={(event) => set(stage.modelKey, event.target.value)} placeholder="留空继承 Profile；也可输入自定义模型 ID" />
        <datalist id={`${stage.modelKey}-catalog`}>{catalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName ?? entry.id}</option>)}</datalist>
      </label>
      <label>推理强度
        <select value={form[stage.effortKey]} onChange={(event) => set(stage.effortKey, event.target.value)}>
          <option value="">继承模型默认值</option>
          {effortOptions(form[stage.modelKey]).map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
    </div>)}
    <div className="workspace-isolation-note span-2">{selectedWorker ? `模型目录：${catalog.length} 个${selectedWorker.model_catalog_updated_at ? `，${relativeTime(selectedWorker.model_catalog_updated_at)}更新` : "，等待 Runner 上报"}` : "选择执行器后可从其 Codex 模型目录中选择；高级用法也可以直接输入模型 ID。"}</div>
  </>;
}
function commandLabel(command: string) { return ({ retry: "重新排队", cancel: "取消任务", handoff: "请求本机接手", return_agent: "归还 Agent", mark_completed: "标记完成" } as Record<string, string>)[command] ?? command; }
function shortId(value?: string | null) { if (!value) return null; return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-5)}`; }
const traceCheckLabel: Record<string, string> = { event: "飞书事件接收", signal: "Signal 关联", attention: "注意力判断", executor: "执行器与工作区", codex: "Codex Thread", draft: "草稿新鲜度", sequence: "CardKit Sequence", outbox: "Output 与 Outbox", platform: "平台消息回执", lifecycle: "会话生命周期" };
function displayState(state: string) { return stateLabel[state] ?? decisionLabel[state] ?? ({ online: "在线", starting: "启动中", ready: "已就绪", blocked: "已阻塞", error: "异常", stale: "疑似离线", offline: "离线", enabled: "已启用", maintenance: "维护中", disabled: "已停用", open: "待处理", acknowledged: "已确认", resolved: "已恢复", success: "成功", normal: "正常", pending: "待使用", pass: "通过", fail: "未通过", used: "已使用", expired: "已过期", revoked: "已撤销", "正常": "正常", "等待": "等待", "警告": "警告", "错误": "错误", drafted: "待检查", held: "已搁置", sent: "已发送", unknown: "结果未知", streaming: "流式更新", discarded: "已放弃" } as Record<string, string>)[state] ?? state; }
