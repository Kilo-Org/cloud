import { Actions, Card, LinkButton, CardText, type Message, type Thread } from 'chat';
import { createLinkAccountToken, type PlatformIdentity } from '@/lib/bot-identity';
import { APP_URL } from '@/lib/constants';
import { isChannelLevelMessage } from '@/lib/bot/helpers';
import type { StateAdapter } from 'chat';

const LINK_ACCOUNT_PATH = '/api/chat/link-account';

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

  await target.postEphemeral(
    message.author,
    linkAccountCard(await buildLinkAccountUrl(identity, thread, message, state)),
    {
      fallbackToDM: true,
    }
  );
}
