import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'morph-byok',
  base_url: 'https://api.morphllm.com/v1',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest() {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'morph-byok',
    recommendedModels: [
      {
        id: 'morph-qwen35-397b',
        name: 'Qwen 3.5 397B',
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 131072,
      },
      {
        id: 'morph-minimax27-230b',
        name: 'MiniMax M2.7',
        context_length: 196608,
        max_completion_tokens: 196608,
      },
      {
        id: 'morph-minimax3-428b',
        name: 'MiniMax M3',
        flags: ['vision'],
        context_length: 256000,
        max_completion_tokens: 256000,
      },
      {
        id: 'morph-glm52-744b',
        name: 'GLM-5.2',
        context_length: 1048576,
        max_completion_tokens: 1048576,
      },
      {
        id: 'morph-qwen36-27b',
        name: 'Qwen 3.6 27B',
        context_length: 131072,
        max_completion_tokens: 131072,
      },
      {
        id: 'morph-dsv4flash',
        name: 'DeepSeek V4 Flash',
        context_length: 1048576,
        max_completion_tokens: 1048576,
      },
    ],
  }),
} satisfies DirectByokProvider;
