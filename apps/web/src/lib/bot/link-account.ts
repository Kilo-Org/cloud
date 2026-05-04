import { Actions, Card, LinkButton, Section, CardText, type Message, type Thread } from 'chat';
import {
  createLinkToken,
  createPlatformInstallToken,
  type PlatformIdentity,
} from '@/lib/bot-identity';
import { APP_URL } from '@/lib/constants';
import { isChannelLevelMessage } from '@/lib/bot/helpers';

const LINK_ACCOUNT_PATH = '/api/chat/link-account';
const SLACK_GET_STARTED_PATH = '/get-started/slack';

export const LINK_ACCOUNT_ACTION_PREFIX = `link-${APP_URL}${LINK_ACCOUNT_PATH}`;
export const INSTALL_INTEGRATION_ACTION_PREFIX = `link-${APP_URL}${SLACK_GET_STARTED_PATH}`;

function buildLinkAccountUrl(identity: PlatformIdentity): string {
  const url = new URL(LINK_ACCOUNT_PATH, APP_URL);
  url.searchParams.set('token', createLinkToken(identity));
  return url.toString();
}

function linkAccountCard(linkUrl: string) {
  return Card({
    title: 'Link your Kilo account',
    children: [
      Section([
        CardText(
          'To use Kilo from this workspace you first need to link your chat account. ' +
            'Click the button below to sign in and link your account.'
        ),
      ]),
      Actions([LinkButton({ label: 'Link Account', url: linkUrl, style: 'primary' })]),
    ],
  });
}

function buildInstallIntegrationUrl(
  identity: PlatformIdentity,
  thread: Thread,
  message: Message
): string {
  const url = new URL(SLACK_GET_STARTED_PATH, APP_URL);
  url.searchParams.set(
    'installToken',
    createPlatformInstallToken({
      ...identity,
      threadId: thread.id,
      messageId: message.id,
    })
  );
  return url.toString();
}

function installIntegrationCard(linkUrl: string) {
  return Card({
    title: 'Finish connecting Kilo',
    children: [
      Section([
        CardText(
          'Kilo is installed in this Slack workspace, but it is not connected to a Kilo workspace yet. ' +
            'Sign in or create an account to choose where this Slack app should live.'
        ),
      ]),
      Actions([LinkButton({ label: 'Finish setup', url: linkUrl, style: 'primary' })]),
    ],
  });
}

export async function promptLinkAccount(
  thread: Thread,
  message: Message,
  identity: PlatformIdentity
): Promise<void> {
  // Post to the channel when the @mention is top-level, otherwise into the thread.
  const target = isChannelLevelMessage(thread, message) ? thread.channel : thread;

  await target.postEphemeral(message.author, linkAccountCard(buildLinkAccountUrl(identity)), {
    fallbackToDM: true,
  });
}

export async function promptInstallIntegration(
  thread: Thread,
  message: Message,
  identity: PlatformIdentity
): Promise<void> {
  const target = isChannelLevelMessage(thread, message) ? thread.channel : thread;

  await target.postEphemeral(
    message.author,
    installIntegrationCard(buildInstallIntegrationUrl(identity, thread, message)),
    { fallbackToDM: true }
  );
}
