import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { replaceReasoningObjectWithReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import type { DirectByokProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';

export default {
  id: 'xiaomi-token-plan-sgp',
  base_url: 'https://token-plan-sgp.xiaomimimo.com/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions'],
  reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
  transformRequest(context) {
    replaceReasoningObjectWithReasoningEffort(context.request);
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'xiaomi-token-plan-sgp',
    recommendedModels: [
      {
        id: 'mimo-v2.5-pro',
        name: 'MiMo-V2.5-Pro',
        flags: ['reasoning'],
        context_length: 1048576,
        max_completion_tokens: 131072,
      },
    ],
  }),
} satisfies DirectByokProvider;
