import { ClassifierOutputSchema } from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import type { ClassifierOutput } from './classifier-output';

// Mirrored agent sessions classify the same prompt prefixes on every API
// call, so identical classifier inputs repeat heavily within a short
// window. Reusing the previous result skips the model call entirely.
const CACHE_TTL_SECONDS = 900;
const CACHE_BASE_URL = 'https://auto-routing.kiloapps.io/internal/classifier-cache/v1/';

const CachedClassificationSchema = z.object({
  classification: ClassifierOutputSchema,
  classifierModel: z.string(),
  cachedAt: z.string(),
});

export type CachedClassification = z.infer<typeof CachedClassificationSchema>;

function cacheRequest(contentHash: string, classifierModel: string): Request {
  // The classifier model is part of the key so a model switch never serves
  // results produced by the previous model.
  return new Request(`${CACHE_BASE_URL}${encodeURIComponent(classifierModel)}/${contentHash}`);
}

export async function getCachedClassification(
  contentHash: string,
  classifierModel: string
): Promise<CachedClassification | null> {
  try {
    const response = await caches.default.match(cacheRequest(contentHash, classifierModel));
    if (!response) return null;
    const parsed = CachedClassificationSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function putCachedClassification(
  contentHash: string,
  classifierModel: string,
  classification: ClassifierOutput
): Promise<void> {
  const value: CachedClassification = {
    classification,
    classifierModel,
    cachedAt: new Date().toISOString(),
  };
  try {
    await caches.default.put(
      cacheRequest(contentHash, classifierModel),
      new Response(JSON.stringify(value), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `max-age=${CACHE_TTL_SECONDS}`,
        },
      })
    );
  } catch {
    // Cache writes are best effort and must not fail the decision.
  }
}
