import 'server-only';

import { createGateway, generateText } from 'ai';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';

import { UserByokTestModels } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { getVercelInferenceProviderConfigForUserByok } from '@/lib/ai-gateway/providers/vercel';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { sentryLogger } from '@/lib/utils.server';

const logWarning = sentryLogger('coding-plans-inventory-validation', 'warning');
const MINIMAX_PROVIDER_ID = 'minimax';

export async function validateTokenPlanPlusCredential(apiKey: string): Promise<boolean> {
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
