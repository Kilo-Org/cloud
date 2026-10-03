import type { SlackAdapter } from '@chat-adapter/slack';
import { captureException } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import type { PlatformIntegration } from '@kilocode/db';

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

type SlackReactionCapableAdapter = Pick<SlackAdapter, 'addReaction' | 'removeReaction'>;

function isSlackReactionStateError(error: unknown, stateError: string): boolean {
  return isSlackWebApiPlatformError(error) && error.data.error === stateError;
}

async function applySlackReaction(
  adapter: SlackReactionCapableAdapter,
  action: 'add' | 'remove',
  threadId: string,
  messageId: string,
  emoji: string
): Promise<boolean> {
  try {
    if (action === 'add') {
      await adapter.addReaction(threadId, messageId, emoji);
    } else {
      await adapter.removeReaction(threadId, messageId, emoji);
    }
    return true;
  } catch (error) {
    if (isSlackReactionStateError(error, action === 'add' ? 'already_reacted' : 'no_reaction')) {
      return true;
    }
    console.warn(`[Bot] Failed to ${action} Slack reaction:`, error);
    captureException(error, {
      level: 'warning',
      tags: { component: 'kilo-bot', op: `slack-reaction-${action}` },
      extra: { threadId, messageId, emoji },
    });
    return false;
  }
}

export async function addSlackReaction(
  adapter: SlackReactionCapableAdapter,
  threadId: string,
  messageId: string,
  emoji: string
): Promise<boolean> {
  return applySlackReaction(adapter, 'add', threadId, messageId, emoji);
}

/**
 * Atomically replacing one reaction with another is not possible, so this
 * removes the old reaction only after the replacement was applied — that way
 * the message never briefly shows no reaction at all.
 */
export async function replaceSlackReaction(
  adapter: SlackReactionCapableAdapter,
  threadId: string,
  messageId: string,
  removeEmoji: string,
  addEmoji: string
): Promise<boolean> {
  const added = await applySlackReaction(adapter, 'add', threadId, messageId, addEmoji);
  if (!added) return false;
  return applySlackReaction(adapter, 'remove', threadId, messageId, removeEmoji);
}
