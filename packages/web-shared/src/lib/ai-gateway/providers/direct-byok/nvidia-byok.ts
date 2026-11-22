import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { replaceReasoningObjectWithReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

const id = 'nvidia-byok';

export default {
  id,
  openrouter_inference_provider_id: 'nvidia',
  models_dev_id: 'nvidia',
  ...apiKeyUpstream({
    apiUrl: 'https://integrate.api.nvidia.com/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest(context) {
    const { request } = context;
    if (request.kind !== 'chat_completions') {
      return;
    }

    replaceReasoningObjectWithReasoningEffort(request, { disableWithNoneEffort: true });
    delete request.body.transforms;
    delete request.body.safety_identifier;
    delete request.body.prompt_cache_key;
  },
  models: cachedDirectByokModelList(id),
} satisfies DirectByokProvider;
