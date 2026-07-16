# 控制台重设计验收记录

> 验收日期：2026-07-14
> 验收结论：已实现并通过本次设计、交互、安全恢复、响应式、构建与专项测试验收。

## 1. 验收范围与信息架构

本次验收覆盖控制台全部左侧一级页面，以及从一级页面自然下钻的关键二级体验。功能语义保持不变；调整集中在信息分层、重点结论、上下文导航和按需展开。

| 层级 | 已确认结构 | 首层重点 | 按需获取的明细 |
| --- | --- | --- | --- |
| 一级导航 | 运行总览、任务中心、机器人、执行器、待处理、故障中心 | 当前结论、需介入事项、正在处理的对象 | 页面内详情、折叠分组、二级工作台 |
| 运行总览 | 系统结论 → 运行对象 → 需关注事项 → 最近任务 | 整体状态、对象健康、最近变化 | 对象详情与任务详情 |
| 任务中心 | 合并原处理流水与任务中心 | 当前任务、状态、执行器、更新时间 | 流程态势、八阶段详情、诊断、时间线、原始 Trace |
| 机器人 | 主从分栏 | 当前机器人接入结论与独立状态 | 角色路由、群聊与主人、接入安全、聊天记忆 |
| 执行器 | 主从分栏 | 在线、领取模式、设备凭据、活跃任务/容量 | 环境与能力、设备端管理、安全与生命周期 |
| 待处理 | 行动收件箱式主从分栏 | 审批决定、发送结果不确定 | 业务上下文、幂等键与处置动作说明 |
| 故障中心 | 单列分层台账 | 未恢复数量、严重程度、当前故障 | 单条展开与已恢复历史 |
| 二级体验 | 任务八阶段画布、聊天记忆工作台 | 异常阶段或阻塞结论 | 安全核验、绑定信息、关联任务、自动压缩记录 |

信息语义复核通过：机器人权限、凭据、启用意图、主人绑定、系统通知身份和消息订阅没有合并；执行器在线状态、领取模式、设备凭据和活跃任务没有合并；任务状态与聊天记忆状态没有混为同一结论。

## 2. 视觉方案与实现对比

对比图均为“已确认参考方向 + 当前实现”的并排证据。验收标准是结构、信息优先级、下钻关系和关键状态表达对齐；业务数据与文案按真实 API 能力适配，不要求机械复制参考图。

| 页面/体验 | 已确认参考 | 当前实现 | 对比证据 | 结论 |
| --- | --- | --- | --- | --- |
| 运行总览：运行对象 | [参考图](artifacts/console-redesign/overview-object-health-reference.png) | [桌面实现](artifacts/console-redesign/implementation-qa/overview-object-health-final.png) | [并排对比](artifacts/console-redesign/implementation-qa/comparisons/overview-object-health-comparison.png) | 结论、运行对象、需关注事项顺序一致 |
| 运行总览：最近任务 | [参考图](artifacts/console-redesign/overview-recent-tasks-reference.png) | [完整页面](artifacts/console-redesign/implementation-qa/overview-full-final.png) | [并排对比](artifacts/console-redesign/implementation-qa/comparisons/overview-recent-tasks-comparison.png) | 最近任务保持低密度列表和自然下钻 |
| 任务中心 | [参考图](artifacts/console-redesign/task-center-flow-reference.png) | [桌面实现](artifacts/console-redesign/implementation-qa/task-center-layered-final.png) | [并排对比](artifacts/console-redesign/implementation-qa/comparisons/task-center-comparison.png) | 原处理流水与任务中心合并，功能入口分层保留 |
| 任务八阶段详情 | [参考图](artifacts/console-redesign/task-detail-stage-canvas-reference.png) | [桌面实现](artifacts/console-redesign/implementation-qa/task-detail-stage-canvas-final.png) | [并排对比](artifacts/console-redesign/implementation-qa/comparisons/task-detail-comparison.png) | 异常阶段突出，诊断与 Trace 逐层下沉 |
| 机器人 | [参考图](artifacts/console-redesign/bots-master-detail-reference.png) | [桌面实现](artifacts/console-redesign/implementation-qa/bots-master-detail-final.png) | [并排对比](artifacts/console-redesign/implementation-qa/comparisons/bots-comparison.png) | 主从关系与独立状态表达对齐 |
| 聊天记忆二级工作台 | [参考图](artifacts/console-redesign/bots-chat-memory-secondary-workspace-reference.png) | [阻塞态实现](artifacts/console-redesign/implementation-qa/chat-memory-blocked-final.png) | [并排对比](artifacts/console-redesign/implementation-qa/comparisons/chat-memory-comparison.png) | 一级导航仍选中机器人，阻塞结论与恢复条件优先 |
| 执行器 | [参考图](artifacts/console-redesign/workers-master-detail-reference.png) | [桌面实现](artifacts/console-redesign/implementation-qa/workers-master-detail-final.png) | [并排对比](artifacts/console-redesign/implementation-qa/comparisons/workers-comparison.png) | 状态拆分、能力与生命周期分层对齐 |
| 待处理 | [参考图](artifacts/console-redesign/pending-master-detail-reference.png) | [桌面实现](artifacts/console-redesign/implementation-qa/pending-master-detail-final.png) | [并排对比](artifacts/console-redesign/implementation-qa/comparisons/pending-comparison.png) | 审批与发件箱保持独立语义 |
| 故障中心 | [参考图](artifacts/console-redesign/incidents-layered-register-reference.png) | [桌面实现](artifacts/console-redesign/implementation-qa/incidents-layered-register-final.png) | [并排对比](artifacts/console-redesign/implementation-qa/comparisons/incidents-comparison.png) | 当前故障优先，已恢复历史降级展示 |

