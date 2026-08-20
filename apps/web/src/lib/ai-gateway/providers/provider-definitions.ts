import { getEnvVariable } from '@/lib/dotenvx';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { Provider, ProviderId } from '@/lib/ai-gateway/providers/types';
import { applyVercelSettings } from '@/lib/ai-gateway/providers/vercel';

export const OPENROUTER = {
  id: 'openrouter',
  apiUrl: 'https://openrouter.ai/api/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('OPENROUTER_API_KEY'),
  supportedChatApis: ['chat_completions', 'messages', 'responses'],
  responseTransforms: null,
  async transformRequest() {},
} as const satisfies Provider;

export const ALIBABA = {
  id: 'alibaba',
  apiUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('ALIBABA_API_KEY'),
  supportedChatApis: [
    'chat_completions',
    // 'responses', // supported, not tested
  ],
  responseTransforms: null,
  async transformRequest(context) {
    context.request.body.enable_thinking = !isReasoningExplicitlyDisabled(context.request);
  },
} as const satisfies Provider;

export const SEED = {
  id: 'seed',
  apiUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('BYTEDANCE_API_KEY'),
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

export const LONGCAT = {
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
    if (context.request.body.user) {
      context.extraHeaders['Mt-User-Id'] = context.request.body.user;
    }
  },
} as const satisfies Provider;

export const MARTIAN = {
  id: 'martian',
  apiUrl: 'https://api.withmartian.com/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('MARTIAN_API_KEY'),
  supportedChatApis: ['chat_completions', 'responses', 'messages'],
  responseTransforms: null,
  async transformRequest(context) {
    delete context.request.body.provider;
  },
} as const satisfies Provider;

export const MISTRAL = {
  id: 'mistral',
  apiUrl: 'https://api.mistral.ai/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('MISTRAL_API_KEY'),
  supportedChatApis: [],
  responseTransforms: null,
  async transformRequest() {},
} as const satisfies Provider;

export const STREAMLAKE = {
  id: 'streamlake',
  apiUrl: 'https://vanchin.streamlake.ai/api/gateway/v1/endpoints',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('STREAMLAKE_API_KEY'),
  supportedChatApis: ['chat_completions'],
  responseTransforms: null,
  async transformRequest(context) {
    delete context.request.body.provider;
  },
} as const satisfies Provider;

export const VERCEL_AI_GATEWAY = {
  id: 'vercel',
  apiUrl: 'https://ai-gateway.vercel.sh/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
  supportedChatApis: ['chat_completions', 'messages', 'responses'],
  responseTransforms: null,
  async transformRequest(context) {
    await applyVercelSettings(context.model, context.request, context.userByok);
  },
} as const satisfies Provider;

export function getProviderById(providerId: ProviderId): Provider | undefined {
  switch (providerId) {
    case 'openrouter':
      return OPENROUTER;
    case 'alibaba':
      return ALIBABA;
    case 'seed':
      return SEED;
    case 'longcat':
      return LONGCAT;
    case 'martian':
      return MARTIAN;
    case 'mistral':
      return MISTRAL;
    case 'streamlake':
      return STREAMLAKE;
    case 'vercel':
      return VERCEL_AI_GATEWAY;
    default:
      return undefined;
  }
}
