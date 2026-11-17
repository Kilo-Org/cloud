import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { randomUUID } from 'node:crypto';
import { generateProviderSpecificSessionHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  credentialHeaders,
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { removeChatCompletionsMessageNames } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { isMinimaxModel } from '@kilocode/web-shared/lib/ai-gateway/providers/minimax';
import { isQwenModel } from '@kilocode/web-shared/lib/ai-gateway/providers/qwen';

const SESSION_HEADER = 'x-opencode-session';

function sessionHeaders(session: string): Record<string, string> {
  return { [SESSION_HEADER]: session };
}

export default {
  id: 'opencode-go',
  models_dev_id: 'opencode-go',
  ...apiKeyUpstream({
    apiUrl: 'https://opencode.ai/zen/go/v1',
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest(context) {
    Object.assign(
      context.extraHeaders,
      sessionHeaders(
        generateProviderSpecificSessionHash(
          context.kilo_user_id,
          context.session_id ?? randomUUID(),
          context.provider
        )
      )
    );
    if (context.request.kind === 'messages') {
      context.extraHeaders['x-api-key'] = context.provider.apiKey;
    }
    if (context.request.kind === 'chat_completions') {
      delete context.request.body.prompt_cache_key;
      delete context.request.body.safety_identifier;
      delete context.request.body.user;
      removeChatCompletionsMessageNames(context.request.body);
    }
  },
  chatCompletionsHeaders(upstream) {
    return { ...credentialHeaders(upstream), ...sessionHeaders(randomUUID()) };
  },
  getAiSdkProvider(model) {
    return isMinimaxModel(model) || isQwenModel(model) ? { aiSdkProvider: 'anthropic' } : null;
  },
  models: cachedDirectByokModelList('opencode-go'),
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
