import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';

export default {
  id: 'xiaomi-token-plan-sgp',
  openrouter_inference_provider_id: 'xiaomi',
  models_dev_id: 'xiaomi-token-plan-sgp',
  ...apiKeyUpstream({
    apiUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest() {},
  models: cachedDirectByokModelList('xiaomi-token-plan-sgp'),
} satisfies DirectByokProvider;
