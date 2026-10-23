import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'orcarouter',
  base_url: 'https://api.orcarouter.ai/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions', 'messages', 'responses'],
  reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
  transformRequest(context) {
    const { request } = context;
    if (request.kind !== 'chat_completions') {
      return;
    }
    request.body.reasoning_effort ??= request.body.reasoning?.effort ?? undefined;
  },
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
