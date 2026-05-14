import 'server-only';
import { INTERNAL_API_SECRET, MODEL_EVAL_INGEST_URL } from '@/lib/config.server';

export type ModelEvalSyncResult = {
  success: true;
  inserted: number;
  alreadyHad: number;
  cacheRecomputes: number;
  fetched: number;
};

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

  const body = (await response.json()) as ModelEvalSyncResult | { error?: string };
  if (!response.ok || !('success' in body) || body.success !== true) {
    throw new Error('error' in body && body.error ? body.error : `HTTP ${response.status}`);
  }

  return body;
}
