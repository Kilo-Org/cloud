import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'chutes-byok',
  openrouter_inference_provider_id: 'chutes',
  models_dev_id: 'chutes',
  ...apiKeyUpstream({
    apiUrl: 'https://llm.chutes.ai/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest() {},
  models: cachedDirectByokModelList('chutes-byok'),
} satisfies DirectByokProvider;
