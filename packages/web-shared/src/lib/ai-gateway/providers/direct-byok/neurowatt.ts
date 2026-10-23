import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { replaceReasoningObjectWithReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'neuralwatt',
  base_url: 'https://api.neuralwatt.com/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions'],
  reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
  transformRequest(context) {
    replaceReasoningObjectWithReasoningEffort(context.request);
  },
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
