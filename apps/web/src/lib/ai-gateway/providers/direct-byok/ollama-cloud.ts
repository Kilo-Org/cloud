import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

// Ollama Cloud exposes an OpenAI-compatible API at https://ollama.com/v1.
// See https://docs.ollama.com/api/openai-compatibility and https://docs.ollama.com/cloud
// The model list is synced dynamically from https://models.dev/api.json
// ("ollama-cloud" entry) via sync-direct-byok.ts.
export default {
  id: 'ollama-cloud',
  base_url: 'https://ollama.com/v1',
  ai_sdk_provider: 'openai-compatible',
  transformRequest(_context) {},
  models: cachedEnhancedDirectByokModelList({
    providerId: 'ollama-cloud',
    recommendedModels: [
      {
        id: 'kimi-k2.6:cloud',
        name: 'Kimi K2.6',
        description:
          "Kimi K2.6 is Moonshot AI's next-generation multimodal model, designed for long-horizon coding, coding-driven UI/UX generation, and multi-agent orchestration.",
        flags: ['vision'],
        context_length: 262144,
        max_completion_tokens: 262144,
        variants: null,
      },
    ],
    variants: null,
  }),
} satisfies DirectByokProvider;
