import {
  AUTO_ROUTING_DENIED_MODELS_PATH,
  AutoRoutingDeniedModelsResponseSchema,
  type AutoRoutingDeniedModelsRequest,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { readAutoRoutingSecret } from './secrets';

const POLICY_CACHE_TTL_MS = 60_000;
const POLICY_CACHE_LIMIT = 2_000;
// Two gateway attempts stay inside the CLI's decide budget.
const DENIED_MODELS_ATTEMPT_TIMEOUT_MS = 1_500;
const DENIED_MODELS_ATTEMPTS = 2;

type GatewayPolicyEnv = Pick<Env, 'INTERNAL_API_SECRET_PROD' | 'KILO_AI_GATEWAY_BASE_URL'>;

type PolicyCacheEntry = {
  expiresAt: number;
  value: string[];
  /** Start order of the lookup that produced this answer, so an older answer never replaces it. */
  sequence: number;
};

const deniedModelsCache = new Map<string, PolicyCacheEntry>();

let lookupSequence = 0;

export function clearOrganizationPolicyCache(): void {
  deniedModelsCache.clear();
}

class DeniedModelsResponseError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`gateway denied-models responded ${status}`);
    this.name = 'DeniedModelsResponseError';
    this.status = status;
  }
}

async function fetchDeniedModelIds(
  env: GatewayPolicyEnv,
  request: AutoRoutingDeniedModelsRequest,
  ctx?: SecretsExecutionContext
): Promise<string[]> {
  const res = await fetch(new URL(AUTO_ROUTING_DENIED_MODELS_PATH, env.KILO_AI_GATEWAY_BASE_URL), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await readAutoRoutingSecret(env, 'INTERNAL_API_SECRET', ctx)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(DENIED_MODELS_ATTEMPT_TIMEOUT_MS),
  });
  if (!res.ok) throw new DeniedModelsResponseError(res.status);
  return AutoRoutingDeniedModelsResponseSchema.parse(await res.json()).deniedModelIds;
}

// Network errors, timeouts, 429, and 5xx can clear on a second attempt. Any other status (a
// wrong secret, a contract mismatch, a route not deployed yet) fails the same way again.
function isTransientLookupFailure(error: unknown): boolean {
  return (
    !(error instanceof DeniedModelsResponseError) || error.status === 429 || error.status >= 500
  );
}

async function fetchDeniedModelIdsWithRetry(
  env: GatewayPolicyEnv,
  request: AutoRoutingDeniedModelsRequest,
  ctx?: SecretsExecutionContext
): Promise<string[] | null> {
  for (let attempt = 1; attempt <= DENIED_MODELS_ATTEMPTS; attempt++) {
    try {
      return await fetchDeniedModelIds(env, request, ctx);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'auto_routing_denied_models_lookup_failed',
          attempt,
          ...formatError(error),
        })
      );
      if (!isTransientLookupFailure(error)) return null;
    }
  }
  return null;
}

// The gateway evaluates the organization model policy for a member (ADR 0005). Null means the
// policy could not be read after a retry; the caller must not admit any gateway entry then.
// Only answers are cached, so the next request asks again.
export async function deniedOrganizationModelIds(
  env: GatewayPolicyEnv,
  request: AutoRoutingDeniedModelsRequest,
  ctx?: SecretsExecutionContext
): Promise<string[] | null> {
  if (request.modelIds.length === 0) return [];
  const modelIds = [...new Set(request.modelIds)].sort();
  const key = JSON.stringify([request.organizationId, request.userId, modelIds]);
  const now = Date.now();
  const hit = deniedModelsCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  lookupSequence += 1;
  const sequence = lookupSequence;
  // Only a resolved answer is cached: a pending lookup belongs to the request that started it, so
  // a request that joined it would fail when that request was cancelled.
  const deniedModelIds = await fetchDeniedModelIdsWithRetry(env, { ...request, modelIds }, ctx);
  if (deniedModelIds === null) return null;
  const existing = deniedModelsCache.get(key);
  // A lookup that started before the cached answer must not replace it, and the TTL runs from the
  // lookup's start, not from when the gateway happened to answer.
  if (existing !== undefined && existing.sequence > sequence) return deniedModelIds;
  deniedModelsCache.delete(key);
  deniedModelsCache.set(key, {
    expiresAt: now + POLICY_CACHE_TTL_MS,
    value: deniedModelIds,
    sequence,
  });
  if (deniedModelsCache.size > POLICY_CACHE_LIMIT) {
    const oldest = deniedModelsCache.keys().next().value;
    if (oldest !== undefined) deniedModelsCache.delete(oldest);
  }
  return deniedModelIds;
}
