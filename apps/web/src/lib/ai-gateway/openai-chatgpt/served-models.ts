import { createCachedFetch } from '@/lib/cached-fetch';

/**
 * Which models the partner project can actually serve.
 *
 * The gateway addresses OpenAI models as `openai/<id>`, and the delegated route
 * sends the bare `<id>` to api.openai.com. Not every id the catalog lists is
 * served there: OpenRouter advertises models such as `openai/gpt-5.6-luna-pro`
 * that the plain API answers with `404 The model does not exist or you do not
 * have access to it`. Routing one of those to the delegated upstream fails the
 * request instead of leaving it on its existing route, so eligibility asks
 * OpenAI for the served list first.
 */
const MODELS_URL = 'https://api.openai.com/v1/models';

/** How long a fetched list is reused. Model access changes slowly. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** A slow list must not hold up a request. */
const REQUEST_TIMEOUT_MS = 2_000;

const servedModelIdsFetchers = new Map<string, () => Promise<ReadonlySet<string> | null>>();

async function fetchServedModelIds(apiKey: string): Promise<ReadonlySet<string>> {
  const response = await fetch(MODELS_URL, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI models request failed with status ${response.status}`);

  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? [])
    .map(model => (typeof model?.id === 'string' ? model.id : null))
    .filter((id): id is string => id !== null);
  return new Set(ids);
}

function getServedModelIds(apiKey: string): Promise<ReadonlySet<string> | null> {
  let getCachedModelIds = servedModelIdsFetchers.get(apiKey);
  if (!getCachedModelIds) {
    getCachedModelIds = createCachedFetch(() => fetchServedModelIds(apiKey), CACHE_TTL_MS, null);
    servedModelIdsFetchers.set(apiKey, getCachedModelIds);
  }
  return getCachedModelIds();
}

/**
 * True when the project behind `apiKey` can serve `modelId`.
 *
 * A missing key or failed initial request returns true. After a successful
 * request, transient failures reuse the last-known-good served list.
 */
export async function isOpenAiModelServed(apiKey: string, modelId: string): Promise<boolean> {
  if (apiKey.trim().length === 0) return true;

  const modelIds = await getServedModelIds(apiKey);
  return modelIds?.has(modelId) ?? true;
}

/** Drops the cached list. Tests call this between cases. */
export function resetServedModelIdsCache(): void {
  servedModelIdsFetchers.clear();
}
