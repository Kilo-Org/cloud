import { cachedEnhancedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'gmicloud-byok',
  base_url: 'https://api.gmi-serving.com/v1',
  base_url_overrides: {},
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    const { request } = context;
    if (request.kind !== 'chat_completions') {
      return;
    }
    request.body.reasoning_effort ??= request.body.reasoning?.effort ?? undefined;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'gmicloud-byok',
    recommendedModels: [
      {
        id: 'zai-org/GLM-5.2-FP8',
        name: 'GLM-5.2',
        flags: ['reasoning'],
        context_length: 1000000,
        max_completion_tokens: 131072,
      },
      {
        id: 'deepseek-ai/DeepSeek-V4-Pro',
        name: 'DeepSeek V4 Pro',
        flags: ['reasoning'],
        context_length: 1048576,
        max_completion_tokens: 384000,
      },
      {
        id: 'MiniMaxAI/MiniMax-M3',
        name: 'MiniMax-M3',
        flags: ['vision', 'reasoning'],
        context_length: 1048576,
        max_completion_tokens: 512000,
      },
    ],
  }),
} satisfies DirectByokProvider;
