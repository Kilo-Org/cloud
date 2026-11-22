import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  providerListing,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

const id = 'ollama-cloud';

export default {
  id,
  models_dev_id: 'ollama-cloud',
  ...apiKeyUpstream({
    apiUrl: 'https://ollama.com/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  models: cachedDirectByokModelList(id),
  provider_listing: providerListing({
    siteUrl: 'https://ollama.com/',
    training: false,
    retainsPrompts: false,
    termsOfServiceURL: 'https://ollama.com/terms',
    privacyPolicyURL: 'https://ollama.com/privacy',
  }),
} satisfies DirectByokProvider;
