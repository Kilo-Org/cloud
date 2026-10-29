import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  isReasoningExplicitlyDisabled,
  replaceReasoningObjectWithReasoningEffort,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';

export default {
  id: 'zai-coding',
  models_dev_id: 'zai-coding-plan',
  ...apiKeyUpstream({
    apiUrl: 'https://api.z.ai/api/coding/paas/v4',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest(context) {
    context.request.body.thinking = {
      type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
    };
    replaceReasoningObjectWithReasoningEffort(context.request);
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'zai-coding',
    recommendedModels: [
      {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        flags: ['reasoning'],
        context_length: 1000000,
        max_completion_tokens: 131072,
      },
    ],
  }),
} satisfies DirectByokProvider;
