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
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        flags: ['reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 384_000,
      },
      {
        id: 'gemma-4-26b-a4b-it',
        name: 'Gemma 4 26B A4B',
        context_length: 256_000,
        max_completion_tokens: 25_600,
      },
      {
        id: 'glm-5',
        name: 'GLM-5',
        context_length: 202_752,
        max_completion_tokens: 20_275,
      },
      {
        id: 'glm-5.1',
        name: 'GLM-5.1',
        flags: ['reasoning'],
        context_length: 202_800,
        max_completion_tokens: 131_072,
      },
      {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        flags: ['reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 128_000,
      },
      {
        id: 'gpt-oss-120b',
        name: 'gpt-oss-120b',
        flags: ['reasoning'],
        context_length: 131_072,
        max_completion_tokens: 13_107,
      },
      {
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        context_length: 262_144,
        max_completion_tokens: 26_214,
      },
      {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        flags: ['vision', 'reasoning'],
        context_length: 262_000,
        max_completion_tokens: 262_000,
      },
      {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        flags: ['vision'],
        context_length: 256_000,
        max_completion_tokens: 16_000,
      },
      {
        id: 'kimi-k3',
        name: 'Kimi K3',
        flags: ['vision'],
        context_length: 1_048_576,
        max_completion_tokens: 131_072,
      },
      {
        id: 'llama-3.3-70b-instruct',
        name: 'Llama 3.3 70B Instruct',
        context_length: 128_000,
        max_completion_tokens: 12_800,
      },
      {
        id: 'llama-4-maverick-17b-128e-instruct-fp8',
        name: 'Llama 4 Maverick 17B 128E Instruct FP8',
        context_length: 430_000,
        max_completion_tokens: 43_000,
      },
      {
        id: 'minimax-m2.7',
        name: 'MiniMax M2.7',
        context_length: 204_800,
        max_completion_tokens: 20_480,
      },
      {
        id: 'qwen3.6-flash',
        name: 'Qwen3.6-Flash',
        flags: ['vision', 'reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
      },
      {
        id: 'qwen3.6-max',
        name: 'Qwen3.6-Max',
        flags: ['reasoning'],
        context_length: 256_000,
        max_completion_tokens: 64_000,
      },
      {
        id: 'qwen3.6-plus',
        name: 'Qwen3.6-Plus',
        flags: ['vision', 'reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
      },
      {
        id: 'qwen3.7-flash',
        name: 'Qwen3.7-Flash',
        flags: ['vision', 'reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
      },
      {
        id: 'qwen3.7-max',
        name: 'Qwen3.7-Max',
        flags: ['reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
      },
      {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7-Plus',
        flags: ['vision', 'reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 64_000,
      },
      {
        id: 'qwen3-coder-480b-a35b-instruct-int4-mixed-ar',
        name: 'Qwen3 Coder 480B A35B Instruct INT4 Mixed AR',
        context_length: 106_000,
        max_completion_tokens: 10_600,
      },
      {
        id: 'qwen3-next-80b-a3b-instruct',
        name: 'Qwen3 Next 80B A3B Instruct',
        context_length: 262_144,
        max_completion_tokens: 26_214,
      },
    ],
  }),
} satisfies DirectByokProvider;
