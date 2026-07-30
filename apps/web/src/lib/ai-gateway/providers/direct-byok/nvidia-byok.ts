import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'nvidia-byok',
  base_url: 'https://integrate.api.nvidia.com/v1',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest(context) {
    const { request } = context;
    if (request.kind !== 'chat_completions') {
      return;
    }
    request.body.reasoning_effort ??= request.body.reasoning?.effort;
    delete request.body.provider;
    delete request.body.transforms;
    delete request.body.reasoning;
    delete request.body.safety_identifier;
    delete request.body.prompt_cache_key;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'nvidia-byok',
    recommendedModels: [
      {
        id: 'z-ai/glm-5.2',
        name: 'GLM-5.2',
        flags: ['reasoning'],
        context_length: 1_000_000,
        max_completion_tokens: 131_072,
      },
    ],
  }),
} satisfies DirectByokProvider;
