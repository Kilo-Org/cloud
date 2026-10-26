import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'orcarouter',
  models_dev_id: 'orcarouter',
  resolveUpstream: apiKeyUpstream({
    apiUrl: 'https://api.orcarouter.ai/v1',
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'orcarouter',
    recommendedModels: [
      {
        id: 'kimi/kimi-k2.6',
        name: 'kimi-k2.6',
        flags: ['vision', 'reasoning'],
        context_length: 262144,
        max_completion_tokens: 65535,
      },
    ],
  }),
  provider_listing: {
    dataPolicy: {
      training: true,
      retainsPrompts: true,
      canPublish: false,
      termsOfServiceURL: 'https://www.orcarouter.ai/terms.html',
      privacyPolicyURL: 'https://www.orcarouter.ai/privacy.html',
    },
    icon: faviconIcon('https://www.orcarouter.ai/'),
  },
} satisfies DirectByokProvider;
