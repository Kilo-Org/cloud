import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'edenai',
  base_url: 'https://api.edenai.run/v3',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    const { request } = context;
    if (request.kind !== 'chat_completions') {
      return;
    }
    request.body.reasoning_effort ??= request.body.reasoning?.effort ?? undefined;
    delete request.body.reasoning;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'edenai',
    recommendedModels: [
      {
        id: 'openai/gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        flags: ['vision', 'reasoning'],
        context_length: 1_050_000,
        max_completion_tokens: 128_000,
      },
    ],
  }),
} satisfies DirectByokProvider;
