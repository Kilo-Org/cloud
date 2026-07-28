import { cachedEnhancedDirectByokModelList } from '@/lib/ai-gateway/providers/direct-byok/model-list';
import type { DirectByokProvider } from '@/lib/ai-gateway/providers/direct-byok/types';
import {
  getNvidiaReasoningEfforts,
  isNvidiaReasoningEffort,
} from '@/lib/ai-gateway/providers/nvidia';

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

    const model = request.body.model;
    if (getNvidiaReasoningEfforts(model)) {
      const requestedEffort =
        request.body.reasoning?.enabled === false
          ? 'none'
          : (request.body.reasoning_effort ?? request.body.reasoning?.effort);

      if (isNvidiaReasoningEffort(model, requestedEffort)) {
        request.body.reasoning_effort = requestedEffort;
      } else {
        delete request.body.reasoning_effort;
      }
    } else {
      delete request.body.reasoning_effort;
    }

    // NVIDIA rejects these with `Validation: Unsupported parameter(s)`. We advertise
    // `reasoning` and `include_reasoning` for every direct BYOK model, so both are
    // removed here rather than narrowing what NVIDIA models report as supported.
    delete request.body.provider;
    delete request.body.transforms;
    delete request.body.reasoning;
    delete request.body.include_reasoning;
    delete request.body.safety_identifier;
    delete request.body.prompt_cache_key;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'nvidia-byok',
    recommendedModels: [],
  }),
} satisfies DirectByokProvider;
