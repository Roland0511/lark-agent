# 安全策略

请不要在公开 Issue 中提交飞书 App Secret、Open ID、设备凭据、Codex provider token、会话令牌、内网地址或日志正文。

发现安全问题时，请通过 GitHub Security Advisory 私下报告，并附上最小复现步骤。公开仓库只提供自托管软件，不托管任何用户凭据或消息数据。

部署前请完成以下检查：

- 从 `.env.example` 创建本地 `.env`，不要提交真实值。
- 将 Runner 发布凭据和私有部署记录放在 `.private/` 或其他 Git 忽略目录。
- 使用 `pnpm check:public` 和 secret scanner 检查待提交内容。
- 限制控制台、PostgreSQL、Runner CDN 和指标端点的网络访问范围。
