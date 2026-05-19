import { createLinkAccountToken } from '@/lib/bot-identity';
import {
  collectMessages,
  formatMessage,
  formatUserMessage,
  MAX_MESSAGE_TEXT_LENGTH,
  sanitizeForDelimiters,
  truncate,
  type ContextTriggerMessage,
} from '@/lib/bot/platforms/shared';
import type { BotPlatform, RequesterInfo } from '@/lib/bot/platforms/types';
import { BOT_CONTEXT_MESSAGE_LIMIT } from '@/lib/bot/constants';
import { APP_URL } from '@/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { TeamsAdapter } from '@chat-adapter/teams';
import {
  Actions,
  Card,
  CardText,
  LinkButton,
  type ChannelInfo,
  type Message,
  type Thread,
} from 'chat';

const LINK_ACCOUNT_PATH = '/api/chat/link-account';
const INSTALL_INTEGRATION_PATH = '/api/chat/install-integration';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function getRecord(value: unknown, key: string): UnknownRecord | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function getString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return typeof nested === 'string' && nested.trim().length > 0 ? nested : null;
}

export function getTeamsTenantId(message: Message): string | null {
  const conversation = getRecord(message.raw, 'conversation');
  const channelData = getRecord(message.raw, 'channelData');
  const tenant = getRecord(channelData, 'tenant');
  return getString(conversation, 'tenantId') ?? getString(tenant, 'id');
}

function getTeamsTenantName(message: Message): string | null {
  const conversation = getRecord(message.raw, 'conversation');
  const channelData = getRecord(message.raw, 'channelData');
  const tenant = getRecord(channelData, 'tenant');
  return getString(tenant, 'name') ?? getString(conversation, 'name');
}

function getTeamsTeamName(message: Message): string | null {
  const channelData = getRecord(message.raw, 'channelData');
  const team = getRecord(channelData, 'team');
  return getString(team, 'name');
}

function getTeamsChannelName(message: Message): string | null {
  const channelData = getRecord(message.raw, 'channelData');
  const channel = getRecord(channelData, 'channel');
  return getString(channel, 'name');
}

function linkAccountCard(linkUrl: string) {
  return Card({
    title: 'Link your Kilo account',
    children: [
      CardText(
        'To use Kilo from this Teams tenant, link your Teams user to your Kilo account. ' +
          'This private setup card was sent as a DM so your link stays private.'
      ),
      Actions([LinkButton({ label: 'Link Account', url: linkUrl, style: 'primary' })]),
    ],
  });
}

function installIntegrationCard(linkUrl: string, tenantName: string | null) {
  const tenantLabel = tenantName ? ` for ${tenantName}` : '';
  return Card({
    title: 'Connect Teams to Kilo',
    children: [
      CardText(
        `Kilo is installed in Microsoft Teams${tenantLabel}, but this tenant is not connected to a Kilo account or organization yet. Choose where to connect it, then Kilo will continue processing your message.`
      ),
      Actions([LinkButton({ label: 'Connect Teams', url: linkUrl, style: 'primary' })]),
    ],
  });
}

async function postPrivateSetupCard(params: {
  thread: Thread;
  message: Message;
  card: ReturnType<typeof Card>;
}): Promise<void> {
  await params.thread.postEphemeral(params.message.author, params.card, { fallbackToDM: true });
}

