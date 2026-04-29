import { REASONING_VARIANTS_BINARY } from '@/lib/ai-gateway/providers/model-settings';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import {
  cacheDirectByokModelList,
  enhanceDirectByokModelList,
} from '@/lib/ai-gateway/providers/direct-byok/model-list';

const cachedModels = cacheDirectByokModelList('zai-coding');
export default {
  id: 'zai-coding',
  name: 'Z.ai Coding Plan',
  base_url: 'https://api.z.ai/api/coding/paas/v4',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    context.request.body.thinking = {
      type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
    };
  },

  models: (async () =>
    enhanceDirectByokModelList({
      recommendedModels: [
        {
          id: 'moonshotai/Kimi-K2.6',
          name: 'moonshotai/Kimi-K2.6',
          description:
            'Kimi K2.6 demonstrates particularly strong performance in long-horizon coding tasks and produces professional-grade design with code and vision.',
          flags: [],
          context_length: 262144,
          max_completion_tokens: 32000,
          variants: null,
        },
      ],
      remainingModels: await cachedModels(),
      variants: REASONING_VARIANTS_BINARY,
    }))(),
} satisfies DirectByokProvider;
