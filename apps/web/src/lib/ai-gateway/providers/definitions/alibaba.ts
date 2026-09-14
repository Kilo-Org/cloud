import { getEnvVariable } from '@/lib/dotenvx';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { Provider } from '@/lib/ai-gateway/providers/types';

export const ALIBABA = {
  id: 'alibaba',
  apiUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('ALIBABA_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: [
    'chat_completions',
    // 'responses', // supported, not tested
  ],
  responseTransforms: null,
  async transformRequest(context) {
    context.request.body.enable_thinking = !isReasoningExplicitlyDisabled(context.request);
  },
} as const satisfies Provider;
