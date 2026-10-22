import crypto from 'crypto';
import { type Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

/**
 * Deployment secret that keys every pseudonymous identifier sent upstream.
 * Draw it from server config (`pnpm web:env set AI_GATEWAY_PSEUDONYM_KEY`) so a
 * user's identifiers are stable within a deployment, differ between
 * deployments, and cannot be recomputed from the repository.
 */
const PSEUDONYM_KEY_ENV_VAR = 'AI_GATEWAY_PSEUDONYM_KEY';

/**
 * The literal that keyed these identifiers before the variable above existed.
 * Development, preview and test keep the same fallback key so they share one
 * known non-production value; the identifiers themselves change, because the
 * construction is now an HMAC. Production throws instead of falling back.
 */
const NON_PRODUCTION_PSEUDONYM_KEY = 'd20250815';

function getPseudonymKey(): string {
  const configured = getEnvVariable(PSEUDONYM_KEY_ENV_VAR).trim();
  if (configured) return configured;
  // A Vercel preview deployment also runs with `NODE_ENV=production`, so the
  // Vercel environment wins when it is present; outside Vercel the process mode
  // decides.
  if ((process.env.VERCEL_ENV ?? process.env.NODE_ENV) === 'production') {
    throw new Error(
      `Missing required environment variable ${PSEUDONYM_KEY_ENV_VAR}; run \`pnpm web:env set ${PSEUDONYM_KEY_ENV_VAR}\` so upstream pseudonyms are keyed with a deployment secret`
    );
  }
  return NON_PRODUCTION_PSEUDONYM_KEY;
}

/**
 * Generates a service-specific pseudonym, HMAC-SHA256 keyed with the deployment
 * secret in `AI_GATEWAY_PSEUDONYM_KEY`.
 *
 * @param payload - The string to pseudonymize
 * @param provider - The provider to generate the pseudonym for
 * @returns Base64-encoded HMAC-SHA256 digest
 */
export function generateProviderSpecificHash(payload: string, provider: Provider): string {
  const pepper =
    provider.id === 'vercel'
      ? 'vercel'
      : provider.id === 'openrouter'
        ? 'henk is a boss'
        : provider.apiUrl;
  return crypto
    .createHmac('sha256', getPseudonymKey())
    .update(pepper + payload)
    .digest('base64');
}

export function generateProviderSpecificSessionHash(
  userId: string,
  sessionId: string,
  provider: Provider
): string {
  return generateProviderSpecificHash(userId + '-' + sessionId, provider);
}

export function generateOpenRouterDownstreamSafetyIdentifier(userId: string): string {
  return generateProviderSpecificHash(userId, OPENROUTER);
}

export function generateVercelDownstreamSafetyIdentifier(userId: string): string {
  return generateProviderSpecificHash(userId, VERCEL_AI_GATEWAY);
}

export function generateOpenRouterUpstreamSafetyIdentifier(userId: string): string | null {
  const orgId = getEnvVariable('OPENROUTER_ORG_ID');
  if (!orgId) {
    console.error(
      '[generateOpenRouterUpstreamSafetyIdentifier] OPENROUTER_ORG_ID is not set, please run vercel env pull'
    );
    return null;
  }
  return crypto
    .createHash('sha256')
    .update(orgId + '-' + generateOpenRouterDownstreamSafetyIdentifier(userId))
    .digest('hex');
}

// OpenAI rejects longer keys with `string_above_max_length`.
const MAX_PROMPT_CACHE_KEY_LENGTH = 64;

export function applyTrackingIds(
  request: GatewayRequest,
  provider: Provider,
  userId: string,
  taskId: string | null
) {
  const userHash = generateProviderSpecificHash(userId, provider);
  const taskHash = taskId ? generateProviderSpecificSessionHash(userId, taskId, provider) : '';
  if (request.kind === 'messages') {
    request.body.metadata = { ...request.body.metadata, user_id: userHash };
    if (provider.id === 'openrouter' || provider.id === 'vercel') {
      request.body.user = userHash;
      if (taskHash) {
        request.body.session_id = taskHash;
      }
    }
  } else {
    const clientCacheKey = request.body.prompt_cache_key;
    if (taskHash) {
      request.body.prompt_cache_key = taskHash;
    } else if (
      typeof clientCacheKey === 'string' &&
      clientCacheKey.length > MAX_PROMPT_CACHE_KEY_LENGTH
    ) {
      request.body.prompt_cache_key = generateProviderSpecificSessionHash(
        userId,
        clientCacheKey,
        provider
      );
    }
    request.body.safety_identifier = userHash;
    request.body.user = userHash; // deprecated, but this is what OpenRouter uses
  }
}
