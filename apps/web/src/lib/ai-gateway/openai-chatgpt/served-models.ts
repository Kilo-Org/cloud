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
const CACHE_TTL_SECONDS = 60 * 60;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;

/** A slow list must not hold up a request. */
const REQUEST_TIMEOUT_MS = 2_000;

let cachedModelIds: Set<string> | null = null;
let cacheExpiresAt = 0;
let inFlight: Promise<Set<string> | null> | null = null;

async function fetchServedModelIds(apiKey: string): Promise<Set<string> | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      next: { revalidate: CACHE_TTL_SECONDS },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? [])
      .map(model => (typeof model?.id === 'string' ? model.id : null))
      .filter((id): id is string => id !== null);
    return new Set(ids);
  } catch {
    return null;
  }
}

/**
 * True when the project behind `apiKey` can serve `modelId`.
 *
 * A missing key, a failed request, or an unreadable body returns true: a
 * transient problem must not hide the route, and the upstream then answers
 * exactly as it does today.
 */
export async function isOpenAiModelServed(apiKey: string, modelId: string): Promise<boolean> {
  if (apiKey.trim().length === 0) return true;

  if (!cachedModelIds || Date.now() >= cacheExpiresAt) {
    inFlight ??= fetchServedModelIds(apiKey)
      .then(ids => {
        if (ids) {
          cachedModelIds = ids;
          cacheExpiresAt = Date.now() + CACHE_TTL_MS;
        }
        return ids;
      })
      .finally(() => {
        inFlight = null;
      });

    const ids = await inFlight;
    if (!ids) return true;
  }

  return cachedModelIds?.has(modelId) ?? true;
}

/** Drops the cached list. Tests call this between cases. */
export function resetServedModelIdsCache(): void {
  cachedModelIds = null;
  cacheExpiresAt = 0;
  inFlight = null;
}
