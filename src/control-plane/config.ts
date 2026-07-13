import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SIGNING_SECRET: z.string().min(32),
  OWNER_OPEN_ID: z.string().min(1),
  BOT_APP_ID: z.string().min(1),
  AGENT_DISPLAY_NAME: z.string().min(1).default("Lark Agent"),
  WHITELIST_CHAT_IDS: z.string().default(""),
  LARK_ENABLED: z.enum(["true", "false"]).default("false"),
  LARK_CARD_ACTIONS_ENABLED: z.enum(["true", "false"]).default("false"),
  LARK_CLI_PATH: z.string().default("lark-cli"),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  TRACE_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
  LEASE_SECONDS: z.coerce.number().int().min(30).default(60),
  SESSION_MINUTES: z.coerce.number().int().min(5).default(60),
  ADMIN_ORIGIN: z.string().url().default("http://127.0.0.1:3000"),
  ADMIN_SESSION_HOURS: z.coerce.number().int().positive().default(12),
  ADMIN_IDLE_MINUTES: z.coerce.number().int().positive().default(120),
  METRICS_BEARER_TOKEN: z.string().default(""),
  ALERTS_ENABLED: z.enum(["true", "false"]).default("true"),
  RUNNER_ARTIFACT_PUBLIC_BASE_URL: z.string().url(),
  RUNNER_MANIFEST_REFRESH_SECONDS: z.coerce.number().int().min(30).default(300)
});

export interface ControlPlaneConfig {
  host: string;
  port: number;
  databaseUrl: string;
  sessionSigningSecret: string;
  ownerOpenId: string;
  botAppId: string;
  agentDisplayName: string;
  whitelistChatIds: Set<string>;
  larkEnabled: boolean;
  larkCardActionsEnabled: boolean;
  larkCliPath: string;
  messageRetentionDays: number;
  traceRetentionDays: number;
  leaseSeconds: number;
  sessionMinutes: number;
  adminOrigin: string;
  adminSessionHours: number;
  adminIdleMinutes: number;
  metricsBearerToken: string;
  alertsEnabled: boolean;
  runnerArtifactPublicBaseUrl: string;
  runnerManifestRefreshSeconds: number;
}

export function loadControlPlaneConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const parsed = envSchema.parse(env);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    sessionSigningSecret: parsed.SESSION_SIGNING_SECRET,
    ownerOpenId: parsed.OWNER_OPEN_ID,
    botAppId: parsed.BOT_APP_ID,
    agentDisplayName: parsed.AGENT_DISPLAY_NAME,
    whitelistChatIds: new Set(parsed.WHITELIST_CHAT_IDS.split(",").map((value) => value.trim()).filter(Boolean)),
    larkEnabled: parsed.LARK_ENABLED === "true",
    larkCardActionsEnabled: parsed.LARK_CARD_ACTIONS_ENABLED === "true",
    larkCliPath: parsed.LARK_CLI_PATH,
    messageRetentionDays: parsed.MESSAGE_RETENTION_DAYS,
    traceRetentionDays: parsed.TRACE_RETENTION_DAYS,
    leaseSeconds: parsed.LEASE_SECONDS,
    sessionMinutes: parsed.SESSION_MINUTES,
    adminOrigin: parsed.ADMIN_ORIGIN.replace(/\/$/, ""),
    adminSessionHours: parsed.ADMIN_SESSION_HOURS,
    adminIdleMinutes: parsed.ADMIN_IDLE_MINUTES,
    metricsBearerToken: parsed.METRICS_BEARER_TOKEN,
    alertsEnabled: parsed.ALERTS_ENABLED === "true",
    runnerArtifactPublicBaseUrl: parsed.RUNNER_ARTIFACT_PUBLIC_BASE_URL.replace(/\/$/, ""),
    runnerManifestRefreshSeconds: parsed.RUNNER_MANIFEST_REFRESH_SECONDS
  };
}
