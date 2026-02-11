import type { BYOKResult } from '@/lib/byok';
import { getEnvVariable } from '@/lib/dotenvx';
import { isAnthropicModel } from '@/lib/providers/anthropic';
import { minimax_m21_free_model, minimax_m21_free_slackbot_model } from '@/lib/providers/minimax';
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
import { zai_glm47_free_model } from '@/lib/providers/zai';
import * as crypto from 'crypto';

const VERCEL_ROUTING_PERCENTAGE = 10;

const VERCEL_ROUTING_ALLOW_LIST = [
  'arcee-ai/trinity-large-preview:free',
  'google/gemini-3-pro-preview',
  'google/gemini-3-flash-preview',
  minimax_m21_free_model.public_id,
  'minimax/minimax-m2.1',
  'openai/gpt-5.2',
  'openai/gpt-5.2-codex',
  'x-ai/grok-code-fast-1',
  zai_glm47_free_model.public_id,
  'z-ai/glm-4.7',
];

function getRandomNumberLessThan100(userId: string) {
  return crypto.createHash('sha256').update(userId).digest().readUInt32BE(0) % 100;
}

export async function shouldRouteToVercel(
  requestedModel: string,
  request: OpenRouterChatCompletionRequest,
  userId: string
) {
  if (!VERCEL_ROUTING_ALLOW_LIST.includes(requestedModel)) {
    console.debug(`[shouldRouteToVercel] model not on the allow list for Vercel routing`);
    return false;
  }

  if (request.provider?.data_collection === 'deny') {
    console.debug(
      `[shouldRouteToVercel] not routing to Vercel because data_collection=deny is not supported`
    );
    return false;
  }

  console.debug('[shouldRouteToVercel] randomizing user to either OpenRouter or Vercel');
  return getRandomNumberLessThan100('vercel_routing_' + userId) < VERCEL_ROUTING_PERCENTAGE;
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
  'google/gemini-3-flash-preview': 'google/gemini-3-flash',
  'mistralai/codestral-2508': 'mistral/codestral',
  'mistralai/devstral-2512': 'mistral/devstral-2',
  'mistralai/devstral-2512:free': 'mistral/devstral-2',
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
  } else if (requestedModel === minimax_m21_free_slackbot_model.public_id) {
    requestToMutate.providerOptions = {
      gateway: {
        only: [VercelUserByokInferenceProviderIdSchema.enum.minimax],
        byok: {
          [VercelUserByokInferenceProviderIdSchema.enum.minimax]: [
            { apiKey: getEnvVariable('MINIMAX_FREE_SLACKBOT_PROMOTION_API_KEY') },
          ],
        },
      },
    };
  } else {
    requestToMutate.providerOptions = convertProviderOptions(requestToMutate.provider);
  }

  if (
    isAnthropicModel(requestedModel) &&
    requestToMutate.providerOptions &&
    requestToMutate.verbosity
  ) {
    requestToMutate.providerOptions.anthropic = {
      effort: requestToMutate.verbosity,
    };
  }

  delete requestToMutate.provider;
}
