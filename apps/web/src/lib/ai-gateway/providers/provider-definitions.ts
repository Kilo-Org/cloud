import { getEnvVariable } from '@/lib/dotenvx';
import {
  addCacheBreakpoints,
  isReasoningExplicitlyDisabled,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { applyVercelSettings } from '@/lib/ai-gateway/providers/vercel';

export default {
  OPENROUTER: {
    id: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1',
    apiKey: getEnvVariable('OPENROUTER_API_KEY'),
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    transformRequest() {},
  },
  ALIBABA: {
    id: 'alibaba',
    apiUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: getEnvVariable('ALIBABA_API_KEY'),
    supportedChatApis: ['chat_completions', 'responses'],
    transformRequest(context) {
      context.request.body.enable_thinking = !isReasoningExplicitlyDisabled(context.request);
      addCacheBreakpoints(context.request);
    },
  },
  BYTEDANCE: {
    id: 'bytedance',
    apiUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    apiKey: getEnvVariable('BYTEDANCE_API_KEY'),
    supportedChatApis: ['chat_completions', 'responses'],
    transformRequest(context) {
      if (context.request.kind === 'chat_completions' || context.request.kind === 'responses') {
        context.request.body.thinking = { type: 'enabled' };
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
    supportedChatApis: [
      'chat_completions', // through our custom wrapper
      'responses',
    ],
    transformRequest(context) {
      if (context.request.kind === 'chat_completions') {
        delete context.request.body.reasoning;
      }
    },
  },
  MISTRAL: {
    id: 'mistral',
    apiUrl: 'https://api.mistral.ai/v1',
    apiKey: getEnvVariable('MISTRAL_API_KEY'),
    supportedChatApis: [],
    transformRequest() {},
  },
  MORPH: {
    id: 'morph',
    apiUrl: 'https://api.morphllm.com/v1',
    apiKey: getEnvVariable('MORPH_API_KEY'),
    supportedChatApis: ['chat_completions'],
    transformRequest() {},
  },
  VERCEL_AI_GATEWAY: {
    id: 'vercel',
    apiUrl: 'https://ai-gateway.vercel.sh/v1',
    apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    transformRequest(context) {
      applyVercelSettings(context.model, context.request, context.userByok);
    },
  },
} as const satisfies Record<string, Provider>;
