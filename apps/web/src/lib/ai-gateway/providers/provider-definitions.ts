import { getEnvVariable } from '@/lib/dotenvx';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { applyVercelSettings } from '@/lib/ai-gateway/providers/vercel';

export default {
  OPENROUTER: {
    id: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1',
    apiKey: getEnvVariable('OPENROUTER_API_KEY'),
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    async transformRequest() {},
  },
  ALIBABA: {
    id: 'alibaba',
    apiUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: getEnvVariable('ALIBABA_API_KEY'),
    // Prompt caching is not supported on the responses API for Alibaba; enabling it is therefore dangerous.
    supportedChatApis: ['chat_completions' /*, 'responses'*/],
    async transformRequest(context) {
      context.request.body.enable_thinking = !isReasoningExplicitlyDisabled(context.request);
    },
  },
  SEED: {
    id: 'seed',
    apiUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    apiKey: getEnvVariable('BYTEDANCE_API_KEY'),
    // Prompt caching is not supported on the responses API for Bytedance; enabling it is therefore dangerous.
    supportedChatApis: ['chat_completions' /*, 'responses'*/],
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
  },
  MARTIAN: {
    id: 'martian',
    apiUrl: 'https://api.withmartian.com/v1',
    apiKey: getEnvVariable('MARTIAN_API_KEY'),
    supportedChatApis: ['chat_completions', 'responses', 'messages'],
    async transformRequest(context) {
      delete context.request.body.provider;
    },
  },
  MISTRAL: {
    id: 'mistral',
    apiUrl: 'https://api.mistral.ai/v1',
    apiKey: getEnvVariable('MISTRAL_API_KEY'),
    supportedChatApis: [],
    async transformRequest() {},
  },
  STREAMLAKE: {
    id: 'streamlake',
    apiUrl: 'https://vanchin.streamlake.ai/api/gateway/v1/endpoints',
    apiKey: getEnvVariable('STREAMLAKE_API_KEY'),
    supportedChatApis: ['chat_completions'],
    async transformRequest(context) {
      delete context.request.body.provider;
    },
  },
  VERCEL_AI_GATEWAY: {
    id: 'vercel',
    apiUrl: 'https://ai-gateway.vercel.sh/v1',
    apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    async transformRequest(context) {
      await applyVercelSettings(context.model, context.request, context.userByok);
    },
  },
} as const satisfies Record<string, Provider>;
