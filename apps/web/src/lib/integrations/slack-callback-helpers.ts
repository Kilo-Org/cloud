import 'server-only';
import type { SlackAdapter } from '@chat-adapter/slack';
import { captureException, captureMessage } from '@sentry/nextjs';
import { bot } from '@/lib/bot';
import { linkKiloUser, verifyPlatformInstallToken } from '@/lib/bot-identity';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { verifyOAuthState, type VerifiedOAuthState } from '@/lib/integrations/oauth-state';

const SLACK_MARKETPLACE_SOURCE = 'slack_marketplace_install';

export function buildSlackRedirectPath(
  state: string | null,
  params: Record<string, string>
): string {
  const verified = state ? verifyOAuthState(state) : null;
  const owner = verified?.owner;
  const search = new URLSearchParams(params);

  if (verified?.metadata?.source === SLACK_MARKETPLACE_SOURCE) {
    const error = search.get('error');
    if (error) {
      search.delete('error');
      search.set('slackError', error);
    }
    const success = search.get('success');
    if (success) {
      search.delete('success');
      search.set('slackSuccess', success);
    }
    search.set('source', SLACK_MARKETPLACE_SOURCE);
    search.set('installToken', verified.metadata.installToken);
    return `/get-started/slack?${search.toString()}`;
  }

  if (owner?.startsWith('org_')) {
    return `/organizations/${owner.replace('org_', '')}/integrations/slack?${search.toString()}`;
  }
  if (owner?.startsWith('user_')) {
    return `/integrations/slack?${search.toString()}`;
  }
  return `/integrations?${search.toString()}`;
}

async function postSlackMarketplaceInstallConfirmation(
  slackAdapter: SlackAdapter,
  threadId: string,
  teamName: string | undefined
): Promise<void> {
  try {
    await slackAdapter.postMessage(threadId, {
      markdown:
        `Kilo is connected${teamName ? ` to ${teamName}` : ''}. ` +
        'Mention me here whenever you want help debugging code, reviewing PRs, or answering questions about your repos.',
    });
  } catch (error) {
    captureException(error, {
      level: 'warning',
      tags: { component: 'kilo-bot', op: 'marketplace-install-confirmation' },
      extra: { threadId },
    });
  }
}

export async function completeSlackMarketplaceInstall(params: {
  verified: VerifiedOAuthState;
  teamId: string;
  userId: string;
  teamName: string | undefined;
  slackAdapter: SlackAdapter;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const metadata = params.verified.metadata;
  if (metadata?.source !== SLACK_MARKETPLACE_SOURCE) return { ok: true };

  const installTokenData = verifyPlatformInstallToken(metadata.installToken);
  if (!installTokenData || installTokenData.platform !== PLATFORM.SLACK) {
    return { ok: false, error: 'invalid_install_token' };
  }

  if (installTokenData.teamId !== params.teamId) {
    captureMessage('Slack marketplace install team mismatch', {
      level: 'warning',
      tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
      extra: { tokenTeamId: installTokenData.teamId, callbackTeamId: params.teamId },
    });
    return { ok: false, error: 'workspace_mismatch' };
  }

  await linkKiloUser(
    bot.getState(),
    {
      platform: installTokenData.platform,
      teamId: installTokenData.teamId,
      userId: installTokenData.userId,
    },
    params.userId
  );

  if (installTokenData.threadId) {
    await postSlackMarketplaceInstallConfirmation(
      params.slackAdapter,
      installTokenData.threadId,
      params.teamName
    );
  }

  return { ok: true };
}
