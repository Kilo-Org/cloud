import { getEnvVariable } from '@/lib/dotenvx';
import type { Provider } from '@/lib/ai-gateway/providers/types';

/**
 * Self-contained OpenRouter provider definition. Kept in a leaf module so
 * importers that only need `OPENROUTER` (for example the local fake LLM) do
 * not pull the rest of the provider graph into a circular dependency.
 */
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
