import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import { ReasoningEffortSchema } from '@kilocode/db/schema-types';

export default {
  id: 'nvidia-byok',
  base_url: 'https://integrate.api.nvidia.com/v1',
  supported_chat_apis: ['chat_completions'],
  default_ai_sdk_provider: 'openai-compatible',
  transformRequest(context, model) {
    const { request } = context;
    if (request.kind !== 'chat_completions') {
      return;
    }

    const reasoningEffort =
      request.body.reasoning?.enabled === false
        ? 'none'
        : (request.body.reasoning_effort ?? request.body.reasoning?.effort);
    const parsedReasoningEffort = ReasoningEffortSchema.safeParse(reasoningEffort);
    const supportedReasoningEfforts = new Set(
      Object.values(model.variants ?? {}).flatMap(variant =>
        variant.reasoning?.effort ? [variant.reasoning.effort] : []
      )
    );
    if (
      parsedReasoningEffort.success &&
      supportedReasoningEfforts.has(parsedReasoningEffort.data)
    ) {
      request.body.reasoning_effort = parsedReasoningEffort.data;
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
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'nvidia-byok',
    recommendedModels: [
      {
        id: 'nvidia/nemotron-3-nano-30b-a3b',
        name: 'Nemotron 3 Nano 30B A3B',
        flags: ['reasoning'],
        context_length: 131072,
        max_completion_tokens: 131072,
      },
    ],
  }),
} satisfies DirectByokProvider;
