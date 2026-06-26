import 'server-only';

import { createGateway, generateText } from 'ai';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';

import { UserByokTestModels } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { getVercelInferenceProviderConfigForUserByok } from '@/lib/ai-gateway/providers/vercel';
import type { CodingPlanId } from '@/lib/coding-plans/pricing';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { sentryLogger } from '@/lib/utils.server';

const logWarning = sentryLogger('coding-plans-inventory-validation', 'warning');
const MINIMAX_PROVIDER_ID = 'minimax';
const MINIMAX_PLAN_TIER_MARKERS = {
  'minimax-token-plan-plus': 'plus',
  'minimax-token-plan-max': 'max',
  'minimax-token-plan-ultra': 'ultra',
} satisfies Record<CodingPlanId, string>;

export type MiniMaxCodingPlanCredentialValidationInput = {
  apiKey: string;
  planId: CodingPlanId;
  upstreamPlanId: string;
};

function upstreamPlanIdMatchesSelectedTier(planId: CodingPlanId, upstreamPlanId: string): boolean {
  const expectedTier = MINIMAX_PLAN_TIER_MARKERS[planId];
  const normalizedSegments = upstreamPlanId
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return normalizedSegments.includes(expectedTier);
}

export async function validateMiniMaxCodingPlanCredential({
  apiKey,
  planId,
  upstreamPlanId,
}: MiniMaxCodingPlanCredentialValidationInput): Promise<boolean> {
  if (!upstreamPlanIdMatchesSelectedTier(planId, upstreamPlanId)) {
    logWarning('MiniMax inventory credential upstream plan tier mismatch', {
      providerId: MINIMAX_PROVIDER_ID,
      planId,
    });
    return false;
  }

  const [finalProvider, byokList] = getVercelInferenceProviderConfigForUserByok({
    providerId: MINIMAX_PROVIDER_ID,
    decryptedAPIKey: apiKey,
  });

  try {
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
  } catch {
    logWarning('MiniMax inventory credential validation failed', {
      providerId: MINIMAX_PROVIDER_ID,
    });
    return false;
  }
}
