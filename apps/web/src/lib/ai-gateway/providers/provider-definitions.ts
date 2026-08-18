import { getEnvVariable } from '@/lib/dotenvx';
import {
  isReasoningExplicitlyDisabled,
  removeChatCompletionsToolNames,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { applyVercelSettings } from '@/lib/ai-gateway/providers/vercel';

export default {
  OPENROUTER: {
    id: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('OPENROUTER_API_KEY'),
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    responseTransforms: null,
    async transformRequest() {},
  },
  ALIBABA: {
    id: 'alibaba',
    apiUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('ALIBABA_API_KEY'),
    supportedChatApis: ['chat_completions', 'responses'],
    responseTransforms: null,
    async transformRequest(context) {
      context.request.body.enable_thinking = !isReasoningExplicitlyDisabled(context.request);
    },
  },
  SEED: {
    id: 'seed',
    apiUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('BYTEDANCE_API_KEY'),
    supportedChatApis: ['chat_completions', 'responses'],
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
  },
  LONGCAT: {
    id: 'longcat',
    apiUrl: 'https://api.longcat.ai/openai/v1',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('LONGCAT_API_KEY'),
    supportedChatApis: ['chat_completions'],
    responseTransforms: null,
    async transformRequest(context) {
      context.request.body.thinking = {
        type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
      };
      delete context.request.body.provider;
    },
  },
  MARTIAN: {
    id: 'martian',
    apiUrl: 'https://api.withmartian.com/v1',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('MARTIAN_API_KEY'),
    supportedChatApis: ['chat_completions', 'responses', 'messages'],
    responseTransforms: null,
    async transformRequest(context) {
      delete context.request.body.provider;
    },
  },
  MISTRAL: {
    id: 'mistral',
    apiUrl: 'https://api.mistral.ai/v1',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('MISTRAL_API_KEY'),
    supportedChatApis: [],
    responseTransforms: null,
    async transformRequest() {},
  },
  FRIENDLI_GLM: {
    id: 'friendli',
    apiUrl: 'https://api.friendli.ai/serverless/v1',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('FRIENDLI_API_KEY'),
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    responseTransforms: { mapGeminiThoughtContent: false, mapReasoningContentToDetails: true },
    async transformRequest(context) {
      context.request.body.model = 'zai-org/GLM-5.2';
      if (context.request.kind === 'chat_completions') {
        context.request.body.reasoning_effort = isReasoningExplicitlyDisabled(context.request)
          ? 'none'
          : (context.request.body.reasoning?.effort ??
            context.request.body.reasoning_effort ??
            undefined);
        delete context.request.body.reasoning;
      }
      delete context.request.body.provider;
    },
  },
  PERPLEXITY_KIMI: {
    id: 'perplexity',
    apiUrl: 'https://api.perplexity.ai/router/v1',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('PERPLEXITY_API_KEY'),
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    responseTransforms: { mapGeminiThoughtContent: false, mapReasoningContentToDetails: true },
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
  },
  STREAMLAKE: {
    id: 'streamlake',
    apiUrl: 'https://vanchin.streamlake.ai/api/gateway/v1/endpoints',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('STREAMLAKE_API_KEY'),
    supportedChatApis: ['chat_completions'],
    responseTransforms: null,
    async transformRequest(context) {
      delete context.request.body.provider;
    },
  },
  VERCEL_AI_GATEWAY: {
    id: 'vercel',
    apiUrl: 'https://ai-gateway.vercel.sh/v1',
    apiUrlOverrides: {},
    apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    responseTransforms: null,
    async transformRequest(context) {
      await applyVercelSettings(context.model, context.request, context.userByok);
    },
  },
} as const satisfies Record<string, Provider>;
