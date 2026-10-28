import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';

export default {
  id: 'xiaomi-token-plan-ams',
  models_dev_id: 'xiaomi-token-plan-ams',
  resolveUpstream: apiKeyUpstream({
    apiUrl: 'https://token-plan-ams.xiaomimimo.com/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'xiaomi-token-plan-ams',
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
