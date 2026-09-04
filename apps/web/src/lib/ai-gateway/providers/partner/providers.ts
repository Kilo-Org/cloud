import { getEnvVariable } from '@/lib/dotenvx';
import {
  isReasoningExplicitlyDisabled,
  removeChatCompletionsToolNames,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { ReasoningDetailsTransform, type Provider } from '@/lib/ai-gateway/providers/types';

export const PERPLEXITY_KIMI_PROVIDER = {
  id: 'perplexity',
  apiUrl: 'https://api.perplexity.ai/router/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('PERPLEXITY_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: [
    'chat_completions',
    // 'messages', // supported, not tested
    // 'responses', // supported, not tested
  ],
  responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  async transformRequest(context) {
    context.request.body.model = 'perplexity/kimi-k3';
    if (context.request.kind === 'chat_completions') {
      context.request.body.reasoning_effort = isReasoningExplicitlyDisabled(context.request)
        ? 'none'
        : (context.request.body.reasoning?.effort ??
          context.request.body.reasoning_effort ??
          undefined);
      delete context.request.body.reasoning;
      removeChatCompletionsToolNames(context.request.body);
    }
    delete context.request.body.provider;
    delete context.request.body.user;
  },
} as const satisfies Provider;
