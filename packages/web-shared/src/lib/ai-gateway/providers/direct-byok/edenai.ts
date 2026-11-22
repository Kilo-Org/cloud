import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { replaceReasoningObjectWithReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/request-helpers';
import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  providerListing,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

const id = 'edenai';

export default {
  id,
  models_dev_id: 'edenai',
  ...apiKeyUpstream({
    apiUrl: 'https://api.edenai.run/v3',
    apiUrlOverrides: { messages: 'https://api.edenai.run/v3/v1' },
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    responseTransforms: ReasoningDetailsTransform.ReasoningContent,
  }),
  transformRequest(context) {
    replaceReasoningObjectWithReasoningEffort(context.request, { disableWithNoneEffort: true });
  },
  models: cachedDirectByokModelList(id),
  provider_listing: providerListing({
    siteUrl: 'https://www.edenai.co/',
    training: true,
    retainsPrompts: true,
    termsOfServiceURL: 'https://www.edenai.co/terms',
    privacyPolicyURL: 'https://www.edenai.co/privacy',
  }),
} satisfies DirectByokProvider;
