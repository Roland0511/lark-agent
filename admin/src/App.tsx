import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Activity, AlertTriangle, ArrowRight, Bot, CheckCircle2, ChevronRight, CircleGauge, Clock3, FileClock, Inbox,
  Check, Copy, GitBranch, LogOut, Menu, MessageCircle, Plus, RefreshCw, Search, Server, ShieldCheck, Sparkles, Trash2, Wifi, WifiOff, X
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
    ["/", "运行总览", CircleGauge], ["/flow", "处理流水", GitBranch], ["/bots", "机器人", Bot], ["/tasks", "任务中心", Inbox], ["/workers", "执行器", Server],
    ["/pending", "待处理", FileClock], ["/incidents", "故障中心", AlertTriangle]
  ] as const;
  return <div className="app-shell">
    <aside className={open ? "sidebar open" : "sidebar"}>
      <div className="sidebar-brand"><div className="brand-mark small"><Sparkles size={19} /></div><div><strong>{user.agentDisplayName}</strong><span>链路调试台</span></div><button className="icon-button mobile-only" onClick={() => setOpen(false)}><X /></button></div>
      <nav>{nav.map(([to, label, Icon]) => <NavLink key={to} to={to} end={to === "/"} onClick={() => setOpen(false)}><Icon size={19} /><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-status"><span className="pulse" /><div><strong>控制面运行中</strong><span>状态自动同步</span></div></div>
    </aside>
    <main><header className="topbar"><button className="icon-button mobile-only" onClick={() => setOpen(true)}><Menu /></button><div className="topbar-spacer" /><div className="identity"><div className="avatar">{(user.displayName ?? "主").slice(0, 1)}</div><div><strong>{user.displayName ?? "飞书主人"}</strong><span>主人</span></div></div><button className="icon-button" aria-label="断开控制台" onClick={() => void logout()}><LogOut size={18} /></button></header>
      <div className="page-area"><Routes>
        <Route path="/" element={<Overview />} /><Route path="/flow" element={<Flow />} /><Route path="/bots" element={<Bots user={user} />} /><Route path="/tasks" element={<Tasks />} /><Route path="/tasks/:id" element={<TaskDetail user={user} />} />
        <Route path="/workers" element={<Workers user={user} />} /><Route path="/pending" element={<Pending user={user} />} />
        <Route path="/incidents" element={<Incidents user={user} />} /><Route path="*" element={<Navigate to="/" />} />
      </Routes></div>
    </main>
  </div>;
}

function Bots({ user }: { user: AdminUser }) {
  const bots = useQuery({ queryKey: ["bot"], queryFn: () => api<AnyRecord>("/v1/admin/bots"), refetchInterval: 30_000 });
  const workers = useQuery({ queryKey: ["worker"], queryFn: () => api<AnyRecord>("/v1/admin/workers") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AnyRecord | null>(null);
  const refresh = () => { void bots.refetch(); setAdding(false); setEditing(null); };
  const continueSetup = (bot: AnyRecord) => { void bots.refetch(); setAdding(false); setEditing(bot); };
  return <><PageTitle eyebrow="飞书身份" title="机器人与角色" description="每个机器人拥有独立的飞书凭据、群绑定、角色要求和执行路由。" action={<button className="primary-button" onClick={() => setAdding(true)}><Plus size={17} />添加机器人</button>} />
    <div className="bot-routing-note"><GitBranch size={18} /><div><strong>群聊路由规则</strong><span>明确 @ 时只交给被提及机器人；普通续聊会进入该群所有活跃机器人的收件箱，由各 Agent 独立判断。</span></div></div>
    <div className="card-grid">{bots.data?.items?.map((bot: AnyRecord) => { const message = bot.runtime?.[`${bot.id}:message`]; return <article className="worker-card bot-card" key={bot.id}><div className="worker-card-top"><div className="machine-icon"><Bot /></div><div><h3>{bot.displayName}</h3><p>{bot.appId}</p></div><StateBadge state={!bot.enabled ? "disabled" : message?.ready ? "online" : message?.state ?? "starting"} /></div>
      <div className="bot-badges">{bot.isSystem && <span><ShieldCheck size={13} />系统通知</span>}<span>{bot.ownerBound ? "主人已绑定" : "等待主人绑定"}</span><span>配置 v{bot.configRevision}</span></div>
      <dl className="detail-list"><Detail label="角色" value={bot.roleInstructions || "通用助理"} /><Detail label="默认执行器" value={bot.defaultExecutorId} /><Detail label="默认工作区" value={bot.defaultWorkspaceAlias} /><Detail label="已绑定群" value={`${bot.bindings?.filter((x: AnyRecord) => x.enabled).length ?? 0} 个`} /><Detail label="活跃会话" value={`${bot.activeConversations} 个`} /><Detail label="凭据" value={bot.credentialState === "verified" ? "已验证（只写）" : bot.credentialError ?? bot.credentialState} /></dl>
      <div className="card-actions"><button className="secondary-button" onClick={() => setEditing(bot)}>配置</button></div></article>; }) ?? <PageLoading />}</div>
    {adding && <AddBotDialog user={user} workers={workers.data?.items ?? []} onClose={() => setAdding(false)} onCreated={continueSetup} />}
    {editing && <BotSettingsDialog user={user} bot={editing} workers={workers.data?.items ?? []} onClose={() => setEditing(null)} onSaved={refresh} />}
  </>;
}

function AddBotDialog({ user, workers, onClose, onCreated }: { user: AdminUser; workers: AnyRecord[]; onClose(): void; onCreated(bot: AnyRecord): void }) {
  const [form, setForm] = useState({ displayName: "", appId: "", appSecret: "", roleInstructions: "", defaultExecutorId: "", defaultWorkspaceAlias: "" });
  const aliases = [...new Set(workers.flatMap((worker) => worker.workspace_aliases ?? []))] as string[];
  const mutation = useMutation({ mutationFn: () => api<AnyRecord>("/v1/admin/bots", { method: "POST", body: JSON.stringify({ ...form, defaultExecutorId: form.defaultExecutorId || null, defaultWorkspaceAlias: form.defaultWorkspaceAlias || null }) }, user), onSuccess: onCreated });
  return <Modal title="添加飞书机器人" onClose={onClose}><p>App Secret 只会通过 HTTPS 写入服务器上的 lark-cli profile，控制台和数据库不会保存或再次显示。</p><div className="bot-form"><label>显示名称<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="例如：项目助理" /></label><label>App ID<input value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} placeholder="cli_xxx" /></label><label>App Secret<input type="password" autoComplete="new-password" value={form.appSecret} onChange={(e) => setForm({ ...form, appSecret: e.target.value })} /></label><label className="span-2">角色提示词<textarea rows={5} value={form.roleInstructions} onChange={(e) => setForm({ ...form, roleInstructions: e.target.value })} placeholder="描述这个机器人负责什么、如何回答。只对新会话生效。" /></label><label>默认执行器<select value={form.defaultExecutorId} onChange={(e) => setForm({ ...form, defaultExecutorId: e.target.value })}><option value="">自动选择</option>{workers.map((worker) => <option key={worker.executor_id} value={worker.executor_id}>{worker.display_name}</option>)}</select></label><label>默认工作区<select value={form.defaultWorkspaceAlias} onChange={(e) => setForm({ ...form, defaultWorkspaceAlias: e.target.value })}><option value="">自动选择</option>{aliases.map((alias) => <option key={alias}>{alias}</option>)}</select></label></div>{mutation.error && <ErrorBox error={mutation.error} />}<div className="modal-actions"><button className="ghost-button" onClick={onClose}>取消</button><button className="primary-button" disabled={mutation.isPending || !form.displayName || !form.appId || !form.appSecret} onClick={() => mutation.mutate()}>{mutation.isPending ? "正在验证凭据…" : "添加并连接"}</button></div></Modal>;
}

function BotSettingsDialog({ user, bot, workers, onClose, onSaved }: { user: AdminUser; bot: AnyRecord; workers: AnyRecord[]; onClose(): void; onSaved(): void }) {
  const detail = useQuery({ queryKey: ["bot", bot.id], queryFn: () => api<AnyRecord>(`/v1/admin/bots/${bot.id}`), refetchInterval: (query) => query.state.data?.ownerBound ? false : 5_000 });
  const chats = useQuery({ queryKey: ["bot", bot.id, "chats"], queryFn: () => api<AnyRecord>(`/v1/admin/bots/${bot.id}/chats`), retry: false });
  const data = detail.data ?? bot;
  const [form, setForm] = useState({ displayName: bot.displayName, roleInstructions: bot.roleInstructions ?? "", defaultExecutorId: bot.defaultExecutorId ?? "", defaultWorkspaceAlias: bot.defaultWorkspaceAlias ?? "" });
  const [selected, setSelected] = useState<Set<string>>(new Set((bot.bindings ?? []).filter((x: AnyRecord) => x.enabled).map((x: AnyRecord) => x.chatId)));
  const [bindingCommand, setBindingCommand] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState("");
  const [manualChatId, setManualChatId] = useState("");
  const [manualChats, setManualChats] = useState<AnyRecord[]>([]);
  const aliases = [...new Set(workers.flatMap((worker) => worker.workspace_aliases ?? []))] as string[];
  useEffect(() => { if (chats.data?.items) setSelected(new Set(chats.data.items.filter((x: AnyRecord) => x.bound).map((x: AnyRecord) => x.chatId))); }, [chats.data]);
  const save = useMutation({ mutationFn: async () => { await api(`/v1/admin/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ ...form, defaultExecutorId: form.defaultExecutorId || null, defaultWorkspaceAlias: form.defaultWorkspaceAlias || null }) }, user); const known = [...new Map([...(data.bindings ?? []).map((x: AnyRecord) => [x.chatId, { chatId: x.chatId, name: x.chatName, preferredExecutorId: x.preferredExecutorId, workspaceAlias: x.workspaceAlias }]), ...(chats.data?.items ?? []).map((x: AnyRecord) => [x.chatId, x]), ...manualChats.map((x: AnyRecord) => [x.chatId, x])]).values()] as AnyRecord[]; await api(`/v1/admin/bots/${bot.id}/chat-bindings`, { method: "PUT", body: JSON.stringify({ bindings: known.filter((x: AnyRecord) => selected.has(x.chatId)).map((x: AnyRecord) => ({ chatId: x.chatId, chatName: x.name ?? x.chatName ?? null, enabled: true, preferredExecutorId: x.preferredExecutorId ?? null, workspaceAlias: x.workspaceAlias ?? null })) }) }, user); }, onSuccess: onSaved });
  const command = useMutation({ mutationFn: (value: string) => api(`/v1/admin/bots/${bot.id}/commands`, { method: "POST", body: JSON.stringify({ command: value }) }, user), onSuccess: () => void detail.refetch() });
  const owner = useMutation({ mutationFn: () => api<AnyRecord>(`/v1/admin/bots/${bot.id}/owner-binding`, { method: "POST", body: "{}" }, user), onSuccess: (result) => setBindingCommand(result.command) });
  const credentials = useMutation({ mutationFn: () => api(`/v1/admin/bots/${bot.id}/credentials`, { method: "POST", body: JSON.stringify({ appSecret: newSecret }) }, user), onSuccess: () => { setNewSecret(""); void detail.refetch(); } });
  const remove = useMutation({ mutationFn: () => api(`/v1/admin/bots/${bot.id}`, { method: "DELETE" }, user), onSuccess: onSaved });
  return <Modal title={`配置 ${data.displayName}`} onClose={onClose}><div className="bot-form"><label>显示名称<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label><label>App ID<input value={data.appId} disabled /></label><label className="span-2">角色提示词<textarea rows={4} value={form.roleInstructions} onChange={(e) => setForm({ ...form, roleInstructions: e.target.value })} /></label><label>默认执行器<select value={form.defaultExecutorId} onChange={(e) => setForm({ ...form, defaultExecutorId: e.target.value })}><option value="">自动选择</option>{workers.map((worker) => <option key={worker.executor_id} value={worker.executor_id}>{worker.display_name}</option>)}</select></label><label>默认工作区<select value={form.defaultWorkspaceAlias} onChange={(e) => setForm({ ...form, defaultWorkspaceAlias: e.target.value })}><option value="">自动选择</option>{aliases.map((alias) => <option key={alias}>{alias}</option>)}</select></label></div>
    <section className="bot-settings-section"><strong>主人身份</strong><p>{data.ownerBound ? "已完成该飞书应用下的主人 Open ID 绑定。" : "尚未绑定。生成指令后，请在飞书中私聊该机器人发送。"}</p><button className="secondary-button" disabled={owner.isPending} onClick={() => owner.mutate()}>生成绑定指令</button>{bindingCommand && <div className="binding-command"><code>{bindingCommand}</code><CopyButton value={bindingCommand} label="复制" /></div>}</section>
    <section className="bot-settings-section"><strong>群绑定</strong>{chats.isLoading ? <PageLoading compact /> : chats.error ? <ErrorBox error={chats.error} /> : <div className="chat-checklist">{[...(chats.data?.items ?? []), ...manualChats].map((chat: AnyRecord) => <label key={chat.chatId}><input type="checkbox" checked={selected.has(chat.chatId)} onChange={(e) => { const next = new Set(selected); e.target.checked ? next.add(chat.chatId) : next.delete(chat.chatId); setSelected(next); }} /><span><strong>{chat.name ?? "手工添加的群"}</strong><small>{chat.chatId}</small></span></label>)}</div>}<div className="inline-field"><input value={manualChatId} onChange={(e) => setManualChatId(e.target.value)} placeholder="无法拉取时手工输入 chat_id" /><button className="secondary-button" disabled={!manualChatId.trim()} onClick={() => { const chatId = manualChatId.trim(); setManualChats((current) => current.some((item) => item.chatId === chatId) ? current : [...current, { chatId, name: "手工添加的群" }]); setSelected((current) => new Set([...current, chatId])); setManualChatId(""); }}>添加</button></div></section>
    {data.credentialRotatable && <section className="bot-settings-section"><strong>轮换 App Secret</strong><div className="inline-field"><input type="password" autoComplete="new-password" value={newSecret} onChange={(e) => setNewSecret(e.target.value)} placeholder="输入新 Secret" /><button className="secondary-button" disabled={!newSecret || credentials.isPending} onClick={() => credentials.mutate()}>更新凭据</button></div></section>}
    {(save.error || command.error || owner.error || credentials.error || remove.error) && <ErrorBox error={save.error ?? command.error ?? owner.error ?? credentials.error ?? remove.error} />}
    <div className="bot-control-row">{!data.isSystem && <button className="secondary-button" onClick={() => command.mutate("set_system")}>设为系统通知机器人</button>}{data.enabled ? <button className="danger-button" disabled={data.isSystem} onClick={() => window.confirm("停用后将不再接收新消息，确认继续？") && command.mutate("disable")}>停用接入</button> : <><button className="secondary-button" onClick={() => command.mutate("enable")}>重新启用</button><button className="danger-button" onClick={() => window.confirm("确认删除该机器人？历史任务仍会保留。") && remove.mutate()}>删除</button></>}</div>
    <div className="modal-actions"><button className="ghost-button" onClick={onClose}>关闭</button><button className="primary-button" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "保存中…" : "保存设置与群绑定"}</button></div></Modal>;
}

function Overview() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<AnyRecord>("/v1/admin/overview") });
  if (!overview.data) return <PageLoading />;
  const d = overview.data; const states = d.taskStates ?? {};
  const active = ["queued", "waiting_worker", "running", "waiting_input", "waiting_approval", "held_draft", "human_owned"].reduce((n, key) => n + (states[key] ?? 0), 0);
  const cards = [
    ["当前活跃任务", active, "任务仍在处理中", "blue", Activity], ["等待执行器", states.waiting_worker ?? 0, "本机上线后继续", "amber", Clock3],
    ["等待续聊", d.awaitingFollowup ?? 0, "Agent 仍在等待群消息", "blue", MessageCircle],
    ["待审批", d.pendingApprovals, "需要主人判断", "purple", ShieldCheck], ["异常发件箱", d.outboxUnknown, "发送结果需核查", "red", AlertTriangle]
  ] as const;
  return <><PageTitle eyebrow="实时态势" title="运行总览" description="先看需要你介入的事情，再看系统是否健康。" action={<Freshness />} />
    <section className="metric-grid">{cards.map(([label, value, hint, tone, Icon]) => <article className={`metric-card ${tone}`} key={label}><div className="metric-icon"><Icon size={21} /></div><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></article>)}</section>
    <section className="dashboard-grid"><article className="panel span-2"><PanelHead title="过去 24 小时任务流入" subtitle="按小时统计新任务" /><MiniBars values={d.throughput?.map((x: AnyRecord) => x.count) ?? []} /><div className="summary-row"><SummaryStat label="完成成功率" value={d.successRate == null ? "暂无" : `${Math.round(d.successRate * 100)}%`} /><SummaryStat label="平均处理时长" value={d.averageDurationSeconds == null ? "暂无" : formatDuration(d.averageDurationSeconds)} /><SummaryStat label="搁置草稿" value={`${d.heldDrafts} 条`} /></div></article>
      <article className="panel"><PanelHead title="执行器" subtitle="最近一次心跳" /><div className="worker-list">{d.workers.map((w: AnyRecord) => <div className="worker-compact" key={w.executorId}><StatusDot state={w.operationalMode !== "enabled" ? w.operationalMode : w.availability} /><div><strong>{w.displayName}</strong><span>{w.profile} · {relativeTime(w.lastSeenAt)}</span></div><StateBadge state={w.operationalMode !== "enabled" ? w.operationalMode : w.availability} /></div>)}</div></article>
      <article className="panel"><PanelHead title="飞书能力" subtitle="每个机器人的独立消息长连接" /><div className="consumer-list">{Object.entries(d.consumers).map(([key, value]) => { const v = value as AnyRecord; const message = key.includes("message"); const disabled = v.state === "disabled"; const botName = d.bots?.find((bot: AnyRecord) => key.startsWith(`${bot.id}:`))?.displayName ?? "机器人"; const detail = disabled ? (message ? "已停用" : "未启用（仅影响卡片按钮）") : v.ready ? "连接正常" : `${v.lastError ?? "尚未就绪"}${message ? "" : "（仅影响卡片按钮）"}`; return <div key={key}><div className={`consumer-icon ${disabled ? "disabled" : v.ready ? "ok" : "bad"}`}>{v.ready ? <Wifi /> : <WifiOff />}</div><div><strong>{botName} · {message ? "消息接入" : "卡片操作"}</strong><span>{detail}</span></div></div>; })}</div></article>
      <article className="panel span-2"><PanelHead title="当前故障" subtitle="按严重程度排序" link="/incidents" />{d.incidents.length ? <div className="incident-list">{d.incidents.map((i: AnyRecord) => <IncidentRow key={i.id} item={i} />)}</div> : <Empty icon={<CheckCircle2 />} title="目前没有未解决故障" text="所有关键链路都在预期状态内。" />}</article>
    </section></>;
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
  const update = (next: Record<string, string>) => setParams({ view, range, ...(stage && { stage }), ...(state && { state }), ...(chatType && { chat_type: chatType }), ...(executor && { executor }), ...(workspace && { workspace }), ...(bot && { bot }), ...(q && { q }), ...next });
  const nextPage = () => items.data?.nextCursor && setParams(new URLSearchParams({ ...Object.fromEntries(query), before: items.data.nextCursor }));
  return <><PageTitle eyebrow="链路诊断" title="处理流水" description="从飞书消息到最终回复，直接查看每个处理阶段的数据和断点。" action={<Freshness />} />
    <section className="flow-stage-strip">{(summary.data?.stages ?? []).map((item: AnyRecord, index: number) => <div className="flow-stage-wrap" key={item.stage}><button className={`flow-stage-card ${stage === item.stage ? "selected" : ""} ${item.failed ? "failed" : item.warnings ? "warning" : ""}`} onClick={() => update({ view: "flow", stage: stage === item.stage ? "" : item.stage })}><span>{flowStageLabel[item.stage] ?? item.stage}</span><strong>{item.active}</strong><small>通过 {item.passed} · 异常 {item.failed + item.warnings}</small><small>{item.oldestWaitingSeconds == null ? "无等待" : `最久 ${formatDuration(item.oldestWaitingSeconds)}`}</small></button>{index < (summary.data?.stages?.length ?? 0) - 1 && <ArrowRight className="flow-arrow" size={18} />}</div>)}</section>
    <div className="flow-toolbar"><div className="segmented">{([["flow", "全部流水"], ["inbox", "Agent 收件箱"], ["outbox", "发件箱"]] as const).map(([key, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setParams({ view: key, range, ...(bot && { bot }) })}>{label}</button>)}</div><select aria-label="时间范围" value={range} onChange={(e) => update({ range: e.target.value })}><option value="1h">最近 1 小时</option><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="all">全部</option></select><select aria-label="机器人筛选" value={bot} onChange={(e) => update({ bot: e.target.value })}><option value="">全部机器人</option>{bots.data?.items?.map((item: AnyRecord) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><select aria-label="会话类型" value={chatType} onChange={(e) => update({ chat_type: e.target.value })}><option value="">全部会话</option><option value="p2p">私聊</option><option value="group">群聊</option></select><select aria-label="流水状态" value={state} onChange={(e) => update({ state: e.target.value })}><option value="">全部状态</option>{(view === "inbox" ? ["pending", "consume", "merge", "defer", "dismiss"] : view === "outbox" ? ["pending", "sent", "unknown", "failed", "discarded"] : Object.keys(stateLabel)).map((key) => <option key={key} value={key}>{displayState(key)}</option>)}</select><div className="search compact"><Search size={17} /><input aria-label="搜索流水" placeholder="正文、任务或会话 ID" defaultValue={q} onKeyDown={(e) => e.key === "Enter" && update({ q: e.currentTarget.value })} /></div><details className="flow-advanced"><summary>更多筛选</summary><div><input aria-label="执行器筛选" placeholder="executor_id" defaultValue={executor} onKeyDown={(e) => e.key === "Enter" && update({ executor: e.currentTarget.value })} /><input aria-label="工作区筛选" placeholder="workspace" defaultValue={workspace} onKeyDown={(e) => e.key === "Enter" && update({ workspace: e.currentTarget.value })} /></div></details></div>
    {!items.data ? <PageLoading /> : <>{view === "inbox" ? <InboxFlow items={items.data.items} onTask={(id) => navigate(`/tasks/${id}`)} /> : view === "outbox" ? <OutboxFlow items={items.data.items} onTask={(id) => navigate(`/tasks/${id}`)} onPending={() => navigate("/pending")} /> : <div className="flow-run-list">{items.data.items.length ? items.data.items.map((item: AnyRecord) => <FlowRun key={item.id} item={item} onOpen={() => navigate(`/tasks/${item.id}`)} />) : <Empty icon={<GitBranch />} title="当前范围没有处理记录" text="调整时间或阶段筛选后再试。" />}</div>}{items.data.nextCursor && <div className="flow-pagination"><button className="secondary-button" onClick={nextPage}>查看更早记录</button></div>}</>}
  </>;
}

function FlowRun({ item, onOpen }: { item: AnyRecord; onOpen(): void }) {
  const cells = [
    { key: "message", title: "消息", state: item.signal ? "received" : "missing", body: item.signal?.content ?? "没有 Signal", meta: item.signal ? `${item.signal.sender_id} · ${item.signal.message_id}` : null },
    { key: "attention", title: "判断", state: item.signal?.decision ?? "pending", body: decisionLabel[item.signal?.decision] ?? "待判断", meta: item.signal?.decision_rationale },
    { key: "codex", title: "执行", state: item.state, body: stateLabel[item.state] ?? item.state, meta: [item.executor_id, item.resolved_workspace_alias, item.executor_profile, item.codex_thread_id && `thread ${shortId(item.codex_thread_id)}`, item.executor_config_fingerprint && `cfg ${shortId(item.executor_config_fingerprint)}`, item.lease_expires_at && `lease ${new Date(item.lease_expires_at).toLocaleTimeString("zh-CN")}`].filter(Boolean).join(" · ") || "尚未绑定" },
    { key: "draft", title: "草稿", state: item.draft?.state ?? "skipped", body: item.draft?.content ?? (item.signal?.decision === "dismiss" ? "静默跳过" : "尚无草稿"), meta: item.draft ? `room ${item.draft.base_room_seq} → ${item.draft.observed_room_seq} · held ${item.draft.hold_count}` : null },
    { key: "outbox", title: "发件", state: item.outbox?.state ?? item.output?.state ?? "skipped", body: item.outbox?.content ?? item.output?.current_content ?? "尚无输出", meta: [item.output?.transport, item.output && `seq ${item.output.sequence}`, item.outbox?.platform_message_id].filter(Boolean).join(" · ") || null },
    { key: "reply", title: "会话", state: item.conversation_disposition ?? item.state, body: item.conversation_disposition === "awaiting_followup" ? "等待续聊" : item.conversation_disposition === "complete" ? "会话结束" : stateLabel[item.state], meta: [item.disposition_reason, item.followup_expires_at && `截止 ${new Date(item.followup_expires_at).toLocaleString("zh-CN")}`].filter(Boolean).join(" · ") || null }
  ];
  return <article className={`flow-run health-${item.health}`}><header><div><strong className="mono">{item.id.slice(0, 8)}</strong><span>{item.bot_display_name} · {item.chat_type === "group" ? "群聊" : "私聊"} · 第 {item.turn_index} 回合 · {relativeTime(item.updated_at)}</span></div><div><StateBadge state={item.state} /><button className="ghost-button" onClick={onOpen}>查看诊断 <ChevronRight size={15} /></button></div></header><div className="flow-lane">{cells.map((cell, index) => <div className={`flow-cell ${item.currentStage === cell.key ? "current" : ""}`} key={cell.key}><div className="flow-cell-head"><span>{cell.title}</span><code>{cell.state}</code></div><p>{cell.body}</p>{cell.meta && <small title={cell.meta}>{cell.meta}</small>}{index < cells.length - 1 && <ArrowRight className="lane-arrow" size={16} />}</div>)}</div></article>;
}

function InboxFlow({ items, onTask }: { items: AnyRecord[]; onTask(id: string): void }) {
  return <article className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>信号</th><th>机器人</th><th>正文</th><th>判断</th><th>优先级</th><th>耗时</th><th>Codex</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong className="mono">#{item.seq}</strong><small>{item.chat_type === "group" ? "群聊" : "私聊"} · 回合 {item.turn_index}</small><small className="mono">{shortId(item.message_id)}</small></td><td>{item.bot_display_name}</td><td><pre className="message-content">{item.content}</pre></td><td><StateBadge state={item.decision} /><small>{item.decision_rationale ?? "尚未判断"}</small></td><td>{item.priority}</td><td>{item.decisionSeconds == null ? "等待中" : formatDuration(item.decisionSeconds)}</td><td>{item.enteredCodex ? shortId(item.codex_thread_id) : "未进入"}</td><td><button className="icon-button" aria-label="查看任务" onClick={() => onTask(item.task_id)}><ChevronRight size={17} /></button></td></tr>)}</tbody></table></div></article>;
}

function OutboxFlow({ items, onTask, onPending }: { items: AnyRecord[]; onTask(id: string): void; onPending(): void }) {
  return <article className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>发件</th><th>机器人</th><th>最终正文</th><th>传输</th><th>版本</th><th>状态</th><th>平台回执</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong className="mono">{item.task_id.slice(0, 8)}</strong><small>回合 {item.turn_index} · 尝试 {item.attempt}</small><small className="mono">{shortId(item.idempotency_key)}</small></td><td>{item.bot_display_name}</td><td><pre className="message-content">{item.content}</pre>{item.last_error && <small className="text-danger">{item.last_error}</small>}</td><td>{item.transport ?? item.operation_kind}<small>{item.card_id ? `card ${shortId(item.card_id)}` : ""}</small></td><td>seq {item.sequence ?? "—"}<small>room {item.base_room_seq ?? "—"} → {item.observed_room_seq ?? "—"}</small></td><td><StateBadge state={item.state} /><small>{item.deliverySeconds == null ? relativeTime(item.created_at) : formatDuration(item.deliverySeconds)}</small>{["unknown", "failed"].includes(item.state) && <button className="flow-action-link" onClick={onPending}>前往处置</button>}</td><td className="mono">{shortId(item.platform_message_id) ?? "—"}</td><td><button className="icon-button" aria-label="查看任务" onClick={() => onTask(item.task_id)}><ChevronRight size={17} /></button></td></tr>)}</tbody></table></div></article>;
}

function Tasks() {
  const [params, setParams] = useSearchParams(); const navigate = useNavigate();
  const state = params.get("state") ?? ""; const q = params.get("q") ?? ""; const bot = params.get("bot") ?? "";
  const bots = useQuery({ queryKey: ["bot", "task-filter"], queryFn: () => api<AnyRecord>("/v1/admin/bots") });
  const tasks = useQuery({ queryKey: ["task", "list", state, bot, q], queryFn: () => api<AnyRecord>(`/v1/admin/tasks?${new URLSearchParams({ ...(state && { state }), ...(bot && { bot }), ...(q && { q }) })}`) });
  return <><PageTitle eyebrow="工作流" title="任务中心" description="从收件、判断到回复，按任务查看完整状态。" />
    <div className="filterbar"><div className="search"><Search size={18} /><input aria-label="搜索任务" placeholder="输入任务 ID 或会话 ID" defaultValue={q} onKeyDown={(e) => { if (e.key === "Enter") setParams({ ...(state && { state }), ...(bot && { bot }), ...((e.currentTarget.value) && { q: e.currentTarget.value }) }); }} /></div><select aria-label="机器人" value={bot} onChange={(e) => setParams({ ...(state && { state }), ...(e.target.value && { bot: e.target.value }), ...(q && { q }) })}><option value="">全部机器人</option>{bots.data?.items?.map((item: AnyRecord) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><select aria-label="任务状态" value={state} onChange={(e) => setParams({ ...(e.target.value && { state: e.target.value }), ...(bot && { bot }), ...(q && { q }) })}><option value="">全部状态</option>{Object.entries(stateLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
    <article className="panel table-panel">{!tasks.data ? <PageLoading compact /> : tasks.data.items.length ? <div className="table-wrap"><table><thead><tr><th>任务</th><th>机器人</th><th>状态</th><th>工作区</th><th>执行器</th><th>请求者</th><th>更新时间</th><th /></tr></thead><tbody>{tasks.data.items.map((task: AnyRecord) => <tr key={task.id} onClick={() => navigate(`/tasks/${task.id}`)}><td><strong className="mono">{task.id.slice(0, 8)}</strong><small>{task.chat_type === "p2p" ? "私聊" : "群聊"} · 会话第 {task.turn_index} 回合</small></td><td>{task.bot_display_name}</td><td><StateBadge state={task.state} /></td><td>{workspaceLabel(task)}</td><td>{task.executor_id ?? "等待分配"}</td><td>{task.requester_id}</td><td>{relativeTime(task.updated_at)}</td><td><ChevronRight size={17} /></td></tr>)}</tbody></table></div> : <Empty icon={<Inbox />} title="没有符合条件的任务" text="调整筛选条件后再试。" />}</article></>;
}

function TaskDetail({ user }: { user: AdminUser }) {
  const { id = "" } = useParams(); const task = useQuery({ queryKey: ["task", id], queryFn: () => api<AnyRecord>(`/v1/admin/tasks/${id}`) });
  const timeline = useQuery({ queryKey: ["task", id, "timeline"], queryFn: () => api<AnyRecord>(`/v1/admin/tasks/${id}/timeline`) });
  const trace = useQuery({ queryKey: ["task", id, "trace"], queryFn: () => api<AnyRecord>(`/v1/admin/tasks/${id}/trace`) });
  const [dialog, setDialog] = useState<string | null>(null);
  if (!task.data) return <PageLoading />; const d = task.data;
  const allowed = d.state === "failed" || d.state === "waiting_input" ? ["retry"] : d.state === "running" ? ["cancel", ...(d.worker?.capabilities?.includes("app_handoff") ? ["handoff"] : [])] : d.state === "human_owned" ? ["return_agent", "mark_completed"] : !["completed", "cancelled"].includes(d.state) ? ["cancel"] : [];
  return <><PageTitle eyebrow="任务详情" title={`任务 ${id.slice(0, 8)}`} description={`${d.chat_type === "p2p" ? "私聊任务" : "群聊任务"} · ${relativeTime(d.created_at)}创建`} action={<StateBadge state={d.state} />} />
    <div className="detail-grid"><section className="panel span-2"><div className="detail-header"><div><span className="label">当前状态</span><h2>{stateLabel[d.state] ?? d.state}</h2><p>最近更新于 {relativeTime(d.updated_at)}，已尝试 {d.attempt} 次。</p></div><div className="action-group">{allowed.map((command) => <button key={command} className={command === "cancel" ? "danger-button" : "secondary-button"} onClick={() => setDialog(command)}>{commandLabel(command)}</button>)}</div></div>
      <div className="fact-grid"><Fact label="机器人" value={d.bot_display_name} /><Fact label="会话" value={d.chat_type === "group" ? (d.chat_name ?? "群聊") : "私聊"} /><Fact label="会话回合" value={`第 ${d.turn_index} 回合`} /><Fact label="Chat ID" value={d.chat_id} /><Fact label="工作区" value={workspaceLabel(d)} /><Fact label="请求者" value={`${d.requester_role === "owner" ? "主人" : "成员"} · ${d.requester_id}`} /><Fact label="生命周期判断" value={d.conversation_disposition === "awaiting_followup" ? "等待续聊" : d.conversation_disposition === "complete" ? "会话结束" : "尚未判断"} /><Fact label="续聊截止" value={d.followup_expires_at ? new Date(d.followup_expires_at).toLocaleString("zh-CN") : "—"} /><Fact label="房间版本" value={`room_seq ${d.room_seq}`} /><Fact label="状态版本" value={`revision ${d.revision}`} /></div></section>
      <section className="panel"><PanelHead title="Codex 绑定" subtitle="同一配置恢复线程" /><dl className="detail-list"><Detail label="执行器" value={d.executor_id} /><Detail label="Codex Home" value={d.executor_home_ref} /><Detail label="Profile" value={d.executor_profile} /><Detail label="Thread" value={d.codex_thread_id} /><Detail label="配置指纹" value={d.executor_config_fingerprint} /></dl></section>
      <section className="panel"><PanelHead title="会话回合" subtitle="同一 Codex 线程连续处理" /><dl className="detail-list">{d.conversation_turns?.map((turn: AnyRecord) => <Detail key={turn.id} label={`第 ${turn.turn_index} 回合 · ${stateLabel[turn.state] ?? turn.state}`} value={turn.conversation_disposition === "awaiting_followup" ? "等待续聊" : turn.conversation_disposition === "complete" ? "会话结束" : "处理中"} />)}</dl></section>
      <section className="panel span-2"><PanelHead title="链路诊断" subtitle="自动检查每个阶段的数据完整性与上下游一致性" />{trace.data ? <div className="trace-check-grid">{trace.data.checks.map((item: AnyRecord, index: number) => <article className={`trace-check trace-${item.state}`} key={item.key}><div><span>{index + 1}</span><strong>{traceCheckLabel[item.key] ?? item.key}</strong><StateBadge state={item.state} /></div><p>{item.detail}</p><small>{item.startedAt ? new Date(item.startedAt).toLocaleTimeString("zh-CN") : "未开始"} → {item.completedAt ? new Date(item.completedAt).toLocaleTimeString("zh-CN") : "等待中"}{item.durationSeconds != null ? ` · ${formatDuration(item.durationSeconds)}` : ""}</small>{item.relatedIds?.length > 0 && <code title={item.relatedIds.join("\n")}>{item.relatedIds.map(shortId).join(" · ")}</code>}</article>)}</div> : <PageLoading compact />}</section>
      <section className="panel span-2"><PanelHead title="任务时间线" subtitle="按收件、执行、草稿、发送和生命周期查看技术事件" />{timeline.data?.items?.length ? <TimelineGroups items={timeline.data.items} /> : <Empty icon={<Activity />} title="尚无执行事件" text="执行器领取后会在这里记录进展。" />}</section>
      <section className="panel span-2"><PanelHead title="链路原始数据" subtitle="正文和技术字段直接展开；密钥、Session 与租约令牌不会返回" />{trace.data ? <TraceData data={trace.data} /> : <PageLoading compact />}</section>
    </div>{dialog && <CommandDialog command={dialog} task={d} user={user} onClose={() => setDialog(null)} />}</>;
}

function Workers({ user }: { user: AdminUser }) {
  const queryClient = useQueryClient();
  const workers = useQuery({ queryKey: ["worker"], queryFn: () => api<AnyRecord>("/v1/admin/workers") });
  const release = useQuery({ queryKey: ["runner-release"], queryFn: () => api<AnyRecord>("/v1/admin/runner-release"), refetchInterval: 300_000 });
  const enrollments = useQuery({ queryKey: ["worker-enrollments"], queryFn: () => api<AnyRecord>("/v1/admin/worker-enrollments") });
  const [target, setTarget] = useState<{ worker: AnyRecord; command: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const upgradeCommand = release.data?.installUrl && release.data?.publicBaseUrl ? `curl -fsSL '${release.data.installUrl}' | /bin/zsh -s -- --artifact-base '${release.data.publicBaseUrl}' --upgrade` : null;
  const recommendedVersion = release.data?.recommendedVersion as string | null | undefined;
  const recentEnrollments = enrollments.data?.items?.slice(0, 8) ?? [];
  const openEnrollment = () => {
    queryClient.removeQueries({ queryKey: ["new-worker-enrollment"] });
    setAdding(true);
  };
  return <><PageTitle eyebrow="本地能力" title="执行器" description="通过一次性注册指令挂载 Mac；每个实例固定绑定一组 Codex Home 与 Profile。" action={<button className="primary-button" disabled={release.data?.source === "unavailable"} onClick={openEnrollment}><Plus size={17} />添加执行器</button>} />
    {release.data?.source === "unavailable" && <div className="inline-alert"><AlertTriangle size={17} />Runner CDN manifest 当前不可用，暂时不能生成可靠的安装指令。</div>}
    <div className="card-grid">{workers.data?.items.map((worker: AnyRecord) => { const updateAvailable = Boolean(recommendedVersion && worker.runner_version && recommendedVersion !== worker.runner_version); const managementAvailable = Boolean(recommendedVersion && worker.runner_version === recommendedVersion); return <article className="worker-card" key={worker.executor_id}><div className="worker-card-top"><div className="machine-icon"><Server /></div><div><h3>{worker.display_name}</h3><p>{worker.executor_id}</p></div><StateBadge state={worker.operational_mode !== "enabled" ? worker.operational_mode : worker.availability} /></div><div className="worker-health"><div><span>最近心跳</span><strong>{relativeTime(worker.last_seen_at)}</strong></div><div><span>当前任务</span><strong>{worker.activeTasks}</strong></div><div><span>容量</span><strong>{worker.capacity}</strong></div></div><dl className="detail-list"><Detail label="Profile" value={worker.codex_profile} /><Detail label="Codex 版本" value={worker.codex_version} /><Detail label="Runner" value={worker.runner_version ? `${worker.runner_version}${updateAvailable ? `（可升级至 ${recommendedVersion}）` : "（最新）"}` : "版本未知"} /><Detail label="架构" value={worker.architecture} /><Detail label="注册方式" value={worker.registration_source === "quick_install" ? "快速注册" : "尚未通过设备注册"} /><Detail label="设备凭据" value={worker.credentialActive ? `有效 · ${relativeTime(worker.credentialLastUsedAt)}` : "未注册或已撤销"} /><Detail label="工作区" value={worker.workspace_aliases.join("、")} /><Detail label="能力" value={worker.capabilities.join("、")} /></dl><RunnerManagement worker={worker} available={managementAvailable} upgradeCommand={updateAvailable && upgradeCommand ? `${upgradeCommand} --executor-id '${worker.executor_id}'` : null} /><div className="card-actions">{updateAvailable && upgradeCommand && <CopyButton value={`${upgradeCommand} --executor-id '${worker.executor_id}'`} label="复制升级指令" />}{worker.operational_mode === "enabled" ? <button className="secondary-button" onClick={() => setTarget({ worker, command: "maintenance" })}>进入维护</button> : <button className="secondary-button" disabled={!worker.credentialActive} onClick={() => setTarget({ worker, command: "enable" })}>重新启用</button>}{worker.operational_mode !== "disabled" && <button className="danger-button" onClick={() => setTarget({ worker, command: "disable" })}>停用</button>}{worker.credentialActive && <button className="danger-button" onClick={() => setTarget({ worker, command: "revoke_credentials" })}>撤销凭据</button>}{worker.operational_mode === "disabled" && <button className="danger-button" onClick={() => setTarget({ worker, command: "delete" })}><Trash2 size={16} />删除</button>}</div></article>; }) ?? <PageLoading />}</div>
    {recentEnrollments.length > 0 && <section className="panel enrollment-history"><PanelHead title="最近注册指令" subtitle="令牌只保存哈希，原始安装指令仅在创建时显示" /><div className="stack-list">{recentEnrollments.map((item: AnyRecord) => <div className="enrollment-row" key={item.id}><code>{shortId(item.id)}</code><span className={`state-badge state-${item.state}`}>{({ pending: "待使用", used: "已使用", expired: "已过期", revoked: "已撤销" } as AnyRecord)[item.state] ?? item.state}</span><span>{item.executorId ?? "尚未使用"}</span><time>{relativeTime(item.createdAt)}</time></div>)}</div></section>}
    {target && <WorkerDialog {...target} user={user} onClose={() => { setTarget(null); void workers.refetch(); }} />}{adding && <EnrollmentDialog user={user} onClose={() => { setAdding(false); void enrollments.refetch(); void workers.refetch(); }} />}</>;
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
  const approvals = useQuery({ queryKey: ["approval"], queryFn: () => api<AnyRecord>("/v1/admin/approvals") }); const outbox = useQuery({ queryKey: ["outbox"], queryFn: () => api<AnyRecord>("/v1/admin/outbox") });
  return <><PageTitle eyebrow="需要介入" title="待处理" description="审批与发送异常集中在这里，避免遗漏关键判断。" />
    <div className="dashboard-grid"><section className="panel"><PanelHead title="待审批" subtitle="高风险动作仅主人决定" /><div className="stack-list">{approvals.data?.items.filter((x: AnyRecord) => x.state === "pending").map((item: AnyRecord) => <ApprovalItem key={item.id} item={item} user={user} />) ?? <PageLoading compact />}</div></section><section className="panel"><PanelHead title="异常发件箱" subtitle="结果不确定时不会自动重发" /><div className="stack-list">{outbox.data?.items.filter((x: AnyRecord) => x.state === "unknown").map((item: AnyRecord) => <OutboxItem key={item.id} item={item} user={user} />) ?? <PageLoading compact />}</div></section></div></>;
}

function Incidents({ user }: { user: AdminUser }) { const incidents = useQuery({ queryKey: ["incident"], queryFn: () => api<AnyRecord>("/v1/admin/incidents") }); return <><PageTitle eyebrow="系统健康" title="故障中心" description="相同问题会自动聚合，并在恢复后关闭。" /><article className="panel">{incidents.data?.items.length ? <div className="incident-list detailed">{incidents.data.items.map((item: AnyRecord) => <IncidentRow key={item.id} item={item} user={user} />)}</div> : <Empty icon={<CheckCircle2 />} title="没有故障记录" text="系统当前没有需要处理的问题。" />}</article></>; }
function CommandDialog({ command, task, user, onClose }: { command: string; task: AnyRecord; user: AdminUser; onClose(): void }) { const mutation = useMutation({ mutationFn: () => api(`/v1/admin/tasks/${task.id}/commands`, { method: "POST", body: commandBody(command, { expectedRevision: task.revision }) }, user), onSuccess: onClose }); return <Modal title={commandLabel(command)} onClose={onClose}><p>这会改变任务当前的“{stateLabel[task.state]}”状态。系统仍会使用状态版本防止并发覆盖。</p>{mutation.error && <ErrorBox error={mutation.error} />}<div className="modal-actions"><button className="ghost-button" onClick={onClose}>取消</button><button className={command === "cancel" ? "danger-button" : "primary-button"} disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "处理中…" : "确认执行"}</button></div></Modal>; }
function WorkerDialog({ worker, command, user, onClose }: { worker: AnyRecord; command: string; user: AdminUser; onClose(): void }) { const deleting = command === "delete"; const revoke = command === "revoke_credentials"; const mutation = useMutation({ mutationFn: () => api(`/v1/admin/workers/${worker.executor_id}${deleting ? "" : "/commands"}`, { method: deleting ? "DELETE" : "POST", ...(deleting ? {} : { body: commandBody(command) }) }, user), onSuccess: onClose }); const title = deleting ? "删除执行器" : revoke ? "撤销设备凭据" : command === "maintenance" ? "进入维护模式" : command === "disable" ? "停用执行器" : "重新启用执行器"; const message = deleting ? "执行器会从后台列表中移除，并撤销仍然有效的设备凭据。历史任务和链路记录会保留；这不会删除目标 Mac 上的 Runner 文件。" : revoke ? "撤销后，现有 Session 会立即失效，目标 Mac 必须使用新的注册指令重新挂载。" : "这只会改变任务领取权限，不会关闭 Mac 上的 Runner 进程；活跃任务不会被强制中断。"; return <Modal title={title} onClose={onClose}><p>{message}</p>{mutation.error && <ErrorBox error={mutation.error} />}<div className="modal-actions"><button className="ghost-button" onClick={onClose}>取消</button><button className={command === "disable" || revoke || deleting ? "danger-button" : "primary-button"} disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "处理中…" : deleting ? "确认删除" : "确认"}</button></div></Modal>; }
function ApprovalItem({ item, user }: { item: AnyRecord; user: AdminUser }) { const mutation = useMutation({ mutationFn: (approved: boolean) => api(`/v1/admin/approvals/${item.id}/decision`, { method: "POST", body: JSON.stringify({ approved }) }, user) }); return <div className="pending-item"><div className="pending-icon purple"><ShieldCheck /></div><div><strong>{item.method}</strong><span>任务 {item.task_id.slice(0, 8)} · {relativeTime(item.created_at)}</span></div><div className="vertical-actions"><button disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>批准</button><button className="text-danger" disabled={mutation.isPending} onClick={() => mutation.mutate(false)}>拒绝</button></div></div>; }
function OutboxItem({ item, user }: { item: AnyRecord; user: AdminUser }) { const mutation = useMutation({ mutationFn: (command: string) => api(`/v1/admin/outbox/${item.id}/commands`, { method: "POST", body: commandBody(command) }, user) }); return <div className="pending-item"><div className="pending-icon red"><AlertTriangle /></div><div><strong>消息发送结果不确定</strong><span>任务 {item.task_id.slice(0, 8)} · 已尝试 {item.attempt} 次</span><small>{item.last_error}</small></div><div className="vertical-actions"><button disabled={mutation.isPending} onClick={() => mutation.mutate("retry")}>原键重试</button><button disabled={mutation.isPending} onClick={() => mutation.mutate("mark_sent")}>标记已发送</button><button className="text-danger" disabled={mutation.isPending} onClick={() => window.confirm("确认放弃这条发件记录？") && mutation.mutate("discard")}>放弃</button></div></div>; }
function IncidentRow({ item, user }: { item: AnyRecord; user?: AdminUser }) { const mutation = useMutation({ mutationFn: () => api(`/v1/admin/incidents/${item.id}/acknowledge`, { method: "POST", body: JSON.stringify({}) }, user) }); return <div className={`incident-row ${item.severity}`}><div className="incident-severity"><AlertTriangle /></div><div><div className="row-title"><strong>{item.title}</strong><StateBadge state={item.state} /></div><p>{item.summary}</p><span>{relativeTime(item.last_seen_at)} · 已出现 {item.occurrence_count} 次</span>{user && item.state === "open" && <div className="ack-row"><button disabled={mutation.isPending} onClick={() => mutation.mutate()}>确认已知</button></div>}</div></div>; }

function TraceData({ data }: { data: AnyRecord }) {
  const sections = [["任务与会话", { task: data.task, conversation: data.conversation }], ["事件去重账本", data.processed_events], ["飞书信号", data.signals], ["任务事件", data.events], ["草稿", data.drafts], ["审批", data.approvals], ["单消息输出", data.output], ["输出更新", data.updates], ["发件箱", data.outbox], ["动作回执", data.actions]] as const;
  return <div className="trace-data">{sections.map(([title, value], index) => <details className="trace-data-section" key={title} open={index < 2}><summary>{title}<span>{Array.isArray(value) ? `${value.length} 条` : value ? "有记录" : "无记录"}</span></summary><pre>{JSON.stringify(value, null, 2)}</pre></details>)}</div>;
}

function FullPage({ children }: { children: ReactNode }) { return <div className="full-page">{children}</div>; }
function PageLoading({ compact = false }: { compact?: boolean }) { return <div className={compact ? "page-loading compact" : "page-loading"}><RefreshCw className="spin" /><span>正在读取最新状态…</span></div>; }
function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) { return <div className="page-title"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>; }
function PanelHead({ title, subtitle, link }: { title: string; subtitle: string; link?: string }) { return <div className="panel-head"><div><h2>{title}</h2><p>{subtitle}</p></div>{link && <NavLink to={link}>查看全部 <ChevronRight size={15} /></NavLink>}</div>; }
function Freshness() { return <div className="freshness"><span className="pulse" />实时更新</div>; }
function StateBadge({ state }: { state: string }) { return <span className={`state-badge state-${state}`}>{displayState(state)}</span>; }
function StatusDot({ state }: { state: string }) { return <span className={`status-dot ${state}`} />; }
function SummaryStat({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function MiniBars({ values }: { values: number[] }) { const list = values.length ? values : Array(24).fill(0); const max = Math.max(...list, 1); return <div className="mini-bars" aria-label="过去24小时任务量">{list.map((v, i) => <span key={i} style={{ height: `${Math.max(5, v / max * 100)}%` }} title={`${v} 个任务`} />)}</div>; }
function Fact({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Detail({ label, value }: { label: string; value?: string | null }) { return <div><dt>{label}</dt><dd title={value ?? ""}>{value ?? "—"}</dd></div>; }
function TimelineItem({ item }: { item: AnyRecord }) { const title = item.type === "signal" ? `收到${item.sender_role === "owner" ? "主人" : "成员"}信号` : item.type === "event" ? item.event_type : item.type === "draft" ? `草稿 · ${item.state}` : item.type === "approval" ? `审批 · ${item.method}` : item.type === "outbox" ? `发件箱 · ${item.state}` : item.type === "output" ? `单消息回复 · ${item.state}` : item.type === "output_update" ? `回复更新 · ${item.operation}` : `动作 · ${item.action_type}`; return <div className={`timeline-item type-${item.type}`}><div className="timeline-dot" /><div><div><strong>{title}</strong><time>{relativeTime(item.created_at)}</time></div><p>{item.summary ?? (item.decision ? `注意力判断：${item.decision}` : item.last_error ?? `状态：${item.state ?? "已记录"}`)}</p></div></div>; }
function TimelineGroups({ items }: { items: AnyRecord[] }) { const groups = [["收件", items.filter((item) => item.type === "signal")], ["执行", items.filter((item) => item.type === "event" && !String(item.event_type).startsWith("conversation."))], ["草稿", items.filter((item) => ["draft", "approval"].includes(item.type))], ["发送", items.filter((item) => ["output", "output_update", "outbox", "action"].includes(item.type))], ["生命周期", items.filter((item) => item.type === "event" && String(item.event_type).startsWith("conversation."))]] as const; return <div className="timeline-groups">{groups.filter(([, entries]) => entries.length).map(([title, entries]) => <section key={title}><h3>{title}<span>{entries.length}</span></h3><div className="timeline">{entries.map((item) => <TimelineItem key={`${item.type}-${item.id}`} item={item} />)}</div></section>)}</div>; }
function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="empty"><div>{icon}</div><strong>{title}</strong><p>{text}</p></div>; }
function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) { return <div className="modal-backdrop" onClick={onClose}><div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}><div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose}><X /></button></div>{children}</div></div>; }
function ErrorBox({ error }: { error: unknown }) { return <div className="inline-alert"><AlertTriangle size={17} />{error instanceof Error ? error.message : "操作失败"}</div>; }
function formatDuration(seconds: number) { return seconds < 60 ? `${Math.round(seconds)} 秒` : seconds < 3600 ? `${Math.round(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`; }
function workspaceLabel(task: AnyRecord) {
  if (task.resolved_workspace_alias) return task.requested_workspace_alias ? task.resolved_workspace_alias : `${task.resolved_workspace_alias}（自动选择）`;
  if (task.requested_workspace_alias) return `${task.requested_workspace_alias}（等待匹配）`;
  return "未指定";
}
function commandLabel(command: string) { return ({ retry: "重新排队", cancel: "取消任务", handoff: "请求本机接手", return_agent: "归还 Agent", mark_completed: "标记完成" } as Record<string, string>)[command] ?? command; }
function shortId(value?: string | null) { if (!value) return null; return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-5)}`; }
const traceCheckLabel: Record<string, string> = { event: "飞书事件接收", signal: "Signal 关联", attention: "注意力判断", executor: "执行器与工作区", codex: "Codex Thread", draft: "草稿新鲜度", sequence: "CardKit Sequence", outbox: "Output 与 Outbox", platform: "平台消息回执", lifecycle: "会话生命周期" };
function displayState(state: string) { return stateLabel[state] ?? decisionLabel[state] ?? ({ online: "在线", stale: "疑似离线", offline: "离线", enabled: "已启用", maintenance: "维护中", disabled: "已停用", open: "待处理", acknowledged: "已确认", resolved: "已恢复", success: "成功", normal: "正常", pending: "待使用", used: "已使用", expired: "已过期", revoked: "已撤销", "正常": "正常", "等待": "等待", "警告": "警告", "错误": "错误", drafted: "待检查", held: "已搁置", sent: "已发送", unknown: "结果未知", streaming: "流式更新", discarded: "已放弃" } as Record<string, string>)[state] ?? state; }
