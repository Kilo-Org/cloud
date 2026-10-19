import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { randomUUID } from 'node:crypto';
import { generateProviderSpecificSessionHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'opencode-go',
  base_url: 'https://opencode.ai/zen/go/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions', 'messages', 'responses'],
  reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
  transformRequest(context) {
    context.extraHeaders['x-opencode-session'] = generateProviderSpecificSessionHash(
      context.kilo_user_id,
      context.session_id ?? randomUUID(),
      context.provider
    );
    if (context.request.kind === 'messages') {
      context.extraHeaders['x-api-key'] = context.provider.apiKey;
    }
    if (context.request.kind === 'chat_completions') {
      delete context.request.body.prompt_cache_key;
      delete context.request.body.safety_identifier;
      delete context.request.body.user;
    }
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'opencode-go',
    recommendedModels: [
      {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7 Plus',
        flags: ['vision', 'reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 65_536,
      },
    ],
  }),
  provider_listing: {
    dataPolicy: {
      training: true,
      retainsPrompts: true,
      canPublish: false,
      termsOfServiceURL: 'https://opencode.ai/legal/terms-of-service',
      privacyPolicyURL: 'https://opencode.ai/legal/privacy-policy',
    },
    icon: faviconIcon('https://opencode.ai/'),
  },
} satisfies DirectByokProvider;
