import { MessageSquare, Send, Slack } from 'lucide-react';

export type ChannelType = 'telegram' | 'discord' | 'slack';

type ChannelField = {
  key: string;
  label: string;
  placeholder: string;
  placeholderConfigured: string;
};

export type ChannelDefinition = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  fields: ChannelField[];
  configuredCheck: (channels: {
    telegram: boolean;
    discord: boolean;
    slackBot: boolean;
    slackApp: boolean;
  }) => boolean;
  help: React.ReactNode;
};

export const CHANNELS: Record<ChannelType, ChannelDefinition> = {
  telegram: {
    label: 'Telegram',
    icon: Send,
    fields: [
      {
        key: 'telegramBotToken',
        label: 'Bot Token',
        placeholder: '123456:ABC-DEF...',
        placeholderConfigured: 'Enter new token to replace',
      },
    ],
    configuredCheck: ch => ch.telegram,
    help: (
      <>
        Get a token from{' '}
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          @BotFather
        </a>{' '}
        on Telegram.
      </>
    ),
  },
  discord: {
    label: 'Discord',
    icon: MessageSquare,
    fields: [
      {
        key: 'discordBotToken',
        label: 'Bot Token',
        placeholder: 'MTIz...',
        placeholderConfigured: 'Enter new token to replace',
      },
    ],
    configuredCheck: ch => ch.discord,
    help: (
      <>
        Get a token from the{' '}
        <a
          href="https://discord.com/developers/applications"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Discord Developer Portal
        </a>
        .
      </>
    ),
  },
  slack: {
    label: 'Slack',
    icon: Slack,
    fields: [
      {
        key: 'slackBotToken',
        label: 'Bot Token',
        placeholder: 'xoxb-...',
        placeholderConfigured: 'Enter new bot token to replace',
      },
      {
        key: 'slackAppToken',
        label: 'App Token',
        placeholder: 'xapp-...',
        placeholderConfigured: 'Enter new app token to replace',
      },
    ],
    configuredCheck: ch => ch.slackBot && ch.slackApp,
    help: (
      <>
        Get tokens from{' '}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Slack App Management
        </a>
        . Both Bot Token and App Token are required.
      </>
    ),
  },
};

export const CHANNEL_TYPES: ChannelType[] = ['telegram', 'discord', 'slack'];