async function getTeamsConversationContext(
  thread: Thread,
  triggerMessage: ContextTriggerMessage,
  teamsAdapter: TeamsAdapter
): Promise<string> {
  const [channelInfo, threadMessagesRaw, channelMessagesRaw] = await Promise.all([
    thread.channel.fetchMetadata().catch((): ChannelInfo | null => null),
    collectMessages(thread.messages, BOT_CONTEXT_MESSAGE_LIMIT).catch((): Message[] => []),
    collectMessages(thread.channel.messages, BOT_CONTEXT_MESSAGE_LIMIT).catch((): Message[] => []),
  ]);

  const threadMessages = threadMessagesRaw
    .filter(m => m.id !== triggerMessage.id)
    .map(m => formatMessage(m))
    .reverse();

  const channelMessages = channelMessagesRaw
    .filter(m => m.id !== triggerMessage.id)
    .map(m => formatMessage(m))
    .reverse();

  const lines: string[] = ['Microsoft Teams conversation context:'];

  const isDirectMessage = channelInfo?.isDM ?? thread.isDM;
  const channelLabel = isDirectMessage ? 'DM' : channelInfo?.name || 'channel';
  lines.push(`- Channel: ${sanitizeForDelimiters(channelLabel)}`);

  const metadata = channelInfo?.metadata;
  const description = getString(metadata, 'description');
  if (description) {
    lines.push(
      `- Channel description: ${sanitizeForDelimiters(truncate(description, MAX_MESSAGE_TEXT_LENGTH))}`
    );
  }

  const conversationId = getString(metadata, 'conversationId');
  if (conversationId) {
    lines.push(`- Conversation ID: ${sanitizeForDelimiters(conversationId)}`);
  } else {
    const decoded = (() => {
      try {
        return teamsAdapter.decodeThreadId(thread.id);
      } catch {
        return null;
      }
    })();
    if (decoded?.conversationId) {
      lines.push(`- Conversation ID: ${sanitizeForDelimiters(decoded.conversationId)}`);
    }
  }

  if (channelMessages.length > 0) {
    lines.push('', 'Recent channel messages (oldest first):');
    for (const msg of channelMessages) lines.push(formatUserMessage(msg));
  }

  if (threadMessages.length > 0) {
    lines.push('', 'Thread messages (oldest first):');
    for (const msg of threadMessages) lines.push(formatUserMessage(msg));
  }

  if (lines.length <= 2 && channelMessages.length === 0 && threadMessages.length === 0) return '';
  return lines.join('\n');
}

function getTeamsRequesterInfo(displayName: string): RequesterInfo {
  return { displayName, platform: PLATFORM.TEAMS };
}

export function createTeamsBotPlatform(teamsAdapter: TeamsAdapter): BotPlatform {
  return {
    platform: PLATFORM.TEAMS,
    documentationUrl: 'https://kilo.ai/docs/code-with-ai/platforms/teams',
    usesGenericLinkAccountRoute: true,

    async getIdentity({ message }) {
      const tenantId = getTeamsTenantId(message);
      if (!tenantId) {
        throw new Error('Expected a Teams tenant ID in message.raw');
      }
      return {
        platform: PLATFORM.TEAMS,
        teamId: tenantId,
        userId: message.author.userId,
      };
    },

    isEnabledForBot: () => true,

    canHandleMessage: () => true,

    async promptLinkAccount({ thread, message, identity, state }) {
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

      await postPrivateSetupCard({
        thread,
        message,
        card: linkAccountCard(url.toString()),
      });
    },

    async promptInstallIntegration({ thread, message, identity, state }) {
      const url = new URL(INSTALL_INTEGRATION_PATH, APP_URL);
      url.searchParams.set(
        'token',
        await createLinkAccountToken({
          identity,
          thread: thread.toJSON(),
          message: message.toJSON(),
          state,
        })
      );

      await postPrivateSetupCard({
        thread,
        message,
        card: installIntegrationCard(url.toString(), getTeamsTenantName(message)),
      });
    },

    async withAuthContext({ fn }) {
      return await fn();
    },

    async getConversationContext({ thread, triggerMessage }) {
      return await getTeamsConversationContext(thread, triggerMessage, teamsAdapter);
    },

    async getRequesterInfo({ displayName }) {
      return getTeamsRequesterInfo(displayName);
    },
  };
}

export function getTeamsConversationNames(message: Message) {
  return {
    tenantName: getTeamsTenantName(message),
    teamName: getTeamsTeamName(message),
    channelName: getTeamsChannelName(message),
  };
}
