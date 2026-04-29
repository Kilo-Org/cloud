import { Actions, Card, LinkButton, Section, CardText, type Message, type Thread } from 'chat';
import { createLinkToken, type PlatformIdentity } from '@/lib/bot-identity';
import { APP_URL } from '@/lib/constants';
import { isChannelLevelMessage } from '@/lib/bot/helpers';

const INSTALL_INTEGRATION_PATH = '/api/chat/install-integration';

function platformLabel(platform: string): string {
  switch (platform) {
    case 'slack':
      return 'Slack';
    case 'teams':
      return 'Microsoft Teams';
    default:
      return platform;
  }
}

function buildInstallIntegrationUrl(identity: PlatformIdentity): string {
  const url = new URL(INSTALL_INTEGRATION_PATH, APP_URL);
  url.searchParams.set('token', createLinkToken(identity));
  return url.toString();
}

function installIntegrationCard(linkUrl: string, identity: PlatformIdentity) {
  const platform = platformLabel(identity.platform);
  return Card({
    title: `Connect ${platform} to Kilo`,
    children: [
      Section([
        CardText(
          `This ${platform} workspace is not linked to a Kilo account or organization yet. ` +
            'Open the secure setup page to choose where this workspace should be connected.'
        ),
      ]),
      Actions([LinkButton({ label: 'Connect Workspace', url: linkUrl, style: 'primary' })]),
    ],
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
    installIntegrationCard(buildInstallIntegrationUrl(identity), identity),
    {
      fallbackToDM: true,
    }
  );
}
