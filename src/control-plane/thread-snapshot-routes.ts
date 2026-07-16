import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Database } from "../db/types.js";
import {
  threadSnapshotChunkSchema,
  threadSnapshotCompleteSchema,
  threadSnapshotFailureSchema,
  threadSnapshotTurnSummariesPageSchema
} from "../shared/contracts.js";
import { AppError } from "../shared/errors.js";
import { requireAdmin, requireCsrf, setNoStore } from "./admin-auth.js";
import type { AdminEventBus } from "./admin-events.js";
import { requireWorkerSession } from "./auth.js";
import type { ControlPlaneConfig } from "./config.js";
import { parseChatContextId } from "./chat-context-admin-routes.js";
import { ThreadSnapshotService } from "./thread-snapshot-service.js";

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const ROUTE_BODY_LIMIT = 8 * 1024 * 1024;
const viewQuerySchema = z.object({
  before: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50)
});
const summaryQuerySchema = z.object({
  before: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50)
});

function snapshotLeaseToken(request: FastifyRequest): string {
  const value = request.headers["x-snapshot-lease-token"];
  if (typeof value !== "string" || !value) throw new AppError("missing X-Snapshot-Lease-Token", 401, "missing_snapshot_lease");
  return value;
}

export function registerThreadSnapshotRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  events: AdminEventBus
): ThreadSnapshotService {
  const service = new ThreadSnapshotService(db, events);

  app.post<{ Params: { id: string } }>("/v1/admin/chat-contexts/:id/thread-snapshot", async (request, reply) => {
    const principal = await requireAdmin(db, config, request, true);
    requireCsrf(request, principal);
    const result = await service.enqueue(parseChatContextId(request.params.id), principal.openId);
    return reply.code(result.existing ? 200 : 202).send(result);
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>("/v1/admin/chat-contexts/:id/thread-snapshot", async (request, reply) => {
    await requireAdmin(db, config, request);
    setNoStore(reply);
    const query = viewQuerySchema.parse(request.query);
    return service.view(parseChatContextId(request.params.id), query.before, query.limit);
  });

  app.post("/v1/workers/thread-snapshot-jobs/claim", async (request, reply) => {
    const principal = await requireWorkerSession(db, config, request);
    const job = await service.claim(principal);
    return job ? reply.send(job) : reply.code(204).send();
  });

  app.post<{ Params: { jobId: string } }>("/v1/workers/thread-snapshot-jobs/:jobId/heartbeat", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    return service.heartbeat(principal.executorId, request.params.jobId, snapshotLeaseToken(request));
  });

  app.get<{ Params: { jobId: string }; Querystring: { before?: string; limit?: string } }>(
    "/v1/workers/thread-snapshot-jobs/:jobId/turn-summaries",
    async (request) => {
      const principal = await requireWorkerSession(db, config, request);
      const query = summaryQuerySchema.parse(request.query);
      return threadSnapshotTurnSummariesPageSchema.parse(await service.previousAiSummaries(
        principal.executorId,
        request.params.jobId,
        snapshotLeaseToken(request),
        query.before,
        query.limit
      ));
    }
  );

  app.post<{ Params: { jobId: string } }>("/v1/workers/thread-snapshot-jobs/:jobId/chunks", { bodyLimit: ROUTE_BODY_LIMIT }, async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    const serialized = JSON.stringify(request.body ?? null);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CHUNK_BYTES) {
      throw new AppError("Thread 快照分块超过 4 MiB", 413, "thread_snapshot_chunk_too_large");
    }
    const body = threadSnapshotChunkSchema.parse(request.body);
    await service.uploadChunk(principal.executorId, request.params.jobId, snapshotLeaseToken(request), body);
    return { ok: true };
  });

  app.post<{ Params: { jobId: string } }>("/v1/workers/thread-snapshot-jobs/:jobId/complete", { bodyLimit: ROUTE_BODY_LIMIT }, async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    const body = threadSnapshotCompleteSchema.parse(request.body);
    await service.complete(principal, request.params.jobId, snapshotLeaseToken(request), body);
    return { ok: true };
  });

  app.post<{ Params: { jobId: string } }>("/v1/workers/thread-snapshot-jobs/:jobId/fail", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    const body = threadSnapshotFailureSchema.parse(request.body);
    await service.fail(principal.executorId, request.params.jobId, snapshotLeaseToken(request), body);
    return { ok: true };
  });

  return service;
}
