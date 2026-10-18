import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { replaceReasoningObjectWithReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'ollama-cloud',
  base_url: 'https://ollama.com/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions'],
  reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
  transformRequest(context) {
    replaceReasoningObjectWithReasoningEffort(context.request);
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'ollama-cloud',
    recommendedModels: [
      {
        id: 'kimi-k2.6:cloud',
        name: 'kimi-k2.6',
        flags: ['vision', 'reasoning'],
        context_length: 262144,
        max_completion_tokens: 262144,
      },
    ],
  }),
} satisfies DirectByokProvider;
