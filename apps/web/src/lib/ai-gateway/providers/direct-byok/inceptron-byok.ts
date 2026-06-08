import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'inceptron-byok',
  base_url: 'https://api.inceptron.io/v1',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'inceptron-byok',
    recommendedModels: [
      {
        id: 'moonshotai/Kimi-K2.6',
        name: 'Kimi K2.6',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 262144,
      },
    ],
  }),
} satisfies DirectByokProvider;