## 3. 响应式截图证据

- 桌面端以 1487 × 1058 精确单视口完成六个一级页面及两组二级体验回测；截图通过 Chrome DevTools Protocol 直接捕获目标视口，没有 full-page sticky 拼接伪影：[运行总览](artifacts/console-redesign/implementation-qa/overview-viewport-final.png)、[任务中心](artifacts/console-redesign/implementation-qa/task-center-viewport-final.png)、[任务详情](artifacts/console-redesign/implementation-qa/task-detail-viewport-final.png)、[机器人](artifacts/console-redesign/implementation-qa/bots-viewport-final.png)、[聊天记忆](artifacts/console-redesign/implementation-qa/chat-memory-viewport-final.png)、[执行器](artifacts/console-redesign/implementation-qa/workers-viewport-final.png)、[待处理](artifacts/console-redesign/implementation-qa/pending-viewport-final.png)、[故障中心](artifacts/console-redesign/implementation-qa/incidents-viewport-final.png)。
- 平板端以 1009 px 宽完成总览完整页面检查：[运行总览平板截图](artifacts/console-redesign/implementation-qa/overview-tablet-full.png)。对象卡、需关注事项和最近任务按顺序自然换行，没有把桌面高密度布局直接压缩。
- 移动端以 390 px 宽验证代表性主流程：[任务中心](artifacts/console-redesign/implementation-qa/task-center-mobile-full.png)、[任务八阶段详情](artifacts/console-redesign/implementation-qa/task-detail-mobile-full.png)、[聊天记忆列表](artifacts/console-redesign/implementation-qa/chat-memory-mobile-list-full.png)、[聊天记忆详情](artifacts/console-redesign/implementation-qa/chat-memory-mobile-detail-full.png)。主从布局转为列表 → 详情路径，返回关系和内容顺序保持清晰。

## 4. 交互回测

- 左侧导航只保留六个一级页面；旧 `/flow` 地址会迁移到任务中心的流程视图，并保留原查询参数。
- 总览中的机器人、执行器、待处理、故障和最近任务均可进入对应对象或任务详情，不需要先理解技术 ID。
- 任务中心的任务列表、流程、Agent 收件箱和发件箱可切换；筛选、任务选择、详情展开和深链均保持可用。
- 任务详情按八阶段展示。正常阶段默认收起，异常阶段自动突出；聊天记忆阻塞时隐藏无效的普通重试，改为进入聊天记忆恢复。
- 机器人主从选择、聊天记忆入口、状态筛选、搜索、列表 → 详情和返回路径均通过回测。
- 执行器主从选择、能力与生命周期折叠层级可用；设备管理仍只复制本机命令，没有被误写成远程控制。
- 待处理可在审批与发送结果不确定之间切换。审批拒绝、原键重试、标记已发送、放弃等原有语义及确认层级保留；本次本地验收没有向外部飞书发送真实动作。
- 故障按当前/已恢复分层；“确认已知”仍只更新生命周期，不冒充故障解决。
- 桌面与移动端导航、主从布局降级、折叠内容和焦点可见性完成检查；浏览器控制台未出现 warning 或 error。

