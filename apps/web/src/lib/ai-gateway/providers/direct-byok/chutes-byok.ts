import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { REASONING_VARIANTS_LOW_MEDIUM_HIGH } from '@/lib/ai-gateway/providers/model-settings';

export default {
  id: 'chutes-byok',
  base_url: 'https://llm.chutes.ai/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    const { request } = context;
    if (request.kind !== 'chat_completions') {
      return;
    }
    request.body.reasoning_effort ??= request.body.reasoning?.effort ?? undefined;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'chutes-byok',
    recommendedModels: [
      {
        id: 'moonshotai/Kimi-K2.6-TEE',
        name: 'Kimi-K2.6',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 65535,
      },
    ],
    variants: REASONING_VARIANTS_LOW_MEDIUM_HIGH,
  }),
} satisfies DirectByokProvider;
