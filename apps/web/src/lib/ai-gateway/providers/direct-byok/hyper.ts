import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'hyper',
  base_url: 'https://hyper.charm.land/v1',
  supported_chat_apis: ['chat_completions', 'messages'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    if (context.request.kind === 'messages') {
      context.extraHeaders['x-api-key'] = context.provider.apiKey;
      return;
    }
    if (context.request.kind !== 'chat_completions') {
      return;
    }
    context.request.body.reasoning_effort ??= context.request.body.reasoning?.effort ?? undefined;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'hyper',
    recommendedModels: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        flags: ['reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 384_000,
      },
      {
        id: 'qwen3.7-flash',
        name: 'Qwen3.7 Flash',
        flags: ['vision'],
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
      },
      {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7 Plus',
        flags: ['vision'],
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
      },
      {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        flags: ['reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 128_000,
      },
      {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        flags: ['vision', 'reasoning'],
        context_length: 262_000,
        max_completion_tokens: 262_000,
      },
    ],
  }),
} satisfies DirectByokProvider;
