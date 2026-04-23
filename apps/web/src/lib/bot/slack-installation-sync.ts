import 'server-only';
import type { OAuthV2Response } from '@slack/oauth';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { bot } from '@/lib/bot';
import { extractSdkInstallationData } from './slack-installation-sync-mapping';

export {
  extractSdkInstallationData,
  type SdkInstallationData,
} from './slack-installation-sync-mapping';

type SlackInstallationMetadata = {
  accessToken?: string;
  botUserId?: string;
};

function getSlackInstallationMetadata(value: unknown): SlackInstallationMetadata {
  if (typeof value !== 'object' || value === null) return {};

  const accessToken = 'access_token' in value ? value.access_token : undefined;
  const botUserId = 'bot_user_id' in value ? value.bot_user_id : undefined;

  return {
    accessToken: typeof accessToken === 'string' ? accessToken : undefined,
    botUserId: typeof botUserId === 'string' ? botUserId : undefined,
  };
}

async function syncSdkInstallation(params: {
  teamId: string;
  botToken: string;
  botUserId?: string;
  teamName?: string;
}): Promise<void> {
  await bot.initialize();
  const adapter = bot.getAdapter('slack');
  await adapter.setInstallation(params.teamId, {
    botToken: params.botToken,
    botUserId: params.botUserId,
    teamName: params.teamName,
  });
}

export async function syncOldSlackInstallationToSdk(oauthResponse: OAuthV2Response): Promise<void> {
  const data = extractSdkInstallationData(oauthResponse);
  await syncSdkInstallation(data);
}

export async function syncSlackPlatformIntegrationToSdk(
  integration: PlatformIntegration
): Promise<boolean> {
  const teamId = integration.platform_installation_id;
  const metadata = getSlackInstallationMetadata(integration.metadata);

  if (!teamId || !metadata.accessToken) {
    return false;
  }

  await syncSdkInstallation({
    teamId,
    botToken: metadata.accessToken,
    botUserId: metadata.botUserId,
    teamName: integration.platform_account_login ?? undefined,
  });

  return true;
}
