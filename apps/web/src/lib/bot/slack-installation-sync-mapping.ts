import type { OAuthV2Response } from '@slack/oauth';

export type SdkInstallationData = {
  teamId: string;
  botToken: string;
  botUserId?: string;
  teamName?: string;
};

export function extractSdkInstallationData(oauthResponse: OAuthV2Response): SdkInstallationData {
  const teamId = oauthResponse.team?.id;
  const accessToken = oauthResponse.access_token;

  if (!teamId) {
    throw new Error('Missing team.id in Slack OAuth response');
  }
  if (!accessToken) {
    throw new Error('Missing access_token in Slack OAuth response');
  }

  return {
    teamId,
    botToken: accessToken,
    botUserId: oauthResponse.bot_user_id ?? undefined,
    teamName: oauthResponse.team?.name || undefined,
  };
}
