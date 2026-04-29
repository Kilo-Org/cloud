import {
  COMPATIBLE_USER_AGENT,
  type DirectByokProvider,
} from '@/lib/ai-gateway/providers/direct-byok/types';
import { REASONING_VARIANTS_MINIMAL_LOW_MEDIUM_HIGH } from '@/lib/ai-gateway/providers/model-settings';
import { isReasoningExplicitlyDisabled } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import { isRooCodeBasedClient } from '@/lib/utils';

export default {
  id: 'kimi-coding',
  base_url: 'https://api.kimi.com/coding/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    const reasoningDisabled =
      isRooCodeBasedClient(context.originalHeaders) ||
      isReasoningExplicitlyDisabled(context.request);
    context.request.body.thinking = {
      type: reasoningDisabled ? 'disabled' : 'enabled',
    };
    context.extraHeaders['user-agent'] = COMPATIBLE_USER_AGENT;
  },
  models: () =>
    Promise.resolve([
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
    ]),
} satisfies DirectByokProvider;
