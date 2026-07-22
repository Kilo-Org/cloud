import type { BYOKResult } from '@/lib/ai-gateway/providers/types';
import type { VercelUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  DirectUserByokInferenceProviderIdSchema,
  AwsCredentialsSchema,
  openRouterToVercelInferenceProviderId,
  VercelUserByokInferenceProviderIdSchema,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  GatewayRequest,
  VercelInferenceProviderConfig,
  VercelProviderConfig,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { redisClient } from '@/lib/redis';
import { createCachedFetch } from '@/lib/cached-fetch';
import {
  GatewayPercentageSchema,
  DEFAULT_VERCEL_PERCENTAGE,
} from '@/lib/ai-gateway/gateway-config';
import { VERCEL_ROUTING_REDIS_KEY } from '@/lib/redis-keys';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';
import {
  getCachedVercelInferenceProviderIdsForModel,
  getVercelModelsFromRedis,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';

const getVercelRoutingPercentage = createCachedFetch(
  async () => {
    const raw = await redisClient.get<string>(VERCEL_ROUTING_REDIS_KEY);
    if (!raw) return DEFAULT_VERCEL_PERCENTAGE;
    const { vercel_routing_percentage } = GatewayPercentageSchema.parse(JSON.parse(raw));
    return vercel_routing_percentage ?? DEFAULT_VERCEL_PERCENTAGE;
  },
  600_000,
  DEFAULT_VERCEL_PERCENTAGE
);

export function hasCompatibleVercelInferenceProvider(
  openRouterInferenceProviders: string[],
  vercelInferenceProviders: string[] | null
) {
  if (!vercelInferenceProviders) {
    return true;
  }

  return openRouterInferenceProviders.some(provider =>
    vercelInferenceProviders.includes(openRouterToVercelInferenceProviderId(provider))
  );
}

export function getVercelInferenceProvidersExcludingIgnored(
  ignoredProviders: string[],
  onlyProviders: string[] | undefined,
  vercelInferenceProviders: string[]
) {
  const ignored = new Set(ignoredProviders.map(openRouterToVercelInferenceProviderId));
  const only = onlyProviders
    ? new Set(onlyProviders.map(openRouterToVercelInferenceProviderId))
    : null;

  return vercelInferenceProviders.filter(
    provider => !ignored.has(provider) && (!only || only.has(provider))
  );
}

export function passesVercelRoutingPercentage(randomSeed: string, routingPercentage: number) {
  const routingSeed = 'vercel_routing_' + randomSeed;
  const wholePercentageBucket = getRandomNumber(routingSeed, 100);
  const fractionalPercentageBucket = getRandomNumber(routingSeed + '_fractional', 1_000);

  return wholePercentageBucket + fractionalPercentageBucket / 1_000 < routingPercentage;
}

export async function shouldRouteToVercel(
  requestedModel: string,
  request: GatewayRequest,
  randomSeed: string
) {
  console.debug('[shouldRouteToVercel] randomizing user to either OpenRouter or Vercel');
  const routingPercentage = await getVercelRoutingPercentage();

  const passedRandomization = passesVercelRoutingPercentage(randomSeed, routingPercentage);

  if (!passedRandomization) {
    return false;
  }

  const vercelModels = await getVercelModelsFromRedis();
  const vercelModelId = mapModelIdToVercel(requestedModel);
  if (!vercelModels.has(vercelModelId)) {
    console.debug(`[shouldRouteToVercel] model not found in Vercel model list`);
    return false;
  }

  const provider = request.body.provider;
  if (provider && (provider.only || provider.ignore?.length)) {
    const { only, ignore } = provider;
    const vercelInferenceProviders =
      await getCachedVercelInferenceProviderIdsForModel(vercelModelId);

    if (ignore?.length) {
      if (!vercelInferenceProviders) {
        console.debug(
          '[shouldRouteToVercel] not routing to Vercel because inference provider data is unavailable'
        );
        return false;
      }

      const effectiveOnly = getVercelInferenceProvidersExcludingIgnored(
        ignore,
        only,
        vercelInferenceProviders
      );
      if (effectiveOnly.length === 0) {
        console.debug(
          '[shouldRouteToVercel] no inference providers remain after applying provider preferences'
        );
        return false;
      }
    } else if (only && !hasCompatibleVercelInferenceProvider(only, vercelInferenceProviders)) {
      console.debug(
        '[shouldRouteToVercel] none of the requested inference providers are available on Vercel'
      );
      return false;
    }
  }

  return true;
}

export function convertProviderOptions(
  requestToMutate: GatewayRequest,
  vercelInferenceProviders: string[] | null
): VercelProviderConfig {
  const provider = requestToMutate.body.provider;
  const only = (() => {
    if (!provider?.ignore?.length) {
      return provider?.only?.map(openRouterToVercelInferenceProviderId);
    }
    if (!vercelInferenceProviders) {
      throw new Error('Vercel inference provider data became unavailable during request transform');
    }
    return getVercelInferenceProvidersExcludingIgnored(
      provider.ignore,
      provider.only,
      vercelInferenceProviders
    );
  })();

  return {
    gateway: {
      only,
      order: provider?.order?.map(p => openRouterToVercelInferenceProviderId(p)),
      zeroDataRetention: provider?.zdr,
      disallowPromptTraining: provider?.data_collection === 'deny' || undefined,
      models: requestToMutate.body.models,
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

export function getAnthropicProviderOptionsForVercel(
  request: GatewayRequest
): AnthropicProviderOptions | undefined {
  const anthropicOptions: AnthropicProviderOptions = {};

  if (request.kind === 'chat_completions' && request.body.verbosity) {
    anthropicOptions.effort = request.body.verbosity;
  }
  if (request.kind === 'responses' && request.body.text?.verbosity) {
    anthropicOptions.effort = request.body.text.verbosity;
  }

  if (Object.keys(anthropicOptions).length === 0) {
    return undefined;
  }

  return anthropicOptions;
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

export async function applyVercelSettings(
  requestedModel: string,
  requestToMutate: GatewayRequest,
  userByok: BYOKResult[] | null
) {
  const vercelModelId = mapModelIdToVercel(requestedModel);
  requestToMutate.body.model = vercelModelId;

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
        models: requestToMutate.body.models,
      },
    };
  } else {
    const vercelInferenceProviders = requestToMutate.body.provider?.ignore?.length
      ? await getCachedVercelInferenceProviderIdsForModel(vercelModelId)
      : null;
    requestToMutate.body.providerOptions = convertProviderOptions(
      requestToMutate,
      vercelInferenceProviders
    );
  }

  if (requestToMutate.body.providerOptions) {
    const anthropicOptions = getAnthropicProviderOptionsForVercel(requestToMutate);
    if (anthropicOptions) {
      requestToMutate.body.providerOptions.anthropic = anthropicOptions;
    }
  }

  delete requestToMutate.body.provider;
  delete requestToMutate.body.models;
}
