import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'neuralwatt',
  models_dev_id: 'neuralwatt',
  ...apiKeyUpstream({
    apiUrl: 'https://api.neuralwatt.com/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'neuralwatt',
    recommendedModels: [
      {
        id: 'moonshotai/Kimi-K2.6',
        name: 'Kimi-K2.6',
        flags: ['reasoning'],
        context_length: 262144,
        max_completion_tokens: 32000,
      },
    ],
  }),
  provider_listing: {
    dataPolicy: {
      training: false,
      retainsPrompts: true,
      canPublish: false,
      termsOfServiceURL: 'https://neuralwatt.com/terms',
      privacyPolicyURL: 'https://neuralwatt.com/privacy',
    },
    icon: faviconIcon('https://neuralwatt.com/'),
  },
} satisfies DirectByokProvider;
