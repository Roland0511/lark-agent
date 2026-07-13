import { z } from "zod";
import { createDatabase } from "../db/database.js";
import { loadControlPlaneConfig } from "./config.js";
import { buildControlPlane } from "./app.js";
import { NdjsonConsumer } from "../lark/cli.js";
import type { LarkCardActionEvent, LarkMessageEvent } from "../shared/contracts.js";
import { RetentionService } from "./retention.js";
import { RuntimeStatus } from "./runtime-status.js";
import { IncidentService } from "./incidents.js";

const messageEventSchema = z.object({
  type: z.literal("im.message.receive_v1"),
  event_id: z.string(),
  timestamp: z.string(),
  message_id: z.string(),
  chat_id: z.string(),
  chat_type: z.enum(["p2p", "group"]),
  sender_id: z.string(),
  message_type: z.string(),
  content: z.string(),
  create_time: z.string()
});

const cardEventSchema = z.object({
  type: z.literal("card.action.trigger"),
  event_id: z.string(),
  timestamp: z.string(),
  operator_id: z.string(),
  message_id: z.string(),
  chat_id: z.string(),
  action_tag: z.string(),
  action_value: z.string(),
  token: z.string()
});

const config = loadControlPlaneConfig();
const db = createDatabase(config.databaseUrl);
const consumers: NdjsonConsumer[] = [];
const runtime = new RuntimeStatus();
runtime.configure("im.message.receive_v1", config.larkEnabled, true);
runtime.configure("card.action.trigger", config.larkEnabled && config.larkCardActionsEnabled, false);
const { app, services } = buildControlPlane(db, config, undefined, {
  isLarkReady: () => runtime.requiredReady(),
  runtime
});

if (config.larkEnabled) {
  const onReady = (eventKey: string) => {
    runtime.ready(eventKey);
    services.adminEvents.publish("runtime");
    app.log.info({ eventKey }, "lark event consumer ready");
  };
  const onError = (eventKey: string) => (error: Error) => {
    runtime.error(eventKey, error);
    services.adminEvents.publish("runtime");
    app.log.error({ err: error, eventKey }, "lark event consumer error");
  };
  consumers.push(
    new NdjsonConsumer(config.larkCliPath, "im.message.receive_v1", async (event) => {
      await services.router.handleMessage(messageEventSchema.parse(event) as LarkMessageEvent);
    }, onReady, onError("im.message.receive_v1"))
  );
  if (config.larkCardActionsEnabled) {
    consumers.push(new NdjsonConsumer(config.larkCliPath, "card.action.trigger", async (event) => {
      await services.router.handleCardAction(cardEventSchema.parse(event) as LarkCardActionEvent);
    }, onReady, onError("card.action.trigger")));
  }
  consumers.forEach((consumer) => consumer.start());
}

const retention = new RetentionService(db, config.messageRetentionDays, config.traceRetentionDays);
await retention.runOnce();
const retentionTimer = setInterval(() => void retention.runOnce().catch((error) => app.log.error({ err: error }, "retention failed")), 24 * 60 * 60 * 1000);
retentionTimer.unref();
const leaseTimer = setInterval(() => void services.repository.recoverExpiredLeases().catch((error) => app.log.error({ err: error }, "lease recovery failed")), 10_000);
leaseTimer.unref();
await services.repository.expireFollowupConversations();
const followupTimer = setInterval(() => void services.repository.expireFollowupConversations().catch((error) => app.log.error({ err: error }, "follow-up expiry failed")), 30_000);
followupTimer.unref();
const incidentService = new IncidentService(db, config, services.lark, runtime, services.adminEvents);
await incidentService.evaluate();
const incidentTimer = setInterval(() => void incidentService.evaluate().catch((error) => app.log.error({ err: error }, "incident evaluation failed")), 30_000);
incidentTimer.unref();

await app.listen({ host: config.host, port: config.port });

async function shutdown(): Promise<void> {
  clearInterval(retentionTimer);
  clearInterval(leaseTimer);
  clearInterval(followupTimer);
  clearInterval(incidentTimer);
  await Promise.all(consumers.map((consumer) => consumer.stop()));
  await app.close();
  await db.destroy();
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
