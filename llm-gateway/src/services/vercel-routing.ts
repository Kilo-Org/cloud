import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import type { OpenRouterChatCompletionRequest } from '@kilocode/llm-shared';
import {
  isAnthropicModel,
  kiloFreeModels,
  preferredModels,
  AutocompleteUserByokProviderIdSchema,
  AwsCredentialsSchema,
  openRouterToVercelInferenceProviderId,
  inferVercelFirstPartyInferenceProviderForModel,
  VercelUserByokInferenceProviderIdSchema,
  type VercelUserByokInferenceProviderId,
  type VercelProviderConfig,
  type VercelInferenceProviderConfig,
} from '@kilocode/llm-shared';
import type { OpenRouterProviderConfig } from '@kilocode/llm-shared';
import type { WorkerDb } from '../lib/db.js';
import type { BYOKResult } from './byok.js';
import { logger } from '../logger.js';

// --- mapModelIdToVercel (inline, not exported from llm-shared) ---

const vercelModelIdMapping: Record<string, string | undefined> = {
  'arcee-ai/trinity-large-preview:free': 'arcee-ai/trinity-large-preview',
  'mistralai/codestral-2508': 'mistral/codestral',
  'mistralai/devstral-2512': 'mistral/devstral-2',
};

function mapModelIdToVercel(modelId: string): string {
  const hardcodedVercelId = vercelModelIdMapping[modelId];
  if (hardcodedVercelId) return hardcodedVercelId;

  const internalId =
    kiloFreeModels.find(m => m.public_id === modelId && m.is_enabled && m.gateway === 'openrouter')
      ?.internal_id ?? modelId;

  const slashIndex = internalId.indexOf('/');
  if (slashIndex < 0) return internalId;

  const firstPartyProvider = inferVercelFirstPartyInferenceProviderForModel(internalId);
  return firstPartyProvider ? firstPartyProvider + internalId.slice(slashIndex) : internalId;
}

// --- Gateway error rate with KV caching ---

// Emergency switch: routes all OpenRouter-eligible models to Vercel.
// Only use when OpenRouter is down and automatic failover is inadequate.
const ENABLE_UNIVERSAL_VERCEL_ROUTING = false;

const ERROR_RATE_THRESHOLD = 0.5;

function getRandomNumberLessThan100(randomSeed: string) {
  return createHash('sha256').update(randomSeed).digest().readUInt32BE(0) % 100;
}

async function getGatewayErrorRate(
  db: WorkerDb,
  kv: KVNamespace
): Promise<{ openrouter: number; vercel: number }> {
  const cacheKey = 'gateway-error-rate';
  const cached = await kv.get(cacheKey, 'json');
  if (cached) {
    return cached as { openrouter: number; vercel: number };
  }

  try {
    const start = performance.now();
    const result = await Promise.race([
      db.execute(sql`
        select
          provider as "gateway",
          1.0 * count(*) filter(where has_error = true) / count(*) as "errorRate"
        from microdollar_usage_view
        where true
          and created_at >= now() - interval '10 minutes'
          and is_user_byok = false
          and provider in ('openrouter', 'vercel')
        group by provider
      `),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 500)),
    ]);

    if (result === 'timeout') {
      logger.debug(`[getGatewayErrorRate] query timeout after ${performance.now() - start}ms`);
      return { openrouter: 0, vercel: 0 };
    }

    const rows = z
      .array(z.object({ gateway: z.string(), errorRate: z.coerce.number() }))
      .parse(result.rows);

    const errorRate = {
      openrouter: rows.find(r => r.gateway === 'openrouter')?.errorRate ?? 0,
      vercel: rows.find(r => r.gateway === 'vercel')?.errorRate ?? 0,
    };

    await kv.put(cacheKey, JSON.stringify(errorRate), { expirationTtl: 60 });
    return errorRate;
  } catch (e) {
    logger.debug('[getGatewayErrorRate] query error', { error: String(e) });
    return { openrouter: 0, vercel: 0 };
  }
}

async function getVercelRoutingPercentage(db: WorkerDb, kv: KVNamespace) {
  const errorRate = await getGatewayErrorRate(db, kv);
  const isOpenRouterErrorRateHigh =
    errorRate.openrouter > ERROR_RATE_THRESHOLD && errorRate.vercel < ERROR_RATE_THRESHOLD;
  if (isOpenRouterErrorRateHigh) {
    logger.error(`OpenRouter error rate is high: ${errorRate.openrouter}`);
  }
  return isOpenRouterErrorRateHigh ? 90 : 10;
}

