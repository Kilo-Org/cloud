import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  providerListing,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

const id = 'orcarouter';

export default {
  id,
  models_dev_id: 'orcarouter',
  ...apiKeyUpstream({
    apiUrl: 'https://api.orcarouter.ai/v1',
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  models: cachedDirectByokModelList(id),
  provider_listing: providerListing({
    siteUrl: 'https://www.orcarouter.ai/',
    training: true,
    retainsPrompts: true,
    termsOfServiceURL: 'https://www.orcarouter.ai/terms.html',
    privacyPolicyURL: 'https://www.orcarouter.ai/privacy.html',
  }),
} satisfies DirectByokProvider;
