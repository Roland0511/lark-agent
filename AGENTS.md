# AGENTS.md

## 适用范围

- 本文件适用于整个仓库。
- 更深层目录若存在自己的 `AGENTS.md`，以距离目标文件最近的规则为准。
- 修改前先阅读相关代码、测试和文档；不要仅凭文件名推断行为。

## 项目概览

这是一个把飞书消息桥接到 Codex 的 TypeScript 项目，主要由以下部分组成：

- `src/control-plane/`：Fastify 控制面、设备注册、任务调度和管理接口。
- `src/worker/`：运行在 macOS 设备上的 Runner，负责调用 Codex App Server。
- `src/lark/`：飞书事件、消息和 API 集成。
- `src/db/`：PostgreSQL 访问层和数据库迁移。
- `src/shared/`：控制面与 Runner 共用的协议、类型和工具。
- `src/manager/`：管理端相关服务逻辑。
- `admin/src/`：React 管理界面。
- `scripts/`：构建、发布和公开安全检查脚本。

运行时使用 PostgreSQL，不依赖 Redis。项目使用 pnpm、Node.js 22+、TypeScript NodeNext 和 Vitest。

## 常用命令

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm build:runner
pnpm check:public
```

- 单测或定向回归优先使用：`pnpm vitest run <测试文件>`。
- 数据库集成测试需要设置一次性测试库，例如：`TEST_DATABASE_URL=postgresql://... pnpm test`。
- 不要让测试连接生产或共享业务数据库。
- 仓库当前没有统一的 `lint` 脚本，不要虚构或把它作为必需检查。

## 开发约束

- 遵守现有 TypeScript 严格模式，包括 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`。
- 保持 ESM/NodeNext 的导入风格；本地模块导入延续现有 `.js` 后缀约定。
- 优先复用 `src/shared/` 中已有的协议和类型，避免控制面与 Runner 各自复制定义。
- 只修改任务所需内容，不进行无关重构、批量格式化或依赖升级。
- 工作区可能已有用户改动；修改前检查 `git status` 和相关 diff，不覆盖、不回滚未知变更。
- 禁止使用 `git reset --hard`、`git checkout --` 等破坏性命令，除非用户明确授权。
- 新增或修改行为时同步维护测试；修复缺陷时应添加能复现原问题的回归用例。

## 核心行为约束

- 飞书会话与 Codex Thread 的持久绑定、任务租约、幂等和状态机是可靠性边界，不得绕过。
- Continuity Fingerprint 只应表达影响 Thread 可恢复语义的配置，例如 Profile、Home、工作区或执行器身份。
- Codex 版本、App Server 协议版本等运行时信息属于 Runtime Fingerprint；变化可以触发 Runner 重启或能力刷新，但不应仅因此预先阻塞已有 Thread。
- 只有真实的执行环境连续性变化，或实际 resume 失败，才应把上下文标记为阻塞并要求新建 Thread。
- 修改指纹格式时必须保留旧版本到新版本的兼容迁移，避免升级后批量误阻塞已有任务。
- 修改共享协议、任务状态或设备能力时，同时检查控制面、Runner、数据库模型和集成测试。

## 数据库迁移

- 迁移文件位于 `src/db/migrations/`，使用递增编号并保持可重复部署。
- 已发布迁移不可重写；任何结构变化都通过新增迁移实现。
- 迁移需兼容已有数据，明确默认值、回填策略和回滚风险。
- 新增迁移后检查集成测试的数据库初始化逻辑；若测试显式枚举迁移文件，必须同步更新。
- 仓库迁移器会按文件名排序执行，不要改变既有迁移顺序。

## 验证要求

根据改动范围执行最小充分验证：

- 纯类型或局部逻辑改动：定向 Vitest + `pnpm typecheck`。
- 控制面、Runner、共享协议或状态机改动：相关单测/集成测试 + `pnpm typecheck` + `pnpm build`。
- Runner 打包改动：额外执行 `pnpm build:runner`。
- 数据库改动：使用一次性 PostgreSQL 测试库运行迁移和集成测试。
- 发布或公开仓库前：执行 `pnpm check:public`，并检查敏感信息扫描结果。

交付时说明实际执行过的检查及结果；未执行的检查要明确说明原因。

## 安全与敏感信息

- 不打开或打印 `.env`；用户明确授权部署时，可以按本机私有部署说明将它作为不透明文件传输，但不得回显其中内容。
- `.private/` 是被 Git 忽略的本机运维资料。执行用户已授权的部署或运维任务时可以按需读取相关说明文件，但只使用完成任务所需的信息，不在回复或日志中回显敏感内容。
- `.env`、`.private/`、访问令牌、设备凭据、加密密钥、飞书 App Secret、Open ID、内部地址和完整敏感日志不得提交、同步或复制到公开仓库。
- 示例和测试使用明显的虚构值；日志和错误信息必须脱敏。
- 技能运行时凭据应保持加密存储，落盘敏感文件权限维持 `0600`。
- 不把构建产物、设备日志、临时文件或本地凭据加入版本控制。

## 发布与部署

- 未经用户明确要求，不执行发布、部署、推送或创建 PR。
- 涉及控制面与 Runner 协议兼容性时，优先部署向后兼容的控制面，再升级 Runner。
- 发布 Runner 前先执行 `pnpm publish:runner --dry-run`；确认产物和校验和后再正式发布。
- Runner 发布资源应保持不可变，上传后进行 CDN 回读校验，最后更新 manifest，避免客户端读到不完整版本。

## 提交规范

- 只有用户明确要求时才提交。
- 提交前确认本次变更范围，避免混入用户已有改动。
- 提交信息格式为 `<type>(<scope>): <subject>`；`type` 和代码模块类 `scope` 使用英文，`subject` 使用简体中文且不超过 50 个字符。
- 提交正文如有，也使用简体中文。
