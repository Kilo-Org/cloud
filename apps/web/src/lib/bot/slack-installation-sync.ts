import 'server-only';
import { Chat } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import type { OAuthV2Response } from '@slack/oauth';
import { SLACK_SIGNING_SECRET } from '@/lib/config.server';
import { createChatState } from './state';
import { extractSdkInstallationData } from './slack-installation-sync-mapping';

export {
  extractSdkInstallationData,
  type SdkInstallationData,
} from './slack-installation-sync-mapping';

const syncSlackAdapter = createSlackAdapter({
  signingSecret: SLACK_SIGNING_SECRET,
});

const syncBot = new Chat({
  userName: 'Kilo Sync Bot',
  adapters: { slack: syncSlackAdapter },
  state: createChatState(),
});

export async function syncOldSlackInstallationToSdk(oauthResponse: OAuthV2Response): Promise<void> {
  const data = extractSdkInstallationData(oauthResponse);
  await syncBot.initialize();
  const adapter = syncBot.getAdapter('slack');
  await adapter.setInstallation(data.teamId, {
    botToken: data.botToken,
    botUserId: data.botUserId,
    teamName: data.teamName,
  });
}
