import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';

export default {
  id: 'zai-coding',
  base_url: 'https://api.z.ai/api/coding/paas/v4',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    context.request.body.thinking = {
      type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
    };
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'zai-coding',
    recommendedModels: [
      {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        context_length: 1000000,
        max_completion_tokens: 131072,
      },
    ],
  }),
} satisfies DirectByokProvider;
