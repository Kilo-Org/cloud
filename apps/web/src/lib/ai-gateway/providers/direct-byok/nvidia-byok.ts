import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { ReasoningEffortSchema } from '@kilocode/db/schema-types';

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

    const reasoningEffort =
      request.body.reasoning?.enabled === false
        ? 'none'
        : (request.body.reasoning_effort ?? request.body.reasoning?.effort);
    const parsedReasoningEffort = ReasoningEffortSchema.safeParse(reasoningEffort);
    if (parsedReasoningEffort.success) {
      (request.body as { reasoning_effort?: string }).reasoning_effort = parsedReasoningEffort.data;
    } else {
      delete request.body.reasoning_effort;
    }

    // NVIDIA rejects these with `Validation: Unsupported parameter(s)`.
    delete request.body.provider;
    delete request.body.providerOptions;
    delete request.body.transforms;
    delete request.body.reasoning;
    delete request.body.safety_identifier;
    delete request.body.prompt_cache_key;
    // Older clients may still send this untyped OpenRouter field.
    delete (request.body as { include_reasoning?: boolean }).include_reasoning;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'nvidia-byok',
    recommendedModels: [],
  }),
} satisfies DirectByokProvider;
