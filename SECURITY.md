# 安全策略

请不要在公开 Issue 中提交飞书 App Secret、Open ID、设备凭据、Codex provider token、会话令牌、内网地址或日志正文。

发现安全问题时，请通过 GitHub Security Advisory 私下报告，并附上最小复现步骤。公开仓库只提供自托管软件，不托管任何用户凭据或消息数据。

部署前请完成以下检查：

- 从 `.env.example` 创建本地 `.env`，不要提交真实值。
- 将 Runner 发布凭据和私有部署记录放在 `.private/` 或其他 Git 忽略目录。
- 使用 `pnpm check:public` 和 secret scanner 检查待提交内容。
- `SKILLHUB_API_TOKEN` 和 `SKILL_RUNTIME_ENCRYPTION_KEYS` 只允许出现在私有部署环境中，不得写入仓库、任务事件或 Runner 配置。
- 轮换技能运行依赖密钥时，必须保留仍被历史修订引用的旧 key ID；系统不会自动重加密历史修订，只有相关修订已被覆盖或删除后才能移除旧 key。缺少解密密钥时控制面应 fail closed。
- 后台上传的技能配置文件会以 `0600` 明文持续保留在对应聊天工作区。只为可信技能配置最小权限凭证，并定期检查后台的漂移与待删除状态。
- 机器人/Thread 作用域不是同一 Runner 内的 OS 安全边界；需要跨租户秘密隔离时，应拆分 Runner、系统用户或容器，并配置强制文件访问沙箱。
- 限制控制台、PostgreSQL、Runner CDN 和指标端点的网络访问范围。
