import 'server-only';

import { WebClient } from '@slack/web-api';
import type { SlackInstallation } from '@chat-adapter/slack';
import { z } from 'zod';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } from '@/lib/config.server';

const slackOAuthResponseSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  bot_user_id: z.string().min(1).optional(),
  scope: z.string().optional(),
  team: z.object({ id: z.string().min(1), name: z.string().optional() }).optional(),
  enterprise: z.object({ id: z.string().min(1), name: z.string().optional() }).optional(),
  is_enterprise_install: z.boolean().optional(),
});

export type ExchangedSlackInstallation = {
  teamId: string;
  installation: SlackInstallation;
  grantedScopes: string[] | null;
};

type SlackOAuthExchange = (input: {
  client_id: string;
  client_secret: string;
  code: string;
  redirect_uri: string;
}) => Promise<unknown>;

export async function exchangeSlackOAuthCode(
  code: string,
  redirectUri: string,
  exchange: SlackOAuthExchange = input => new WebClient().oauth.v2.access(input)
): Promise<ExchangedSlackInstallation> {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    throw new Error('Slack OAuth is not configured');
  }
  const result = slackOAuthResponseSchema.parse(
    await exchange({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    })
  );
  const isEnterpriseInstall = result.is_enterprise_install === true;
  const teamId = isEnterpriseInstall ? result.enterprise?.id : result.team?.id;
  if (!teamId) throw new Error('Slack OAuth response did not identify an installation');

  return {
    teamId,
    installation: {
      botToken: result.access_token,
      botUserId: result.bot_user_id,
      teamName: result.team?.name ?? result.enterprise?.name,
      ...(result.enterprise?.id ? { enterpriseId: result.enterprise.id } : {}),
      ...(isEnterpriseInstall ? { isEnterpriseInstall: true } : {}),
    },
    grantedScopes: result.scope
      ? result.scope
          .split(',')
          .map(scope => scope.trim())
          .filter(Boolean)
      : null,
  };
}
