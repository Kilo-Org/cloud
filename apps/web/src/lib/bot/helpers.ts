import type { SlackAdapter, SlackEvent } from '@chat-adapter/slack';
import type { Thread, Message } from 'chat';
import { APP_URL } from '@/lib/constants';
import type { PlatformIntegration } from '@kilocode/db';

export function isChannelLevelMessage(thread: Thread, message: Message): boolean {
  const platform = thread.id.split(':')[0];

  switch (platform) {
    case 'slack': {
      const raw = (message as Message<SlackEvent>).raw;
      return !raw.thread_ts || raw.thread_ts === raw.ts;
    }
    default:
      return false;
  }
}

export type SlackWebApiPlatformError = {
  code: 'slack_webapi_platform_error';
  data: {
    ok?: false;
    error?: unknown;
    needed?: unknown;
    provided?: unknown;
    response_metadata?: unknown;
  };
};

export type SlackMissingScopeError = SlackWebApiPlatformError & {
  data: SlackWebApiPlatformError['data'] & {
    error: 'missing_scope';
    needed: string;
  };
};

export function isSlackWebApiPlatformError(error: unknown): error is SlackWebApiPlatformError {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'slack_webapi_platform_error' &&
    'data' in error &&
    !!error.data &&
    typeof error.data === 'object'
  );
}

export function isSlackMissingScopeError(error: unknown): error is SlackMissingScopeError {
  return (
    isSlackWebApiPlatformError(error) &&
    error.data.error === 'missing_scope' &&
    typeof error.data.needed === 'string'
  );
}

/**
 * Posts a thread message telling the user the Slack app is missing a scope
 * and needs to be re-installed. Links to an authenticated Kilo route that
 * creates a fresh signed Slack OAuth state before redirecting to Slack.
 */
export async function postSlackReinstallInstruction(
  adapter: SlackAdapter,
  threadId: string,
  missingScope: string,
  platformIntegration?: PlatformIntegration | null
): Promise<void> {
  const url = platformIntegration?.owned_by_organization_id
    ? `${APP_URL}/organizations/${platformIntegration.owned_by_organization_id}/integrations/slack/reinstall`
    : `${APP_URL}/integrations/slack/reinstall`;

  await adapter.postMessage(threadId, {
    markdown:
      `Kilo Bot is missing the \`${missingScope}\` Slack scope and needs to be re-installed. ` +
      `Open the [Slack reinstall link](${url}) to refresh the app permissions. ` +
      `If you are not a Slack administrator, you may need to ask one to re-install the app. ` +
      `You can continue using Kilo Bot as usual; only features that require this new Slack permission may be unavailable until the app is re-installed.`,
  });
}
