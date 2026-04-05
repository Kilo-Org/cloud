import crypto from 'crypto';
import { type Provider } from '@/lib/providers/types';
import PROVIDERS from '@/lib/providers/provider-definitions';
import { getEnvVariable } from '@/lib/dotenvx';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';

/**
 * Generates a service-specific SHA256 hash.
 *
 * @param payload - The string to hash
 * @param provider - The provider to generate the hash for
 * @returns Base64-encoded SHA256 hash
 */
export function generateProviderSpecificHash(payload: string, provider: Provider): string {
  const salt = 'd20250815';
  const pepper =
    provider.id === 'vercel'
      ? 'vercel'
      : provider.id === 'openrouter'
        ? 'henk is a boss'
        : provider.apiUrl;
  return crypto
    .createHash('sha256')
    .update(salt + pepper + payload)
    .digest('base64');
}

export function generateVercelDownstreamSafetyIdentifier(userId: string): string {
  return generateProviderSpecificHash(userId, PROVIDERS.VERCEL_AI_GATEWAY);
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
    .update(orgId + '-' + generateProviderSpecificHash(userId, PROVIDERS.OPENROUTER))
    .digest('hex');
}

export function applyTrackingIds(
  request: GatewayRequest,
  provider: Provider,
  userId: string,
  taskId: string | null
) {
  const userHash = generateProviderSpecificHash(userId, provider);
  const taskHash = taskId ? generateProviderSpecificHash(userId + '-' + taskId, provider) : '';
  if (request.kind === 'messages') {
    request.body.metadata = { ...request.body.metadata, user_id: userHash };
    if (provider.id === 'openrouter') {
      request.body.user = userHash;
      if (taskHash) {
        request.body.session_id = taskHash;
      }
    }
  } else {
    if (taskHash) {
      request.body.prompt_cache_key = taskHash;
    }
    request.body.safety_identifier = userHash;
    request.body.user = userHash; // deprecated, but this is what OpenRouter uses
  }
}
