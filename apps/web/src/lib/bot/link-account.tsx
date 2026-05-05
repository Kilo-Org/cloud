import { Actions, Card, LinkButton, CardText, type Message, type Thread } from 'chat';
import { createLinkAccountToken, type PlatformIdentity } from '@/lib/bot-identity';
import { APP_URL } from '@/lib/constants';
import { isChannelLevelMessage } from '@/lib/bot/helpers';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { StateAdapter } from 'chat';

const LINK_ACCOUNT_PATH = '/api/chat/link-account';
const GITHUB_LINK_PATH = '/github/link';

export const LINK_ACCOUNT_ACTION_PREFIX = `link-${APP_URL}${LINK_ACCOUNT_PATH}`;

async function buildLinkAccountUrl(
  identity: PlatformIdentity,
  thread: Thread,
  message: Message,
  state: StateAdapter
): Promise<string> {
  const url = new URL(LINK_ACCOUNT_PATH, APP_URL);
  url.searchParams.set(
    'token',
    await createLinkAccountToken({
      identity,
      thread: thread.toJSON(),
      message: message.toJSON(),
      state,
    })
  );
  return url.toString();
}

function linkAccountCard(linkUrl: string) {
  return Card({
    title: 'Link your Kilo account',
    children: [
      CardText(
        'To use Kilo from this workspace you first need to link your chat account. ' +
          'Click the button below to sign in and link your account.'
      ),
      Actions([LinkButton({ label: 'Link Account', url: linkUrl, style: 'primary' })]),
    ],
  });
}

export async function promptLinkAccount(
  thread: Thread,
  message: Message,
  identity: PlatformIdentity,
  state: StateAdapter
): Promise<void> {
  // Post to the channel when the @mention is top-level, otherwise into the thread.
  const target = isChannelLevelMessage(thread, message) ? thread.channel : thread;

  switch (identity.platform) {
    case PLATFORM.SLACK: {
      const linkUrl = await buildLinkAccountUrl(identity, thread, message, state);
      await target.postEphemeral(message.author, linkAccountCard(linkUrl), {
        fallbackToDM: true,
      });
      return;
    }
    case PLATFORM.GITHUB:
      const linkUrl = new URL(GITHUB_LINK_PATH, APP_URL);
      linkUrl.searchParams.set('installation_id', identity.teamId);

      await target.post({
        markdown:
          'To use Kilo from GitHub you first need to link your GitHub account to Kilo. ' +
          `[Link your Kilo account](${linkUrl.toString()}) to continue. ` +
          'After linking, mention me again in this issue or pull request.',
      });
      return;
    default:
      throw new Error(`Unsupported platform: ${identity.platform}`);
  }
}
