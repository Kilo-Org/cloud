import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'alibaba-token-plan',
  base_url: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions'],
  reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'alibaba-token-plan',
    recommendedModels: [
      {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7 Plus',
        flags: ['vision', 'reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
      },
    ],
  }),
} satisfies DirectByokProvider;
