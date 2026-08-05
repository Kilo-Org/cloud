import 'server-only';

import { createGateway, generateText } from 'ai';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';

import { UserByokTestModels } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { createAiSdkProvider } from '@/lib/ai-gateway/providers/direct-byok';
import byteplusCoding from '@/lib/ai-gateway/providers/direct-byok/byteplus-coding';
import { getVercelInferenceProviderConfigForUserByok } from '@/lib/ai-gateway/providers/vercel';
import type { CodingPlanId, CodingPlanProviderId } from '@/lib/coding-plans/pricing';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { sentryLogger } from '@/lib/utils.server';

const logWarning = sentryLogger('coding-plans-inventory-validation', 'warning');
const MINIMAX_PROVIDER_ID = 'minimax';

export type CodingPlanCredentialValidationInput = {
  apiKey: string;
  planId: CodingPlanId;
  providerId: CodingPlanProviderId;
  upstreamPlanId: string;
};

async function validateMiniMaxCodingPlanCredential(apiKey: string): Promise<boolean> {
  const [finalProvider, byokList] = getVercelInferenceProviderConfigForUserByok({
    providerId: MINIMAX_PROVIDER_ID,
    decryptedAPIKey: apiKey,
  });

  const output = await generateText({
    model: createGateway({ apiKey: PROVIDERS.VERCEL_AI_GATEWAY.apiKey })(
      UserByokTestModels[MINIMAX_PROVIDER_ID]
    ),
    prompt: 'Say hi',
    maxOutputTokens: 1,
    providerOptions: {
      gateway: {
        only: [finalProvider],
        byok: { [finalProvider]: byokList },
      } satisfies GatewayProviderOptions,
    },
  });

  return output.finishReason === 'stop' || output.finishReason === 'length';
}

async function validateBytePlusCodingPlanCredential(apiKey: string): Promise<boolean> {
  const output = await generateText({
    model: createAiSdkProvider(byteplusCoding, apiKey)('bytedance-seed-code'),
    prompt: 'Say hi',
    maxOutputTokens: 1,
  });

  return output.finishReason === 'stop' || output.finishReason === 'length';
}

export async function validateCodingPlanCredential({
  apiKey,
  providerId,
}: CodingPlanCredentialValidationInput): Promise<boolean> {
  try {
    switch (providerId) {
      case 'minimax':
        return await validateMiniMaxCodingPlanCredential(apiKey);
      case 'byteplus-coding':
        return await validateBytePlusCodingPlanCredential(apiKey);
    }
  } catch {
    logWarning('Coding plan inventory credential validation failed', { providerId });
    return false;
  }
}
