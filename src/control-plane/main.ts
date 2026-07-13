import { createDatabase } from "../db/database.js";
import { loadControlPlaneConfig } from "./config.js";
import { buildControlPlane } from "./app.js";
import { RetentionService } from "./retention.js";
import { RuntimeStatus } from "./runtime-status.js";
import { IncidentService } from "./incidents.js";
import { bootstrapLegacyBot, BotRuntimeManager } from "./bot-runtime.js";
import { registerBotAdminRoutes } from "./bot-admin-routes.js";

const config = loadControlPlaneConfig();
const db = createDatabase(config.databaseUrl);
await bootstrapLegacyBot(db, config);
const runtime = new RuntimeStatus();
let botRuntime: BotRuntimeManager | null = null;
const { app, services } = buildControlPlane(db, config, undefined, {
  isLarkReady: () => botRuntime?.messageReady() ?? !config.larkEnabled,
  runtime
});
botRuntime = new BotRuntimeManager(db, config, services.repository, services.gateways, runtime, services.adminEvents, app.log);
await botRuntime.startAll();
registerBotAdminRoutes(app, db, config, { gateways: services.gateways, runtime, events: services.adminEvents, controller: botRuntime });

const retention = new RetentionService(db, config.messageRetentionDays, config.traceRetentionDays);
await retention.runOnce();
const retentionTimer = setInterval(() => void retention.runOnce().catch((error) => app.log.error({ err: error }, "retention failed")), 24 * 60 * 60 * 1000);
retentionTimer.unref();
const leaseTimer = setInterval(() => void services.repository.recoverExpiredLeases().catch((error) => app.log.error({ err: error }, "lease recovery failed")), 10_000);
leaseTimer.unref();
await services.repository.expireFollowupConversations();
const followupTimer = setInterval(() => void services.repository.expireFollowupConversations().catch((error) => app.log.error({ err: error }, "follow-up expiry failed")), 30_000);
followupTimer.unref();
const incidentService = new IncidentService(db, config, services.gateways, runtime, services.adminEvents);
await incidentService.evaluate();
const incidentTimer = setInterval(() => void incidentService.evaluate().catch((error) => app.log.error({ err: error }, "incident evaluation failed")), 30_000);
incidentTimer.unref();

await app.listen({ host: config.host, port: config.port });

async function shutdown(): Promise<void> {
  clearInterval(retentionTimer);
  clearInterval(leaseTimer);
  clearInterval(followupTimer);
  clearInterval(incidentTimer);
  await botRuntime?.stopAll();
  await app.close();
  await db.destroy();
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
