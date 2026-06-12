import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'orcarouter',
  base_url: 'https://api.orcarouter.ai/v1',
  supported_chat_apis: ['chat_completions', 'messages', 'responses'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    const { request } = context;
    if (request.kind !== 'chat_completions') {
      return;
    }
    request.body.reasoning_effort ??= request.body.reasoning?.effort ?? undefined;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'orcarouter',
    recommendedModels: [
      {
        id: 'kimi/kimi-k2.6',
        name: 'kimi-k2.6',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 65535,
      },
    ],
  }),
} satisfies DirectByokProvider;
