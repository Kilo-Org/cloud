import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'synthetic',
  models_dev_id: 'synthetic',
  resolveUpstream: apiKeyUpstream({
    apiUrl: 'https://api.synthetic.new/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'synthetic',
    recommendedModels: [
      {
        id: 'hf:moonshotai/Kimi-K2.6',
        name: 'Kimi-K2.6',
        flags: ['vision', 'reasoning'],
        context_length: 262144,
        max_completion_tokens: 65535,
      },
    ],
  }),
  provider_listing: {
    dataPolicy: {
      training: false,
      retainsPrompts: false,
      canPublish: false,
      termsOfServiceURL: 'https://synthetic.new/policies/terms-of-service',
      privacyPolicyURL: 'https://synthetic.new/policies/privacy',
    },
    icon: faviconIcon('https://synthetic.new/'),
  },
} satisfies DirectByokProvider;
