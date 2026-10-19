import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'ollama-cloud',
  base_url: 'https://ollama.com/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions'],
  reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
  transformRequest(context) {
    const { request } = context;
    if (request.kind !== 'chat_completions') {
      return;
    }
    request.body.reasoning_effort ??= request.body.reasoning?.effort ?? undefined;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'ollama-cloud',
    recommendedModels: [
      {
        id: 'kimi-k2.6:cloud',
        name: 'kimi-k2.6',
        flags: ['vision', 'reasoning'],
        context_length: 262144,
        max_completion_tokens: 262144,
      },
    ],
  }),
  provider_listing: {
    dataPolicy: {
      training: false,
      retainsPrompts: false,
      canPublish: false,
      termsOfServiceURL: 'https://ollama.com/terms',
      privacyPolicyURL: 'https://ollama.com/privacy',
    },
    icon: faviconIcon('https://ollama.com/'),
  },
} satisfies DirectByokProvider;
