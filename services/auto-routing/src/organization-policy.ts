import {
  AUTO_ROUTING_DENIED_MODELS_PATH,
  AutoRoutingDeniedModelsResponseSchema,
  type AutoRoutingDeniedModelsRequest,
} from '@kilocode/auto-routing-contracts';
import { formatError, getCachedSecret } from '@kilocode/worker-utils';
import {
  BLACKLISTED_DOMAINS_REDIS_KEY,
  blacklistedDomainsFromConfig,
} from '@kilocode/worker-utils/account-access';
import * as z from 'zod';

const POLICY_CACHE_TTL_MS = 60_000;
const POLICY_CACHE_LIMIT = 2_000;
const LOOKUP_TIMEOUT_MS = 2_000;
// Two gateway attempts stay inside the CLI's decide budget.
const DENIED_MODELS_ATTEMPT_TIMEOUT_MS = 1_500;
const DENIED_MODELS_ATTEMPTS = 2;

type GatewayPolicyEnv = Pick<Env, 'INTERNAL_API_SECRET_PROD' | 'KILO_AI_GATEWAY_BASE_URL'>;
type BlacklistEnv = Pick<Env, 'UPSTASH_REDIS_REST_URL' | 'UPSTASH_REDIS_REST_TOKEN'>;

const deniedModelsCache = new Map<string, { expiresAt: number; value: Promise<string[] | null> }>();
let blacklistedDomains: { expiresAt: number; value: string[] } | null = null;

export function clearOrganizationPolicyCache(): void {
  deniedModelsCache.clear();
  blacklistedDomains = null;
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
  if (!res.ok) throw new Error(`gateway denied-models responded ${res.status}`);
  return AutoRoutingDeniedModelsResponseSchema.parse(await res.json()).deniedModelIds;
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

const UpstashGetResponseSchema = z.object({ result: z.string().nullable() });

async function readBlacklistedDomainsConfig(env: BlacklistEnv): Promise<string | null> {
  const [url, token] = await Promise.all([
    getCachedSecret(env.UPSTASH_REDIS_REST_URL, 'UPSTASH_REDIS_REST_URL'),
    getCachedSecret(env.UPSTASH_REDIS_REST_TOKEN, 'UPSTASH_REDIS_REST_TOKEN'),
  ]);
  // The command form works with Upstash and with the dev serverless-redis-http container.
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(['GET', BLACKLISTED_DOMAINS_REDIS_KEY]),
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstash responded ${res.status}`);
  return UpstashGetResponseSchema.parse(await res.json()).result;
}

// Refreshes once a minute and keeps the last good list when Redis fails. Null means no list
// has loaded in this isolate yet, so the caller cannot tell a blocked domain from an allowed
// one. The gateway's BLACKLIST_DOMAINS fallback is a Vercel env var this worker does not have.
export async function getBlacklistedDomains(env: BlacklistEnv): Promise<string[] | null> {
  const now = Date.now();
  if (blacklistedDomains && blacklistedDomains.expiresAt > now) return blacklistedDomains.value;
  try {
    const value = blacklistedDomainsFromConfig(await readBlacklistedDomainsConfig(env), []);
    blacklistedDomains = { expiresAt: now + POLICY_CACHE_TTL_MS, value };
    return value;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'auto_routing_blacklisted_domains_read_failed',
        ...formatError(error),
      })
    );
    return blacklistedDomains?.value ?? null;
  }
}
