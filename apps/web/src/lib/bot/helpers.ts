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
    ok: false;
    error: string;
    needed: string;
    provided: string;
    response_metadata: {
      scopes: string[];
      acceptedScopes: string[];
    };
  };
};

export function isSlackWebApiPlatformError(error: unknown): error is SlackWebApiPlatformError {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'slack_webapi_platform_error'
  );
}

/**
 * Posts a thread message telling the user the Slack app is missing a scope
 * and needs to be re-installed. Links to the Kilo integrations page.
 */
export async function postSlackReinstallInstruction(
  adapter: SlackAdapter,
  threadId: string,
  missingScope: string,
  platformIntegration?: PlatformIntegration | null
): Promise<void> {
  const url = platformIntegration?.owned_by_organization_id
    ? `${APP_URL}/organizations/${platformIntegration.owned_by_organization_id}/integrations/slack`
    : `${APP_URL}/integrations/slack`;

  await adapter.postMessage(threadId, {
    markdown:
      `Kilo Bot is missing the \`${missingScope}\` Slack scope and needs to be re-installed. ` +
      `Open the [Slack integration page](${url}) to re-install the app.`,
  });
}