浏览器回测使用 Chrome `Default` Profile（显示名 `he`）。临时测试标签页在验收后已清理。本地 QA 环境关闭飞书与告警外发，避免交互回测产生外部副作用。

## 5. 安全恢复方案 B 验证

恢复操作严格核验原 Thread、原执行器及聊天能力、Profile、Home 身份、工作区别名和环境指纹。只有全部通过才允许聊天记忆从 `blocked` 转为 `ready`；恢复不会切换执行器、创建新 Thread、迁移工作区或自动重试关联任务。

| 场景 | 实际结果 | 证据 |
| --- | --- | --- |
| 失败路径 | 仅环境指纹不一致时返回 `check_failed`；审计记录 `blocked → blocked`，失败键为 `configFingerprint`，界面逐项标出不一致条件 | [失败结果截图](artifacts/console-redesign/implementation-qa/chat-memory-recovery-failed-final.png) |
| 成功路径 | 对齐原环境指纹后返回 `recovered`；审计记录 `blocked → ready`，失败键为空，所有条件逐项通过 | [成功结果截图](artifacts/console-redesign/implementation-qa/chat-memory-recovery-success-final.png) |
| 无隐式重试 | 两次恢复尝试后，关联任务仍为 `waiting_input`，revision 保持 `4`；证明恢复只解除聊天记忆阻塞，不自动推进任务 | PostgreSQL 审计行与关联任务快照 |

为保留可重复验收的初始条件，截图完成后已把本地 fixture 恢复为 `blocked`；失败与成功两次恢复尝试仍保留在审计记录中。

## 6. 构建与测试结果

| 检查项 | 结果 |
| --- | --- |
| 控制台 TypeScript typecheck | 通过 |
| 后端 TypeScript typecheck | 通过 |
| 控制台生产构建 `pnpm build` | 通过 |
| 公开发布安全检查 `pnpm check:public` | 通过 |
| 全仓 Vitest | 19/19 个文件、131/131 个测试通过 |
| 聊天记忆前端专项测试 | 2/2 通过 |
| 聊天记忆恢复路由单元测试 | 5/5 通过 |
| 隔离真实 PostgreSQL 控制面集成测试 | 53/53 通过 |
| Chrome 桌面与 390 × 844 移动视口交互回测 | 通过 |

以上数字均对应本次明确执行并留有结果的检查；全仓测试套件已在最终代码上重新执行。

## 7. 最终结论

六个一级页面、任务八阶段详情、聊天记忆二级工作台与安全恢复方案 B 均与已确认的信息架构一致。首层能够一眼判断整体状态和需介入事项，高密度技术信息通过详情、折叠或二级工作台自然获取；原有功能语义未因视觉重构而删除或混淆。本次验收范围内未发现阻断交付的问题。

## 8. 技能管理渐进式界面增量验收（2026-07-16）

- 技能来源统一为“环境继承”“机器人配置”“聊天配置”，列表范围统一为“所有聊天”或“当前聊天”；面向用户的主界面不再混用 `.runner`、Runner、Thread 等技术术语。
- 总览、指定聊天技能列表和技能详情抽屉分别与已确认设计图在相同 1586 × 992 视口中并排对照，作用域树、首层摘要、来源与范围、状态、详情操作及技术信息折叠层级一致。
- 真实页面完成“机器人 → 管理技能 → 指定聊天 → 技能列表 → 详情抽屉 → 添加技能面板”主路径回测。添加面板会收起详情抽屉，且只保留一个提交按钮；环境继承技能保持只读，机器人配置与聊天配置保持可配置。
- 本地控制面使用隔离的回归数据，飞书事件消费关闭；未提交技能、凭证、文件或任何外部动作。页面控制台无 error。
- 当前代码通过 TypeScript 类型检查、11/11 技能管理专项测试、全仓 143 个测试（另有 74 个按环境跳过）、生产构建与公开发布安全检查。

