import { getEnvVariable } from '@/lib/dotenvx';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { Provider } from '@/lib/ai-gateway/providers/types';

export const SEED = {
  id: 'seed',
  apiUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('BYTEDANCE_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: [
    'chat_completions',
    // 'responses', // supported, not tested
  ],
  responseTransforms: null,
  async transformRequest(context) {
    if (!isReasoningExplicitlyDisabled(context.request)) {
      context.request.body.thinking = { type: 'enabled' };
      if (context.request.kind === 'chat_completions') {
        context.request.body.reasoning_effort ??= context.request.body.reasoning?.effort;
      }
    } else {
      context.request.body.thinking = { type: 'disabled' };
    }
    if (context.request.kind === 'responses') {
      delete context.request.body.prompt_cache_key;
      delete context.request.body.safety_identifier;
      delete context.request.body.user;
      delete context.request.body.provider;
    }
  },
} as const satisfies Provider;
