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
import {
  isReasoningExplicitlyDisabled,
  isReasoningExplicitlyEnabled,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { redisGet } from '@/lib/redis';
import { createCachedFetch } from '@/lib/cached-fetch';
import {
  GatewayPercentageSchema,
  DEFAULT_VERCEL_PERCENTAGE,
} from '@/lib/ai-gateway/gateway-config';
import { VERCEL_ROUTING_REDIS_KEY } from '@/lib/redis-keys';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';
import { getVercelModels } from '@/lib/ai-gateway/providers/gateway-models-cache';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';

const getVercelRoutingPercentage = createCachedFetch(
  async () => {
    const raw = await redisGet(VERCEL_ROUTING_REDIS_KEY);
    if (!raw) return DEFAULT_VERCEL_PERCENTAGE;
    const { vercel_routing_percentage } = GatewayPercentageSchema.parse(JSON.parse(raw));
    return vercel_routing_percentage ?? DEFAULT_VERCEL_PERCENTAGE;
  },
  600_000,
  DEFAULT_VERCEL_PERCENTAGE
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

  console.debug('[shouldRouteToVercel] randomizing user to either OpenRouter or Vercel');
  const [routingPercentage, vercelModels] = await Promise.all([
    getVercelRoutingPercentage(),
    getVercelModels(),
  ]);

  const passedRandomization =
    getRandomNumber('vercel_routing_' + randomSeed, 100) < routingPercentage;

  if (!passedRandomization) {
    return false;
  }

  const vercelModelId = mapModelIdToVercel(requestedModel, isReasoningExplicitlyDisabled(request));
  if (!vercelModels.has(vercelModelId)) {
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

export function getAnthropicProviderOptionsForVercel(
  requestedModel: string,
  request: GatewayRequest
): AnthropicProviderOptions | undefined {
  const anthropicOptions: AnthropicProviderOptions = {};

  // Workaround for Vercel not displaying thinking by default, unlike OpenRouter.
  const isOpus47Thinking =
    requestedModel.includes('opus-4.7') && isReasoningExplicitlyEnabled(request);
  if (isOpus47Thinking) {
    anthropicOptions.thinking = { type: 'adaptive', display: 'summarized' };
  }

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
    const anthropicOptions = getAnthropicProviderOptionsForVercel(requestedModel, requestToMutate);
    if (anthropicOptions) {
      requestToMutate.body.providerOptions.anthropic = anthropicOptions;
    }
  }

  delete requestToMutate.body.provider;
}
