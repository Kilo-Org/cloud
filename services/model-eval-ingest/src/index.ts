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
import { STS_MODEL_EVAL_INGEST_INTERNAL_CALL } from '@kilocode/sts-contracts';
import {
  createInternalServiceReceiver,
  type InternalReceiverEnv,
  type InternalRouteContract,
} from '@kilocode/worker-utils/internal-service-receiver';
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

/** `POST /internal/sync`, sent only by the web app. */
const SYNC_ROUTE: InternalRouteContract = {
  label: 'sync',
  scope: STS_MODEL_EVAL_INGEST_INTERNAL_CALL.scope,
  workloads: ['web'],
  legacyHeader: 'x-internal-api-key',
};

const receiver = createInternalServiceReceiver({
  receiver: 'model-eval-ingest',
  audience: STS_MODEL_EVAL_INGEST_INTERNAL_CALL.audience,
  routes: [SYNC_ROUTE],
});

/** The legacy check, unchanged: the shared secret in `x-internal-api-key`. */
async function legacyRefusal(
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext | undefined
): Promise<Response | null> {
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
    SYNC_ROUTE.label,
    'legacy_shared_secret',
    callerLabel(request.headers.get(INTERNAL_CALLER_HEADER))
  );
  return null;
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

  const receiverEnv: CloudflareEnv & InternalReceiverEnv = env;
  if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
    const metadata = receiver.protectedResourceMetadata(receiverEnv);
    if (metadata !== null) return metadata;
  }

  if (request.method !== 'POST' || url.pathname !== '/internal/sync') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  // `INTERNAL_CREDENTIAL_ACCEPT` selects the shared secret, an STS token or either.
  const refusal = await receiver.admit(
    request,
    receiverEnv,
    SYNC_ROUTE,
    () => legacyRefusal(request, env, ctx),
    { waitUntil: promise => ctx?.waitUntil(promise) }
  );
  if (refusal !== null) return refusal;

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
