import type { BYOKResult } from '@/lib/providers/types';
import { kiloFreeModels } from '@/lib/models';
import { isAnthropicModel } from '@/lib/providers/anthropic';
import { getGatewayErrorRate } from '@/lib/providers/gateway-error-rate';
import { isGeminiModel } from '@/lib/providers/google';
import { isMinimaxModel } from '@/lib/providers/minimax';
import { isMoonshotModel } from '@/lib/providers/moonshotai';
import { isOpenAiOssModel } from '@/lib/providers/openai';
import type { VercelUserByokInferenceProviderId } from '@/lib/providers/openrouter/inference-provider-id';
import {
  DirectUserByokInferenceProviderIdSchema,
  AwsCredentialsSchema,
  openRouterToVercelInferenceProviderId,
  VercelUserByokInferenceProviderIdSchema,
} from '@/lib/providers/openrouter/inference-provider-id';
import type {
  OpenRouterProviderConfig,
  GatewayRequest,
  VercelInferenceProviderConfig,
  VercelProviderConfig,
} from '@/lib/providers/openrouter/types';
import { mapModelIdToVercel } from '@/lib/providers/vercel/mapModelIdToVercel';
import { mimo_v2_pro_free_model } from '@/lib/providers/xiaomi';
import { isZaiModel } from '@/lib/providers/zai';
import * as crypto from 'crypto';

// EMERGENCY SWITCH
// This routes all models that normally would be routed to OpenRouter to Vercel instead.
// Many of these models are not available, named differently or not tested on Vercel.
// Only use when OpenRouter is down and automatic failover is not working adequately.
const ENABLE_UNIVERSAL_VERCEL_ROUTING = false;

const ERROR_RATE_THRESHOLD = 0.5;

function getRandomNumberLessThan100(randomSeed: string) {
  return crypto.createHash('sha256').update(randomSeed).digest().readUInt32BE(0) % 100;
}

async function getVercelRoutingPercentage() {
  const errorRate = await getGatewayErrorRate();
  const isOpenRouterErrorRateHigh = errorRate.openrouter > ERROR_RATE_THRESHOLD;
  const isVercelErrorRateHigh = errorRate.vercel > ERROR_RATE_THRESHOLD;
  if (isOpenRouterErrorRateHigh && !isVercelErrorRateHigh) {
    console.error(
      `[getVercelRoutingPercentage] OpenRouter error rate is high: ${errorRate.openrouter}`
    );
    return 90;
  }
  if (!isOpenRouterErrorRateHigh && isVercelErrorRateHigh) {
    console.error(`[getVercelRoutingPercentage] Vercel error rate is high: ${errorRate.vercel}`);
    return 10;
  }
  return 10;
}

function isLikelyAvailableOnAllGateways(requestedModel: string) {
  return (
    !requestedModel.startsWith('openrouter/') &&
    (kiloFreeModels.find(m => m.public_id === requestedModel && m.status !== 'disabled')?.gateway ??
      'openrouter') === 'openrouter'
  );
}

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

  if (!isLikelyAvailableOnAllGateways(requestedModel)) {
    console.debug(`[shouldRouteToVercel] model not available on all gateways`);
    return false;
  }

  if (ENABLE_UNIVERSAL_VERCEL_ROUTING) {
    console.debug(`[shouldRouteToVercel] universal Vercel routing is enabled`);
    return true;
  }

  if (
    !requestedModel.startsWith('arcee-ai/') &&
    !isAnthropicModel(requestedModel) &&
    !isGeminiModel(requestedModel) &&
    !isMinimaxModel(requestedModel) &&
    !isMoonshotModel(requestedModel) &&
    !isOpenAiOssModel(requestedModel) &&
    requestedModel !== mimo_v2_pro_free_model.public_id &&
    !isZaiModel(requestedModel)
  ) {
    console.debug(`[shouldRouteToVercel] model family not allowed for randomized Vercel routing`);
    return false;
  }

  console.debug('[shouldRouteToVercel] randomizing user to either OpenRouter or Vercel');
  return (
    getRandomNumberLessThan100('vercel_routing_' + randomSeed) <
    (await getVercelRoutingPercentage())
  );
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
  requestToMutate.body.model = mapModelIdToVercel(requestedModel);

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
