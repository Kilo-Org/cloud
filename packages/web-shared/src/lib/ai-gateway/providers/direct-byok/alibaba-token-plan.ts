import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'alibaba-token-plan',
  openrouter_inference_provider_id: 'alibaba',
  models_dev_id: 'alibaba-token-plan',
  ...apiKeyUpstream({
    apiUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest() {},
  models: cachedDirectByokModelList('alibaba-token-plan'),
} satisfies DirectByokProvider;
