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
    // Seed/flagship picks only — full catalog comes from models.dev filtered by
    // https://hyper.charm.land/v1/models during sync.
    recommendedModels: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        flags: ['reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 384_000,
      },
      {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        flags: ['reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 128_000,
      },
      {
        id: 'kimi-k3',
        name: 'Kimi K3',
        flags: ['vision'],
        context_length: 1_048_576,
        max_completion_tokens: 131_072,
      },
      {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7-Plus',
        flags: ['vision', 'reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
      },
      {
        id: 'minimax-m2.7',
        name: 'MiniMax M2.7',
        context_length: 204_800,
        max_completion_tokens: 20_480,
      },
    ],
  }),
} satisfies DirectByokProvider;
