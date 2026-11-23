import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  providerListing,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

const id = 'neuralwatt';

export default {
  id,
  models_dev_id: 'neuralwatt',
  ...apiKeyUpstream({
    apiUrl: 'https://api.neuralwatt.com/v1',
    supportedChatApis: ['chat_completions'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  models: cachedDirectByokModelList(id),
  provider_listing: providerListing({
    siteUrl: 'https://neuralwatt.com/',
    training: false,
    retainsPrompts: true,
    termsOfServiceURL: 'https://neuralwatt.com/terms',
    privacyPolicyURL: 'https://neuralwatt.com/privacy',
  }),
} satisfies DirectByokProvider;
