import type { BYOKResult } from '@/lib/byok';
import { kiloFreeModels, preferredModels } from '@/lib/models';
import { isAnthropicModel } from '@/lib/providers/anthropic';
import { getGatewayErrorRate } from '@/lib/providers/gateway-error-rate';
import {
  AutocompleteUserByokProviderIdSchema,
  inferVercelFirstPartyInferenceProviderForModel,
  openRouterToVercelInferenceProviderId,
  VercelUserByokInferenceProviderIdSchema,
} from '@/lib/providers/openrouter/inference-provider-id';
import type {
  OpenRouterChatCompletionRequest,
  OpenRouterProviderConfig,
  VercelInferenceProviderConfig,
  VercelProviderConfig,
} from '@/lib/providers/openrouter/types';
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
  const isOpenRouterErrorRateHigh =
    errorRate.openrouter > ERROR_RATE_THRESHOLD && errorRate.vercel < ERROR_RATE_THRESHOLD;
  if (isOpenRouterErrorRateHigh) {
    console.error(
      `[getVercelRoutingPercentage] OpenRouter error rate is high: ${errorRate.openrouter}`
    );
  }
  return isOpenRouterErrorRateHigh ? 90 : 10;
}

function isOpenRouterModel(requestedModel: string) {
  return (
    (kiloFreeModels.find(m => m.public_id === requestedModel && m.is_enabled)?.gateway ??
      'openrouter') === 'openrouter'
  );
}

export async function shouldRouteToVercel(
  requestedModel: string,
  request: OpenRouterChatCompletionRequest,
  randomSeed: string
) {
  if (request.provider?.data_collection === 'deny') {
    console.debug(
      `[shouldRouteToVercel] not routing to Vercel because data_collection=deny is not supported`
    );
    return false;
  }

  if (!isOpenRouterModel(requestedModel)) {
    console.debug(`[shouldRouteToVercel] model not available on the gateways`);
    return false;
  }

  if (ENABLE_UNIVERSAL_VERCEL_ROUTING) {
    console.debug(`[shouldRouteToVercel] universal Vercel routing is enabled`);
    return true;
  }

  if (!preferredModels.includes(requestedModel)) {
    console.debug(`[shouldRouteToVercel] only recommended models are tested for Vercel routing`);
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

const vercelModelIdMapping = {
  'arcee-ai/trinity-large-preview:free': 'arcee-ai/trinity-large-preview',
  'mistralai/codestral-2508': 'mistral/codestral',
  'mistralai/devstral-2512': 'mistral/devstral-2',
} as Record<string, string>;

export function applyVercelSettings(
  requestedModel: string,
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>,
  userByok: BYOKResult | null
) {
  const vercelModelId = vercelModelIdMapping[requestedModel];
  if (vercelModelId) {
    requestToMutate.model = vercelModelId;
  } else {
    const firstPartyProvider = inferVercelFirstPartyInferenceProviderForModel(requestedModel);
    const slashIndex = requestToMutate.model.indexOf('/');
    if (firstPartyProvider && slashIndex >= 0) {
      requestToMutate.model = firstPartyProvider + requestToMutate.model.slice(slashIndex);
    }
  }

  if (isAnthropicModel(requestedModel)) {
    // https://vercel.com/docs/ai-gateway/model-variants#anthropic-claude-sonnet-4:-1m-token-context-beta
    extraHeaders['anthropic-beta'] = [extraHeaders['x-anthropic-beta'], 'context-1m-2025-08-07']
      .filter(Boolean)
      .join(',');
    delete extraHeaders['x-anthropic-beta'];
  }

  if (userByok) {
    const provider =
      userByok.providerId === AutocompleteUserByokProviderIdSchema.enum.codestral
        ? VercelUserByokInferenceProviderIdSchema.enum.mistral
        : userByok.providerId;
    const list = new Array<VercelInferenceProviderConfig>();
    // Z.AI Coding Plan support
    if (provider === VercelUserByokInferenceProviderIdSchema.enum.zai) {
      list.push({
        apiKey: userByok.decryptedAPIKey,
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
      });
    }
    list.push({ apiKey: userByok.decryptedAPIKey });

    // this is vercel specific BYOK configuration to force vercel gateway to use the BYOK API key
    // for the user/org. If the key is invalid the request will faill - it will not fall back to bill our API key.
    requestToMutate.providerOptions = {
      gateway: {
        only: [provider],
        byok: {
          [provider]: list,
        },
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
