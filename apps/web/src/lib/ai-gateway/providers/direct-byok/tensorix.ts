import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'tensorix',
  base_url: 'https://api.tensorix.ai/v1',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  force_ai_sdk_provider: 'openai-compatible',
  transformRequest(_context) {},
  models: () =>
    Promise.resolve([
      {
        id: 'z-ai/glm-5.1',
        name: 'GLM-5.1',
        flags: ['recommended'],
        context_length: 203000,
        max_completion_tokens: 16384,
      },
      {
        id: 'z-ai/glm-4.6',
        name: 'GLM-4.6',
        context_length: 203000,
        max_completion_tokens: 16384,
      },
      {
        id: 'minimax/minimax-m2.5',
        name: 'MiniMax M2.5',
        context_length: 197000,
        max_completion_tokens: 16384,
      },
      {
        id: 'minimax/minimax-m2',
        name: 'MiniMax M2',
        context_length: 197000,
        max_completion_tokens: 16384,
      },
      {
        id: 'moonshotai/kimi-k2.5',
        name: 'Kimi K2.5',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 16384,
      },
      {
        id: 'deepseek/deepseek-chat-v3.1',
        name: 'DeepSeek Chat V3.1',
        context_length: 164000,
        max_completion_tokens: 16384,
      },
      {
        id: 'deepseek/deepseek-v3.2',
        name: 'DeepSeek V3.2',
        context_length: 164000,
        max_completion_tokens: 16384,
      },
      {
        id: 'deepseek/deepseek-r1-0528',
        name: 'DeepSeek R1 0528',
        context_length: 164000,
        max_completion_tokens: 16384,
      },
      {
        id: 'qwen/qwen3-235b-a22b-2507',
        name: 'Qwen3 235B A22B 2507',
        context_length: 131072,
        max_completion_tokens: 16384,
      },
      {
        id: 'qwen/qwen3-coder-30b-a3b-instruct',
        name: 'Qwen3 Coder 30B A3B Instruct',
        context_length: 262144,
        max_completion_tokens: 16384,
      },
      {
        id: 'meta-llama/llama-3.3-70b-instruct',
        name: 'Llama 3.3 70B Instruct',
        context_length: 131072,
        max_completion_tokens: 16384,
      },
      {
        id: 'meta-llama/llama-4-maverick',
        name: 'Llama 4 Maverick',
        flags: ['vision'],
        context_length: 1050000,
        max_completion_tokens: 16384,
      },
      {
        id: 'openai/gpt-oss-120b',
        name: 'GPT-OSS 120B',
        context_length: 131072,
        max_completion_tokens: 16384,
      },
      {
        id: 'openai/gpt-oss-20b',
        name: 'GPT-OSS 20B',
        context_length: 131072,
        max_completion_tokens: 16384,
      },
    ]),
} satisfies DirectByokProvider;
