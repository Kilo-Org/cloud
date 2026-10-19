import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { replaceReasoningObjectWithReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'edenai',
  base_url: 'https://api.edenai.run/v3',
  base_url_overrides: { messages: 'https://api.edenai.run/v3/v1' },
  supported_chat_apis: ['chat_completions', 'messages', 'responses'],
  reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
  transformRequest(context) {
    replaceReasoningObjectWithReasoningEffort(context.request, { disableWithNoneEffort: true });
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'edenai',
    recommendedModels: [
      {
        id: 'openai/gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        flags: ['vision', 'reasoning'],
        context_length: 1_050_000,
        max_completion_tokens: 128_000,
      },
    ],
  }),
  provider_listing: {
    dataPolicy: {
      training: true,
      retainsPrompts: true,
      canPublish: false,
      termsOfServiceURL: 'https://www.edenai.co/terms',
      privacyPolicyURL: 'https://www.edenai.co/privacy',
    },
    icon: faviconIcon('https://www.edenai.co/'),
  },
} satisfies DirectByokProvider;
