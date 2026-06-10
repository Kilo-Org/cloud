import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'martian',
  base_url: 'https://api.withmartian.com/v1',
  supported_chat_apis: ['chat_completions', 'messages', 'responses'],
  default_ai_sdk_provider: 'openrouter',
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'martian',
    recommendedModels: [
      {
        id: 'moonshotai/kimi-k2.6',
        name: 'kimi-k2.6',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 65535,
      },
    ],
  }),
} satisfies DirectByokProvider;
