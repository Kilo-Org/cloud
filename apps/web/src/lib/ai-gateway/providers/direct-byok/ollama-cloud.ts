import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'ollama-cloud',
  base_url: 'https://ollama.com/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(_context) {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'ollama-cloud',
    recommendedModels: [
      {
        id: 'kimi-k2.6:cloud',
        name: 'kimi-k2.6',
        description:
          'A high-performance cloud-based model optimized for advanced reasoning, complex instruction following, and sophisticated multilingual tasks.',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 262144,
        variants: null,
      },
    ],
    variants: null,
  }),
} satisfies DirectByokProvider;
