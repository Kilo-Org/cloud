import { COMPATIBLE_USER_AGENT, type DirectByokProvider } from '@/lib/providers/direct-byok/types';
import { REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH } from '@/lib/providers/model-settings';
import { isReasoningExplicitlyDisabled } from '@/lib/providers/openrouter/request-helpers';

export default {
  id: 'kimi-coding',
  name: 'Kimi Code',
  base_url: 'https://api.kimi.com/coding/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    context.request.body.thinking = {
      type: isReasoningExplicitlyDisabled(context.request) ? 'disabled' : 'enabled',
    };
    context.extraHeaders['user-agent'] = COMPATIBLE_USER_AGENT;
  },
  models: [
    {
      id: 'kimi-for-coding',
      name: 'Kimi for Coding',
      flags: ['recommended', 'vision'],
      context_length: 262144,
      max_completion_tokens: 32768,
      description:
        'Kimi Code is a premium subscription tier within the Kimi ecosystem, specifically engineered to empower developers with advanced AI capabilities for coding.',
      variants: REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH,
    },
  ],
} satisfies DirectByokProvider;
