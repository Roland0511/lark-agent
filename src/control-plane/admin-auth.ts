import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Database } from "../db/types.js";
import { randomToken, sha256 } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";
import type { ControlPlaneConfig } from "./config.js";

const COOKIE_NAME = "lark_agent_admin_session";
const consumeSchema = z.object({ token: z.string().min(32).max(256) });

export interface AdminPrincipal {
  openId: string;
  displayName: string | null;
  role: "owner";
  csrfToken: string;
}

export function adminRoleFor(config: ControlPlaneConfig, openId: string): AdminPrincipal["role"] | null {
  return openId === config.ownerOpenId ? "owner" : null;
}

function cookieOptions(config: ControlPlaneConfig) {
  const path = new URL(config.adminOrigin).pathname.replace(/\/+$/, "") || "/";
  return {
    path,
    httpOnly: true,
    secure: config.adminOrigin.startsWith("https://"),
    sameSite: "lax" as const
  };
}

export async function requireAdmin(
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  request: FastifyRequest,
  _ownerOnly = false
): Promise<AdminPrincipal> {
  const token = request.cookies[COOKIE_NAME];
  if (!token) throw new AppError("请先通过飞书连接控制台", 401, "admin_unauthorized");
  const now = new Date();
  const idleCutoff = new Date(Date.now() - config.adminIdleMinutes * 60_000);
  const session = await db.selectFrom("admin_sessions").selectAll()
    .where("token_hash", "=", sha256(token))
    .where("expires_at", ">", now)
    .where("last_seen_at", ">", idleCutoff)
    .executeTakeFirst();
  if (!session) throw new AppError("控制台连接已过期，请重新连接", 401, "admin_session_expired");
  const currentRole = adminRoleFor(config, session.open_id);
  if (!currentRole) throw new AppError("当前飞书身份不在控制台白名单", 403, "admin_forbidden");
  await db.updateTable("admin_sessions").set({ last_seen_at: now, role: currentRole }).where("token_hash", "=", session.token_hash).execute();
  return { openId: session.open_id, displayName: session.display_name, role: currentRole, csrfToken: session.csrf_token };
}

export function requireCsrf(request: FastifyRequest, principal: AdminPrincipal): void {
  const supplied = request.headers["x-csrf-token"];
  if (typeof supplied !== "string" || supplied !== principal.csrfToken) {
    throw new AppError("请求校验失败，请刷新页面后重试", 403, "invalid_csrf");
  }
}

export function registerAdminAuth(app: FastifyInstance, db: Kysely<Database>, config: ControlPlaneConfig): void {
  app.post("/auth/lark/consume", async (request, reply) => {
    const { token } = consumeSchema.parse(request.body);
    const consumed = await db.updateTable("admin_login_tokens").set({ consumed_at: new Date() })
      .where("token_hash", "=", sha256(token))
      .where("expires_at", ">", new Date())
      .where("consumed_at", "is", null)
      .returningAll().executeTakeFirst();
    if (!consumed) throw new AppError("专属通行链接已过期或已经使用", 401, "admin_login_token_invalid");
    const role = adminRoleFor(config, consumed.open_id);
    if (!role) throw new AppError("当前飞书身份不在控制台白名单", 403, "admin_forbidden");
    const sessionToken = randomToken(48);
    const csrfToken = randomToken();
    const principal: AdminPrincipal = { openId: consumed.open_id, displayName: null, role, csrfToken };
    await db.insertInto("admin_sessions").values({
      token_hash: sha256(sessionToken),
      open_id: consumed.open_id,
      display_name: null,
      role,
      csrf_token: csrfToken,
      last_seen_at: new Date(),
      expires_at: new Date(Date.now() + config.adminSessionHours * 3_600_000)
    }).execute();
    reply.setCookie(COOKIE_NAME, sessionToken, cookieOptions(config));
    return { ok: true, role };
  });

  app.post("/auth/logout", async (request, reply) => {
    const principal = await requireAdmin(db, config, request);
    requireCsrf(request, principal);
    const token = request.cookies[COOKIE_NAME];
    if (token) await db.deleteFrom("admin_sessions").where("token_hash", "=", sha256(token)).execute();
    reply.clearCookie(COOKIE_NAME, cookieOptions(config));
    return { ok: true };
  });
}

export function setNoStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}
