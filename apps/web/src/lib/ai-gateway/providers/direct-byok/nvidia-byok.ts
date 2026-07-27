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
      // NVIDIA rejects reasoning controls on models that do not document them.
      delete request.body.reasoning_effort;
    }

    delete request.body.provider;
    delete request.body.providerOptions;
    delete request.body.transforms;
    delete request.body.reasoning;
    delete request.body.include_reasoning;
    // NVIDIA validates unknown fields and rejects the gateway's caller-attribution
    // and cache-hint parameters.
    delete request.body.safety_identifier;
    delete request.body.user;
    delete request.body.prompt_cache_key;
  },
  models: cachedEnhancedDirectByokModelList({
    providerId: 'nvidia-byok',
    recommendedModels: [],
  }),
} satisfies DirectByokProvider;
