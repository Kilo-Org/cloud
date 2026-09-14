import { getEnvVariable } from '@/lib/dotenvx';
import type { Provider } from '@/lib/ai-gateway/providers/types';

export const OPENROUTER = {
  id: 'openrouter',
  apiUrl: 'https://openrouter.ai/api/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('OPENROUTER_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions', 'messages', 'responses'],
  responseTransforms: null,
  async transformRequest() {},
} as const satisfies Provider;
