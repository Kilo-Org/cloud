import { getEnvVariable } from '@/lib/dotenvx';
import {
  isReasoningExplicitlyDisabled,
  removeChatCompletionsToolNames,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { ReasoningDetailsTransform, type Provider } from '@/lib/ai-gateway/providers/types';

export const FRIENDLI_GLM_PROVIDER = {
  id: 'friendli',
  apiUrl: 'https://api.friendli.ai/serverless/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('FRIENDLI_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: [
    'chat_completions',
    // 'messages', // supported, not tested
    // 'responses', // supported, not tested
  ],
  responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  async transformRequest(context) {
    context.request.body.model = 'zai-org/GLM-5.2';
    delete context.request.body.provider;

    if (context.request.kind === 'chat_completions') {
      const requestBody = context.request.body;
      if (isReasoningExplicitlyDisabled(context.request)) {
        requestBody.chat_template_kwargs = { enable_thinking: false };
        delete requestBody.reasoning;
        delete requestBody.reasoning_effort;
      } else {
        requestBody.chat_template_kwargs = { enable_thinking: true };
        requestBody.reasoning_effort =
          requestBody.reasoning?.effort ?? requestBody.reasoning_effort ?? undefined;
        requestBody.parse_reasoning = true;
        requestBody.include_reasoning = true;
        delete requestBody.reasoning;
      }
    }
  },
} as const satisfies Provider;

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
