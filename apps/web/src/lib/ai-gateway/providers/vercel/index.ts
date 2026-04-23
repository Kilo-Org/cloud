import type { BYOKResult } from '@/lib/ai-gateway/providers/types';
import type { VercelUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  DirectUserByokInferenceProviderIdSchema,
  AwsCredentialsSchema,
  openRouterToVercelInferenceProviderId,
  VercelUserByokInferenceProviderIdSchema,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  OpenRouterProviderConfig,
  GatewayRequest,
  VercelInferenceProviderConfig,
  VercelProviderConfig,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { StoredModelSchema } from '@kilocode/db';
import * as z from 'zod';
import { redisGet, redisSet } from '@/lib/redis';
import { createCachedFetch } from '@/lib/cached-fetch';
import { GatewayPercentageSchema, DEFAULT_VERCEL_PERCENTAGE } from '@/lib/gateway-config';
import {
  GATEWAY_METADATA_REDIS_KEYS,
  VERCEL_ROUTING_REDIS_KEY,
  stickyVercelRoutingRedisKey,
} from '@/lib/redis-keys';
import { getRandomNumberLessThan100 } from '@/lib/ai-gateway/getRandomNumberLessThan100';
import { captureException } from '@sentry/nextjs';

// Sticky routing: once a session has been assigned to vercel or openrouter, keep
// serving it from the same gateway so percentage/model-list changes don't flip
// the decision mid-session. Only re-evaluate if the old choice becomes invalid
// (i.e. vercel was chosen but no longer supports the requested model).
const STICKY_ROUTING_TTL_SECONDS = 24 * 60 * 60;
type StickyRouting = 'vercel' | 'openrouter';

async function readStickyRouting(seed: string): Promise<StickyRouting | null> {
  try {
    const value = await redisGet(stickyVercelRoutingRedisKey(seed));
    if (value === 'vercel' || value === 'openrouter') return value;
    return null;
  } catch {
    return null;
  }
}

async function writeStickyRouting(seed: string, routing: StickyRouting): Promise<void> {
  try {
    await redisSet(stickyVercelRoutingRedisKey(seed), routing, STICKY_ROUTING_TTL_SECONDS);
  } catch (err) {
    captureException(err, { tags: { service: 'redis', operation: 'sticky-vercel-routing' } });
  }
}

const getVercelRoutingPercentage = createCachedFetch(
  async () => {
    const raw = await redisGet(VERCEL_ROUTING_REDIS_KEY);
    return GatewayPercentageSchema.parse(JSON.parse(raw ?? 'null')).vercel_routing_percentage;
  },
  10_000,
  DEFAULT_VERCEL_PERCENTAGE
);

const getVercelModels = createCachedFetch(
  async function () {
    const result = JSON.parse((await redisGet(GATEWAY_METADATA_REDIS_KEYS.vercelModels)) ?? 'null');
    if (Object.keys(result).length === 0) {
      console.debug('[getVercelModels] no Vercel models found in Redis');
    }
    return Object.values(z.record(z.string(), StoredModelSchema).parse(result))
      .filter(model => model.type === 'language' && model.endpoints.length > 0)
      .map(model => model.id);
  },
  60_000,
  []
);

export async function shouldRouteToVercel(
  requestedModel: string,
  request: GatewayRequest,
  randomSeed: string
) {
  if (request.body.provider?.data_collection === 'deny') {
    console.debug(
      `[shouldRouteToVercel] not routing to Vercel because data_collection=deny is not supported`
    );
    return false;
  }

  if ((request.body.provider?.ignore?.length ?? 0) > 0) {
    console.debug(
      `[shouldRouteToVercel] not routing to Vercel because provider.ignore is not supported`
    );
    return false;
  }

  const vercelModels = await getVercelModels();
  const vercelModelId = mapModelIdToVercel(requestedModel, isReasoningExplicitlyDisabled(request));
  const modelSupportedByVercel = vercelModels.includes(vercelModelId);

  const sticky = await readStickyRouting(randomSeed);
  if (sticky === 'openrouter') {
    console.debug('[shouldRouteToVercel] sticky routing: OpenRouter');
    return false;
  }
  if (sticky === 'vercel') {
    if (!modelSupportedByVercel) {
      console.debug(
        '[shouldRouteToVercel] sticky routing: Vercel, but model not supported — falling back to OpenRouter for this request'
      );
      return false;
    }
    console.debug('[shouldRouteToVercel] sticky routing: Vercel');
    return true;
  }

  console.debug('[shouldRouteToVercel] randomizing user to either OpenRouter or Vercel');
  const passedRandomization =
    getRandomNumberLessThan100('vercel_routing_' + randomSeed) <
    (await getVercelRoutingPercentage());

  if (!passedRandomization) {
    await writeStickyRouting(randomSeed, 'openrouter');
    return false;
  }

  // Persist the sticky vercel decision regardless of whether the *current*
  // request's model is supported by vercel. Model support is a per-request
  // filter applied on top of the session-level decision, so a later request
  // with a supported model can still be served by Vercel, and percentage
  // changes will no longer flip this session.
  await writeStickyRouting(randomSeed, 'vercel');

  if (!modelSupportedByVercel) {
    console.debug(`[shouldRouteToVercel] model not found in Vercel model list`);
    return false;
  }

  return true;
}

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
    provider.providerId === DirectUserByokInferenceProviderIdSchema.enum.codestral
      ? VercelUserByokInferenceProviderIdSchema.enum.mistral
      : VercelUserByokInferenceProviderIdSchema.parse(provider.providerId);

  const list = new Array<VercelInferenceProviderConfig>();

  if (key === VercelUserByokInferenceProviderIdSchema.enum.zai) {
    // Z.ai Coding Plan support
    // ideally we remove this and have people use the explicit Z.ai Coding Plan option,
    // but that's a breaking change
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
  requestToMutate: GatewayRequest,
  userByok: BYOKResult[] | null
) {
  requestToMutate.body.model = mapModelIdToVercel(
    requestedModel,
    isReasoningExplicitlyDisabled(requestToMutate)
  );

  if (userByok) {
    if (userByok.length === 0) {
      throw new Error('Invalid state: userByok should be null or not empty');
    }
    const byokProviders: Record<string, VercelInferenceProviderConfig[]> = {};
    for (const provider of userByok) {
      const [key, list] = getVercelInferenceProviderConfigForUserByok(provider);
      byokProviders[key] = [...(byokProviders[key] ?? []), ...list];
    }

    // this is vercel specific BYOK configuration to force vercel gateway to use the BYOK API key
    // for the user/org. If the key is invalid the request will faill - it will not fall back to bill our API key.
    requestToMutate.body.providerOptions = {
      gateway: {
        only: Object.keys(byokProviders),
        byok: byokProviders,
      },
    };
  } else {
    requestToMutate.body.providerOptions = convertProviderOptions(requestToMutate.body.provider);
  }

  if (requestToMutate.body.providerOptions) {
    if (requestToMutate.kind === 'chat_completions' && requestToMutate.body.verbosity) {
      requestToMutate.body.providerOptions.anthropic = {
        effort: requestToMutate.body.verbosity,
      };
    }
    if (requestToMutate.kind === 'responses' && requestToMutate.body.text?.verbosity) {
      requestToMutate.body.providerOptions.anthropic = {
        effort: requestToMutate.body.text.verbosity,
      };
    }
  }

  delete requestToMutate.body.provider;
}
