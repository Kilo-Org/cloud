import { REASONING_VARIANTS_BINARY } from '@/lib/ai-gateway/providers/model-settings';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';

export default {
  id: 'zai-coding',
  base_url: 'https://api.z.ai/api/coding/paas/v4',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    context.request.body.thinking = {
      type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
    };
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'zai-coding',
    recommendedModels: [
      {
        id: 'glm-5.1',
        name: 'GLM-5.1',
        description:
          'GLM-5.1 delivers a major leap in coding capability, with particularly significant gains in handling long-horizon tasks. Unlike previous models built around minute-level interactions, GLM-5.1 can work independently and continuously on a single task for more than 8 hours—autonomously planning, executing, and improving itself throughout the process—ultimately delivering complete, engineering-grade results.',
        flags: [],
        context_length: 200000,
        max_completion_tokens: 131072,
        variants: null,
      },
    ],
    variants: REASONING_VARIANTS_BINARY,
  }),
} satisfies DirectByokProvider;
