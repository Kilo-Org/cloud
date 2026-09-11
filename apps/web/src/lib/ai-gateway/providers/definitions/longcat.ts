import { getEnvVariable } from '@/lib/dotenvx';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { ReasoningDetailsTransform, type Provider } from '@/lib/ai-gateway/providers/types';

export const LONGCAT = {
  id: 'longcat',
  apiUrl: 'https://api.longcat.ai/openai/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('LONGCAT_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions'],
  responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  async transformRequest(context) {
    context.request.body.thinking = {
      type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
    };
    delete context.request.body.provider;
    if (context.request.body.user) {
      context.extraHeaders['Mt-User-Id'] = context.request.body.user;
    }
  },
} as const satisfies Provider;
