import { REASONING_VARIANTS_BINARY } from '@/lib/ai-gateway/providers/model-settings';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';

export default {
  id: 'xiaomi-token-plan-ams',
  base_url: 'https://token-plan-ams.xiaomimimo.com/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'xiaomi-token-plan-ams',
    recommendedModels: [
      {
        id: 'mimo-v2.5-pro',
        name: 'MiMo-V2.5-Pro',
        context_length: 1048576,
        max_completion_tokens: 131072,
      },
    ],
    variants: REASONING_VARIANTS_BINARY,
  }),
} satisfies DirectByokProvider;
