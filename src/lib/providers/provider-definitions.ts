import { getEnvVariable } from '@/lib/dotenvx';
import type { Provider } from '@/lib/providers/types';

export default {
  OPENROUTER: {
    id: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1',
    apiKey: getEnvVariable('OPENROUTER_API_KEY'),
  },
  ALIBABA: {
    id: 'alibaba',
    apiUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: getEnvVariable('ALIBABA_API_KEY'),
  },
  CORETHINK: {
    id: 'corethink',
    apiUrl: 'https://api.corethink.ai/v1/code',
    apiKey: getEnvVariable('CORETHINK_API_KEY'),
  },
  MARTIAN: {
    id: 'martian',
    apiUrl: 'https://api.withmartian.com/v1',
    apiKey: getEnvVariable('MARTIAN_API_KEY'),
  },
  MISTRAL: {
    id: 'mistral',
    apiUrl: 'https://api.mistral.ai/v1',
    apiKey: getEnvVariable('MISTRAL_API_KEY'),
  },
  MORPH: {
    id: 'morph',
    apiUrl: 'https://api.morphllm.com/v1',
    apiKey: getEnvVariable('MORPH_API_KEY'),
  },
  VERCEL_AI_GATEWAY: {
    id: 'vercel',
    apiUrl: 'https://ai-gateway.vercel.sh/v1',
    apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
  },
} as const satisfies Record<string, Provider>;
