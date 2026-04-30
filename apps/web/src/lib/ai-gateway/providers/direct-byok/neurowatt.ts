import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'neuralwatt',
  base_url: 'https://api.neuralwatt.com/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(_context) {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'neuralwatt',
    recommendedModels: [
      {
        id: 'moonshotai/Kimi-K2.6',
        name: 'Kimi-K2.6',
        flags: [],
        context_length: 262144,
        max_completion_tokens: 32000,
        variants: null,
      },
    ],
    variants: null,
  }),
} satisfies DirectByokProvider;