function isLikelyAvailableOnAllGateways(requestedModel: string) {
  return (
    !requestedModel.startsWith('openrouter/') &&
    (kiloFreeModels.find(m => m.public_id === requestedModel && m.is_enabled)?.gateway ??
      'openrouter') === 'openrouter'
  );
}

// --- Routing decision ---

export async function shouldRouteToVercel(
  requestedModel: string,
  request: OpenRouterChatCompletionRequest,
  randomSeed: string,
  db: WorkerDb,
  kv: KVNamespace
): Promise<boolean> {
  if (request.provider?.data_collection === 'deny') {
    logger.debug('not routing to Vercel because data_collection=deny is not supported');
    return false;
  }

  if (!isLikelyAvailableOnAllGateways(requestedModel)) {
    logger.debug('model not available on all gateways');
    return false;
  }

  if (ENABLE_UNIVERSAL_VERCEL_ROUTING) {
    logger.debug('universal Vercel routing is enabled');
    return true;
  }

  if (isAnthropicModel(requestedModel)) {
    logger.debug(
      'Anthropic models are not routed to Vercel pending fine-grained tool streaming support'
    );
    return false;
  }

  if (!preferredModels.includes(requestedModel)) {
    logger.debug('only recommended models are tested for Vercel routing');
    return false;
  }

  logger.debug('randomizing user to either OpenRouter or Vercel');
  return (
    getRandomNumberLessThan100('vercel_routing_' + randomSeed) <
    (await getVercelRoutingPercentage(db, kv))
  );
}

// --- Vercel settings (pure functions) ---

function convertProviderOptions(
  provider: OpenRouterProviderConfig | undefined
): VercelProviderConfig | undefined {
  return {
    gateway: {
      only: provider?.only?.map(p => openRouterToVercelInferenceProviderId(p)),
      order: provider?.order?.map(p => openRouterToVercelInferenceProviderId(p)),
      zeroDataRetention: provider?.zdr,
    },
  };
}

function parseAwsCredentials(input: string) {
  try {
    return AwsCredentialsSchema.parse(JSON.parse(input));
  } catch {
    throw new Error('Failed to parse AWS credentials');
  }
}

export function getVercelInferenceProviderConfigForUserByok(
  provider: BYOKResult
): [VercelUserByokInferenceProviderId, VercelInferenceProviderConfig[]] {
  const key =
    provider.providerId === AutocompleteUserByokProviderIdSchema.enum.codestral
      ? VercelUserByokInferenceProviderIdSchema.enum.mistral
      : provider.providerId;
  const list = new Array<VercelInferenceProviderConfig>();

  if (key === VercelUserByokInferenceProviderIdSchema.enum.zai) {
    list.push({
      apiKey: provider.decryptedAPIKey,
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
    });
  }

  if (key === VercelUserByokInferenceProviderIdSchema.enum.bedrock) {
    list.push(parseAwsCredentials(provider.decryptedAPIKey));
  } else {
    list.push({ apiKey: provider.decryptedAPIKey });
  }
  return [key, list];
}

export function applyVercelSettings(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult[] | null
) {
  requestToMutate.model = mapModelIdToVercel(requestedModel);

  if (isAnthropicModel(requestedModel)) {
    extraHeaders['anthropic-beta'] = [extraHeaders['x-anthropic-beta'], 'context-1m-2025-08-07']
      .filter(Boolean)
      .join(',');
    delete extraHeaders['x-anthropic-beta'];
  }

  if (userByok) {
    if (userByok.length === 0) {
      throw new Error('Invalid state: userByok should be null or not empty');
    }
    const byokProviders: Record<string, VercelInferenceProviderConfig[]> = {};
    for (const provider of userByok) {
      const [key, list] = getVercelInferenceProviderConfigForUserByok(provider);
      byokProviders[key] = [...(byokProviders[key] ?? []), ...list];
    }

    requestToMutate.providerOptions = {
      gateway: {
        only: Object.keys(byokProviders),
        byok: byokProviders,
      },
    };
  } else {
    requestToMutate.providerOptions = convertProviderOptions(requestToMutate.provider);
  }

  if (requestToMutate.providerOptions && requestToMutate.verbosity) {
    requestToMutate.providerOptions.anthropic = {
      effort: requestToMutate.verbosity,
    };
  }

  delete requestToMutate.provider;
}
