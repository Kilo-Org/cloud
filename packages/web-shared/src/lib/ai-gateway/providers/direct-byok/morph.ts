import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'morph-byok',
  openrouter_inference_provider_id: 'morph',
  models_dev_id: 'morph',
  ...apiKeyUpstream({
    apiUrl: 'https://api.morphllm.com/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest() {},
  models: cachedDirectByokModelList('morph-byok'),
} satisfies DirectByokProvider;
