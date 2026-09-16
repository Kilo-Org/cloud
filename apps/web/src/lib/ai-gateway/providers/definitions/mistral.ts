import { getEnvVariable } from '@/lib/dotenvx';
import type { Provider } from '@/lib/ai-gateway/providers/types';

export const MISTRAL = {
  id: 'mistral',
  apiUrl: 'https://api.mistral.ai/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('MISTRAL_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: [],
  responseTransforms: null,
  async transformRequest() {},
} as const satisfies Provider;
