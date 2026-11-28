import 'server-only';
import * as z from 'zod';
import { STS_MODEL_EVAL_INGEST_INTERNAL_CALL } from '@kilocode/sts-contracts';
import {
  MODEL_EVAL_INGEST_SENDER_AUTH,
  MODEL_EVAL_INGEST_URL,
} from '@kilocode/web-shared/lib/config.server';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import {
  resolveServiceSenderAuth,
  serviceSenderHeaders,
} from '@kilocode/web-shared/lib/service-sender-auth';
import { CONTROL_PLANE_UPSTREAM_BUDGET_MS, withinBudget } from '@/lib/bounded-service-fetch';

const ModelEvalSyncResultSchema = z.object({
  success: z.literal(true),
  inserted: z.number().int().nonnegative(),
  alreadyHad: z.number().int().nonnegative(),
  cacheRecomputes: z.number().int().nonnegative(),
  fetched: z.number().int().nonnegative(),
});
const ModelEvalSyncErrorSchema = z.object({ error: z.string().optional() });

export type ModelEvalSyncResult = z.infer<typeof ModelEvalSyncResultSchema>;

type ModelEvalSyncRequest = {
  promotionName?: string;
};

/**
 * `MODEL_EVAL_INGEST_SENDER_AUTH` (`service-sender-auth.ts`): `legacy` sends the internal API secret
 * in `x-internal-api-key`, as before (also when unset); explicit `sts` sends only a
 * `model-eval-ingest:internal.call` STS token.
 */
const modelEvalIngestSender = resolveServiceSenderAuth({
  auth: MODEL_EVAL_INGEST_SENDER_AUTH,
  url: MODEL_EVAL_INGEST_URL,
  runtime: process.env,
});

export async function syncModelEvalPromotions(
  request: ModelEvalSyncRequest = {}
): Promise<ModelEvalSyncResult> {
  if (!MODEL_EVAL_INGEST_URL) {
    throw new Error('MODEL_EVAL_INGEST_URL is not configured');
  }

  // Throws before anything is sent for a refused switch, or no token within the internal-service
  // budget: a cold mint never holds the admin request open.
  const credential = await withinBudget(
    serviceSenderHeaders({
      sender: modelEvalIngestSender,
      variable: 'MODEL_EVAL_INGEST_SENDER_AUTH',
      label: 'model eval ingest client',
      request: STS_MODEL_EVAL_INGEST_INTERNAL_CALL,
      legacyHeaders: async () => ({ 'x-internal-api-key': await readInternalApiSecret() }),
    }),
    CONTROL_PLANE_UPSTREAM_BUDGET_MS
  );
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...credential,
    },
    body: JSON.stringify(request),
  };
  // An STS token is for this origin only; a redirect never carries it on.
  if (modelEvalIngestSender.kind === 'sts') init.redirect = 'error';
  const response = await fetch(`${MODEL_EVAL_INGEST_URL}/internal/sync`, init);

  const body: unknown = await response.json();
  if (!response.ok) {
    const errorBody = ModelEvalSyncErrorSchema.safeParse(body);
    throw new Error(
      errorBody.success && errorBody.data.error ? errorBody.data.error : `HTTP ${response.status}`
    );
  }

  return ModelEvalSyncResultSchema.parse(body);
}
