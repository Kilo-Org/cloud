import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { replaceReasoningObjectWithReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'synthetic',
  base_url: 'https://api.synthetic.new/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions'],
  reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
  transformRequest(context) {
    replaceReasoningObjectWithReasoningEffort(context.request);
  },
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
