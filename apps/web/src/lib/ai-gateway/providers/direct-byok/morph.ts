import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'morph',
  base_url: 'https://api.morphllm.com/v1',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'morph',
    recommendedModels: [
      {
        id: 'morph-qwen35-397b',
        name: 'Qwen 3.5 397B',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 131072,
      },
    ],
  }),
} satisfies DirectByokProvider;
