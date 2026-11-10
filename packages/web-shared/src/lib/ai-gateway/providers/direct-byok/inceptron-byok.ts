import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'inceptron-byok',
  openrouter_inference_provider_id: 'inceptron',
  models_dev_id: 'inceptron',
  ...apiKeyUpstream({
    apiUrl: 'https://api.inceptron.io/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest() {},
  models: cachedDirectByokModelList('inceptron-byok'),
} satisfies DirectByokProvider;
