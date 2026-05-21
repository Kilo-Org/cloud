import 'server-only';
import * as z from 'zod';
import { INTERNAL_API_SECRET, MODEL_EVAL_INGEST_URL } from '@/lib/config.server';

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

export async function syncModelEvalPromotions(
  request: ModelEvalSyncRequest = {}
): Promise<ModelEvalSyncResult> {
  if (!MODEL_EVAL_INGEST_URL) {
    throw new Error('MODEL_EVAL_INGEST_URL is not configured');
  }

  const response = await fetch(`${MODEL_EVAL_INGEST_URL}/internal/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': INTERNAL_API_SECRET,
    },
    body: JSON.stringify(request),
  });

  const body: unknown = await response.json();
  if (!response.ok) {
    const errorBody = ModelEvalSyncErrorSchema.safeParse(body);
    throw new Error(
      errorBody.success && errorBody.data.error ? errorBody.data.error : `HTTP ${response.status}`
    );
  }

  return ModelEvalSyncResultSchema.parse(body);
}
