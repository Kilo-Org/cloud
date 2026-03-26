import { getEnvVariable } from '@/lib/dotenvx';
import {
  addCacheBreakpoints,
  removeChatCompletionsReasoning,
  scrubOpenCodeSpecificProperties,
} from '@/lib/providers/openrouter/request-helpers';
import type { Provider } from '@/lib/providers/types';
import { applyVercelSettings } from '@/lib/providers/vercel';

export default {
  OPENROUTER: {
    id: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1',
    apiKey: getEnvVariable('OPENROUTER_API_KEY'),
    transformRequest() {},
  },
  ALIBABA: {
    id: 'alibaba',
    apiUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: getEnvVariable('ALIBABA_API_KEY'),
    transformRequest(context) {
      if (context.request.kind === 'chat_completions' || context.request.kind === 'responses') {
        context.request.body.enable_thinking = true;
      }
      addCacheBreakpoints(context.request);
    },
  },
  BYTEDANCE: {
    id: 'bytedance',
    apiUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    apiKey: getEnvVariable('BYTEDANCE_API_KEY'),
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
  CORETHINK: {
    id: 'corethink',
    apiUrl: 'https://api.corethink.ai/v1/code',
    apiKey: getEnvVariable('CORETHINK_API_KEY'),
    transformRequest(context) {
      if (context.request.kind !== 'chat_completions') {
        return;
      }
      delete context.request.body.transforms;
      delete context.request.body.prompt_cache_key;
      delete context.request.body.safety_identifier;
      scrubOpenCodeSpecificProperties(context.request.body);
      removeChatCompletionsReasoning(context.request.body);
    },
  },
  MARTIAN: {
    id: 'martian',
    apiUrl: 'https://api.withmartian.com/v1',
    apiKey: getEnvVariable('MARTIAN_API_KEY'),
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
    transformRequest() {},
  },
  MORPH: {
    id: 'morph',
    apiUrl: 'https://api.morphllm.com/v1',
    apiKey: getEnvVariable('MORPH_API_KEY'),
    transformRequest() {},
  },
  VERCEL_AI_GATEWAY: {
    id: 'vercel',
    apiUrl: 'https://ai-gateway.vercel.sh/v1',
    apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
    transformRequest(context) {
      applyVercelSettings(context.model, context.request, context.userByok);
    },
  },
} as const satisfies Record<string, Provider>;
