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

let cachedModelIds: Set<string> | null = null;
let cacheExpiresAt = 0;
let failureExpiresAt = 0;
let inFlight: Promise<Set<string> | null> | null = null;

/**
 * The served ids in a `/models` body, or null when the body carries no usable
 * list. A 200 whose shape is unrecognizable — an error envelope, a proxy stub, a
 * body without `data` — is a failed lookup, not an empty catalog: caching it as
 * an empty set would hide every model, and with it the delegated route, for the
 * whole `CACHE_TTL_SECONDS`. Entries without a string id are skipped, so a
 * partially readable list still answers for the ids it did list.
 */
function readServedModelIds(body: unknown): Set<string> | null {
  if (typeof body !== 'object' || body === null || !('data' in body)) return null;
  const { data } = body;
  if (!Array.isArray(data) || data.length === 0) return null;

  const ids = data
    .map(model => (typeof model?.id === 'string' ? model.id : null))
    .filter((id): id is string => id !== null);
  return ids.length === 0 ? null : new Set(ids);
}

async function fetchServedModelIds(apiKey: string): Promise<Set<string> | null> {
  try {
    const response = await fetch(MODELS_URL, {
      // The module cache below is the only cache for this lookup. Next's data
      // cache would otherwise keep answering with the body it already stored for
      // `CACHE_TTL_SECONDS`, so the short failure window could only repeat an
      // unusable answer instead of asking the project again.
      cache: 'no-store',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    return readServedModelIds(await response.json());
  } catch {
    return null;
  }
}

/**
 * True when the project behind `apiKey` can serve `modelId`.
 *
 * A missing key, a failed request, a 200 without a usable list, or an unreadable
 * body returns true: a transient problem must not hide the route, and the
 * upstream then answers exactly as it does today. A failure is remembered for
 * `FAILURE_TTL_MS` so a burst of eligible requests does not each pay the lookup
 * and its timeout. The next lookup after that window asks the project again
 * rather than reusing a stored answer, so a bad answer costs the short window
 * and never the hour a good list is reused for.
 */
export async function isOpenAiModelServed(apiKey: string, modelId: string): Promise<boolean> {
  if (apiKey.trim().length === 0) return true;

  if (!cachedModelIds || Date.now() >= cacheExpiresAt) {
    // A recent failure already answered "unknown": fail open without another
    // request until its short TTL passes.
    if (Date.now() < failureExpiresAt) return true;

    inFlight ??= fetchServedModelIds(apiKey)
      .then(ids => {
        if (ids) {
          cachedModelIds = ids;
          cacheExpiresAt = Date.now() + CACHE_TTL_MS;
          failureExpiresAt = 0;
        } else {
          failureExpiresAt = Date.now() + FAILURE_TTL_MS;
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
  failureExpiresAt = 0;
  inFlight = null;
}