final result: passed

## 9. Thread 记忆弹窗增量验收（2026-07-16）

- 参考视觉：ImageGen 方案 2（搜索与筛选样式）与方案 3（弹窗尺寸、位置与对话布局）。
- 实现证据：本地 1440 × 1024 桌面捕获、390 × 844 移动端捕获，以及同尺寸完整视图和聚焦区域并排对照；验收图片仅保存在本地，不提交真实 Thread 内容。
- 验收状态：使用线上数据副本，共 18 项快照；弹窗打开；全部参与者与全部内容类型；默认定位最新回合。
- 无遗留 P0/P1/P2 问题。弹窗保持方案 3 的 1220px 上限与近全高比例，左侧回合导航、中间独立滚动对话区、右侧筛选栏比例稳定；原页面只保留紧凑入口。
- 搜索与筛选采用方案 2 的输入框、参与者单选和内容类型复选样式；本 Agent 消息靠右，用户与其它 Agent 消息靠左；最终回复默认展示，完整提示词与原始 JSON 按需向下展开。
- 初始对照发现默认滚动后回合高亮可能不准确、最新消息贴近底边，已通过双帧定位、底部阈值识别和间距修正解决；聚焦对照发现正文与筛选文字略小，统一上调 1px 后复测通过。
- 已回测打开与关闭、背景页滚动锁定、默认定位最新回合、跳到最新、搜索结果数、参与者与内容类型组合筛选、空结果提示、提示词展开、原始 JSON 切换、移动端无水平溢出；浏览器 console error 为 0。
- 当前代码通过 TypeScript 类型检查、全仓测试、生产构建与公开发布安全检查。

final result: passed

## 10. Thread 记忆直达定位、回合摘要与字号增量验收（2026-07-16）

- 已将上一版的双帧延迟定位替换为 `useLayoutEffect` 布局阶段直达：弹窗首次绘制前以 `behavior: auto` 定位最新消息，初始高亮直接指向最新回合，不产生平滑滚动或可见跳动。
- 内容末尾使用可观测锚点判断真实底部状态。“回到最新”仅在锚点离开视口时出现；滚回底部、筛选、详情展开/收起或内容尺寸变化后都会重新判定，锚点回到视口后同步隐藏。专项测试同时覆盖滚动数值与 `IntersectionObserver` 进入/离开视口两条路径。
- 左侧导航优先显示持久化 AI 摘要，保留“回合 N · 耗时”次行；旧快照或摘要缺失时从首条可见用户、本 Agent 或其它 Agent 消息生成临时标题，不再退回机械的“回合 X”。标题限制 24 个字符、最多两行，并通过 `title` 保留完整内容。
- Runner 摘要使用独立、懒启动、可重启的净化 Codex Home，仅继承认证与模型/provider 配置；不继承 MCP、插件、技能、Hook 或工作区。Thread 与 Turn 均为只读、禁网且清空动态工具、环境与能力根；超时、协议异常、无归属通知或工具尝试只让当前批次回退，不影响原 Thread、快照完成或正常 Runner。
- 字号统一到后台既有层级：对话正文 14px，搜索、导航、筛选和作者 13px，状态、辅助操作、完整提示词与原始 JSON 详情 12px，只有技术 ID 保持 10px。左侧导航为 190px，弹窗上限维持 1220 × 880。
- 使用线上数据副本完成 1440 × 1024、1280 × 720 和 390 × 844 三档回测：首次打开均直接位于底部且不显示浮动按钮；离开底部后按钮出现，点击后回到底部并隐藏；搜索、参与者/内容类型筛选、完整提示词展开、原始 JSON 切换和移动端横向筛选均正常。
- 当前最终代码通过 TypeScript 类型检查、28/28 个测试文件与 264/264 个测试、生产构建、公开发布安全检查、Compose 配置校验及 Runner 发布 dry-run；浏览器回测未出现 warning 或 error。

final result: passed
