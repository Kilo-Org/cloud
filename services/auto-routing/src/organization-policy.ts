import {
  AUTO_ROUTING_DENIED_MODELS_PATH,
  AutoRoutingDeniedModelsResponseSchema,
  type AutoRoutingDeniedModelsRequest,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';

const POLICY_CACHE_TTL_MS = 60_000;
const POLICY_CACHE_LIMIT = 2_000;
// Two gateway attempts stay inside the CLI's decide budget.
const DENIED_MODELS_ATTEMPT_TIMEOUT_MS = 1_500;
const DENIED_MODELS_ATTEMPTS = 2;

type GatewayPolicyEnv = Pick<Env, 'INTERNAL_API_SECRET_PROD' | 'KILO_AI_GATEWAY_BASE_URL'>;

const deniedModelsCache = new Map<string, { expiresAt: number; value: Promise<string[] | null> }>();

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
  request: AutoRoutingDeniedModelsRequest
): Promise<string[]> {
  const res = await fetch(new URL(AUTO_ROUTING_DENIED_MODELS_PATH, env.KILO_AI_GATEWAY_BASE_URL), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await env.INTERNAL_API_SECRET_PROD.get()}`,
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
  request: AutoRoutingDeniedModelsRequest
): Promise<string[] | null> {
  for (let attempt = 1; attempt <= DENIED_MODELS_ATTEMPTS; attempt++) {
    try {
      return await fetchDeniedModelIds(env, request);
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
  request: AutoRoutingDeniedModelsRequest
): Promise<string[] | null> {
  if (request.modelIds.length === 0) return [];
  const modelIds = [...new Set(request.modelIds)].sort();
  const key = JSON.stringify([request.organizationId, request.userId, modelIds]);
  const now = Date.now();
  const hit = deniedModelsCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value: Promise<string[] | null> = fetchDeniedModelIdsWithRetry(env, {
    ...request,
    modelIds,
  }).then(deniedModelIds => {
    if (deniedModelIds === null && deniedModelsCache.get(key)?.value === value) {
      deniedModelsCache.delete(key);
    }
    return deniedModelIds;
  });
  deniedModelsCache.delete(key);
  deniedModelsCache.set(key, { expiresAt: now + POLICY_CACHE_TTL_MS, value });
  if (deniedModelsCache.size > POLICY_CACHE_LIMIT) {
    const oldest = deniedModelsCache.keys().next().value;
    if (oldest !== undefined) deniedModelsCache.delete(oldest);
  }
  return value;
}
