import { cachedDirectByokModelList } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/model-list';
import {
  apiKeyUpstream,
  faviconIcon,
  type DirectByokProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';

export default {
  id: 'martian',
  ...apiKeyUpstream({
    apiUrl: 'https://api.withmartian.com/v1',
    supportedChatApis: ['chat_completions', 'messages', 'responses'],
    responseTransforms: null,
  }),
  transformRequest() {},
  models: cachedDirectByokModelList('martian'),
  provider_listing: {
    dataPolicy: {
      training: true,
      retainsPrompts: true,
      canPublish: false,
      termsOfServiceURL: 'https://withmartian.com/terms-of-service',
      privacyPolicyURL: 'https://withmartian.com/privacy-policy',
    },
    icon: faviconIcon('https://withmartian.com/'),
  },
} satisfies DirectByokProvider;
