import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';

export default {
  id: 'xiaomi-token-plan-sgp',
  base_url: 'https://token-plan-sgp.xiaomimimo.com/v1',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'xiaomi-token-plan-sgp',
    recommendedModels: [
      {
        id: 'mimo-v2.5-pro',
        name: 'MiMo-V2.5-Pro',
        context_length: 1048576,
        max_completion_tokens: 131072,
      },
    ],
  }),
} satisfies DirectByokProvider;
