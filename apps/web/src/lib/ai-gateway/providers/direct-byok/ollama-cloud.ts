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
        id: 'gpt-oss:120b',
        name: 'GPT-OSS 120B',
        description:
          "gpt-oss-120b is OpenAI's open-weight, 117B-parameter Mixture-of-Experts (MoE) language model designed for high-reasoning, agentic, and general-purpose production use cases. It activates 5.1B parameters per forward pass.",
        flags: [],
        context_length: 131072,
        max_completion_tokens: 131072,
        variants: null,
      },
    ],
    variants: null,
  }),
} satisfies DirectByokProvider;
