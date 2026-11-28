import { getWorkerDb } from '@kilocode/db/client';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRunContext,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { timingSafeEqual } from '@kilocode/encryption';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import * as z from 'zod';
import { readModelEvalIngestSecret } from './secrets';
import { createPromotionStore, syncPromotionsFromBench } from './sync.js';

const SyncRequestSchema = z.object({ promotionName: z.string().min(1).optional() }).optional();

async function runSync(env: CloudflareEnv, promotionName?: string) {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  return syncPromotionsFromBench(env.BENCH_DASHBOARD, createPromotionStore(db), { promotionName });
}

function scheduledEnvironment(env: CloudflareEnv): string | undefined {
  return 'ENVIRONMENT' in env && typeof env.ENVIRONMENT === 'string' ? env.ENVIRONMENT : undefined;
}

async function handleFetch(
  request: Request,
  env: CloudflareEnv,
  ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json({
      status: 'ok',
      service: 'model-eval-ingest',
      timestamp: new Date().toISOString(),
    });
  }

  if (request.method !== 'POST' || url.pathname !== '/internal/sync') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  // Read the secret only for a request that presents a key: the Worker is reachable on its
  // workers.dev host, so a keyless request costs no bundle load under `sts`.
  const authHeader = request.headers.get('x-internal-api-key');
  if (!authHeader) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const internalSecret = await readModelEvalIngestSecret(env, 'INTERNAL_API_SECRET', ctx);
  if (!internalSecret || !timingSafeEqual(authHeader, internalSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  observeInternalAuth(
    'model-eval-ingest',
    'sync',
    'legacy_shared_secret',
    callerLabel(request.headers.get(INTERNAL_CALLER_HEADER))
  );

  const rawBody = await request.text();
  let requestBody: unknown;
  try {
    requestBody = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    return Response.json({ error: 'Invalid sync request body' }, { status: 400 });
  }

  const parsedBody = SyncRequestSchema.safeParse(requestBody);
  if (!parsedBody.success) {
    return Response.json(
      { error: 'Invalid sync request', issues: parsedBody.error.issues },
      { status: 400 }
    );
  }

  const result = await runSync(env, parsedBody.data?.promotionName);
  return Response.json({ success: true, ...result });
}

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx?: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: CloudflareEnv): Promise<void> {
    const context = createScheduledJobRunContext();
    const environment = scheduledEnvironment(env);
    const metadata = {
      scheduled_time: controller.scheduledTime,
      schedule: controller.cron,
    };

    try {
      const result = await runSync(env);
      emitScheduledJobEvent(
        buildScheduledJobSuccessEvent({
          context,
          jobName: 'model_eval_ingest.sync',
          environment,
          metadata: {
            ...metadata,
            fetched_count: result.fetched,
            inserted_count: result.inserted,
            already_had_count: result.alreadyHad,
            cache_recompute_count: result.cacheRecomputes,
            no_op:
              result.fetched === 0 &&
              result.inserted === 0 &&
              result.alreadyHad === 0 &&
              result.cacheRecomputes === 0,
          },
        })
      );
    } catch (error) {
      emitScheduledJobEvent(
        buildScheduledJobFailureEvent({
          context,
          jobName: 'model_eval_ingest.sync',
          environment,
          metadata,
          error,
        })
      );
      throw error;
    }
  },
};
