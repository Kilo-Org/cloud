import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { applyThinkingToggleAndReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/request-helpers';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';

const id = 'zai-coding';

export default {
  id,
  openrouter_inference_provider_id: 'z-ai',
  models_dev_id: 'zai-coding-plan',
  ...apiKeyUpstream({
    apiUrl: 'https://api.z.ai/api/coding/paas/v4',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest(context) {
    applyThinkingToggleAndReasoningEffort(context.request);
  },
  models: cachedDirectByokModelList(id),
} satisfies DirectByokProvider;
