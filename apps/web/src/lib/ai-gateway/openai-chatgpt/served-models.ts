import { createCachedFetch } from '@/lib/cached-fetch';
import { OPENAI_CHATGPT_API_URL } from './upstream';

/**
 * Which models the partner project can actually serve.
 *
 * The gateway addresses OpenAI models as `openai/<id>`, and the delegated route
 * sends the bare `<id>` to the delegated upstream. Not every id the catalog
 * lists is served there. A `-pro` slug such as `openai/gpt-5.6-luna-pro` is a
 * reasoning mode on the base model, not an API model id, and the plain API
 * answers it with `404 The model does not exist or you do not have access to
 * it`. Routing one of those to the delegated upstream fails the request instead
 * of leaving it on its existing route, so eligibility asks the project for the
 * served list first.
 *
 * The lookup uses the same base URL as the inference request, so a stub or an
 * alternate host answers both.
 */
const MODELS_URL = `${OPENAI_CHATGPT_API_URL}/models`;

/** How long a fetched list is reused. Model access changes slowly. */
const CACHE_TTL_SECONDS = 60 * 60;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;

/**
 * How long a failed lookup is remembered. Without this, an outage re-issues the
 * request and waits up to `REQUEST_TIMEOUT_MS` on every eligible model check.
 */
const FAILURE_TTL_MS = 30 * 1000;

/** A slow list must not hold up a request. */
const REQUEST_TIMEOUT_MS = 2_000;

async function fetchServedModelIds(apiKey: string): Promise<ReadonlySet<string>> {
  const response = await fetch(MODELS_URL, {
    cache: 'force-cache',
    headers: { authorization: `Bearer ${apiKey}` },
    next: { revalidate: CACHE_TTL_SECONDS },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI models lookup failed: ${response.status}`);

  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? [])
    .map(model => (typeof model?.id === 'string' ? model.id : null))
    .filter((id): id is string => id !== null);
  return new Set(ids);
}

const servedModelIdsByKey = new Map<string, () => Promise<ReadonlySet<string> | null>>();

function getServedModelIds(apiKey: string): Promise<ReadonlySet<string> | null> {
  let get = servedModelIdsByKey.get(apiKey);
  if (!get) {
    get = createCachedFetch<ReadonlySet<string> | null>(
      () => fetchServedModelIds(apiKey),
      CACHE_TTL_MS,
      null,
      { failureTtlMs: FAILURE_TTL_MS }
    );
    servedModelIdsByKey.set(apiKey, get);
  }
  return get();
}

/**
 * True when the project behind `apiKey` can serve `modelId`.
 *
 * A missing key, a failed request, or an unreadable body returns true: a
 * transient problem must not hide the route, and the upstream then answers
 * exactly as it does today. A failure is remembered for `FAILURE_TTL_MS` so a
 * burst of eligible requests does not each pay the lookup and its timeout.
 */
export async function isOpenAiModelServed(apiKey: string, modelId: string): Promise<boolean> {
  if (apiKey.trim().length === 0) return true;

  const ids = await getServedModelIds(apiKey);
  return ids?.has(modelId) ?? true;
}

/** Drops the cached lists. Tests call this between cases. */
export function resetServedModelIdsCache(): void {
  servedModelIdsByKey.clear();
}
