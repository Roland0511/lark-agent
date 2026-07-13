import { createSecretKey } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { ControlPlaneConfig } from "./config.js";
import { AppError } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";

export interface WorkerPrincipal {
  executorId: string;
  homeRef: string;
  codexProfile: string;
  configFingerprint: string;
  credentialId: string;
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new AppError("missing bearer token", 401, "unauthorized");
  return header.slice("Bearer ".length);
}

export async function verifyDeviceCredential(
  db: Kysely<Database>,
  executorId: string,
  supplied: string
): Promise<string> {
  const row = await db.selectFrom("worker_device_credentials").select(["id", "executor_id"])
    .where("credential_hash", "=", sha256(supplied)).where("revoked_at", "is", null).executeTakeFirst();
  if (!row || row.executor_id !== executorId) throw new AppError("invalid device credential", 401, "unauthorized");
  await db.updateTable("worker_device_credentials").set({ last_used_at: new Date() }).where("id", "=", row.id).execute();
  return row.id;
}

export async function issueWorkerSession(
  config: ControlPlaneConfig,
  principal: WorkerPrincipal
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + config.sessionMinutes * 60_000);
  const key = createSecretKey(Buffer.from(config.sessionSigningSecret));
  const token = await new SignJWT({
    homeRef: principal.homeRef,
    codexProfile: principal.codexProfile,
    configFingerprint: principal.configFingerprint,
    credentialId: principal.credentialId
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(principal.executorId)
    .setIssuer("lark-agent")
    .setAudience("worker")
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);
  return { token, expiresAt };
}

export async function requireWorkerSession(
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  request: FastifyRequest
): Promise<WorkerPrincipal> {
  const token = bearerToken(request);
  const key = createSecretKey(Buffer.from(config.sessionSigningSecret));
  try {
    const verified = await jwtVerify(token, key, { issuer: "lark-agent", audience: "worker" });
    if (!verified.payload.sub || !verified.payload.credentialId) throw new Error("missing worker identity");
    const credentialId = String(verified.payload.credentialId);
    const credential = await db.selectFrom("worker_device_credentials").select(["executor_id", "revoked_at"])
      .where("id", "=", credentialId).executeTakeFirst();
    if (!credential || credential.revoked_at || credential.executor_id !== verified.payload.sub) throw new Error("credential revoked");
    return {
      executorId: verified.payload.sub,
      homeRef: String(verified.payload.homeRef),
      codexProfile: String(verified.payload.codexProfile),
      configFingerprint: String(verified.payload.configFingerprint),
      credentialId
    };
  } catch {
    throw new AppError("invalid, expired or revoked worker session", 401, "unauthorized");
  }
}

export function readDeviceBearer(request: FastifyRequest): string {
  return bearerToken(request);
}
