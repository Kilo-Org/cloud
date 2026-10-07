import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

export const VERCEL_AI_GATEWAY = {
  id: 'vercel',
  apiUrl: 'https://ai-gateway.vercel.sh/v1',
  apiUrlOverrides: {},
  disableUrlSuffix: false,
  apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions', 'messages', 'responses'],
  responseTransforms: null,
  transformRequest() {},
} as const satisfies Provider;
