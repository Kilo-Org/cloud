import { createGitHubAdapter } from '@chat-adapter/github';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';

const githubAppCredentials = getGitHubAppCredentials('standard');
export const githubAdapter = createGitHubAdapter({
  appId: githubAppCredentials.appId,
  privateKey: githubAppCredentials.privateKey,
  webhookSecret: githubAppCredentials.webhookSecret,
  userName: process.env.NODE_ENV === 'development' ? 'kilocode-dev' : 'kilocode-bot',
});
