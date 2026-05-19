import type { ComponentType } from 'react';
import { SlackIcon } from './icons/SlackIcon';
import { DiscordIcon } from './icons/DiscordIcon';
import { GitHubIcon } from './icons/GitHubIcon';
import { LinearIcon } from './icons/LinearIcon';
import { GitLabIcon } from './icons/GitLabIcon';
import { MicrosoftTeamsIcon } from './icons/MicrosoftTeamsIcon';
import { GoogleChatIcon } from './icons/GoogleChatIcon';

export type PlatformId =
  | 'slack'
  | 'discord'
  | 'microsoft-teams'
  | 'google-chat'
  | 'github'
  | 'linear'
  | 'gitlab';

export type PlatformOption = {
  id: PlatformId;
  name: string;
  icon: ComponentType<{ className?: string }>;
  connectionType: string;
  description: string;
};

export const CHAT_PLATFORM_IDS = new Set<PlatformId>([
  'slack',
  'discord',
  'microsoft-teams',
  'google-chat',
]);

export const CODE_PLATFORM_IDS = new Set<PlatformId>(['github', 'gitlab']);

export const ALL_PLATFORMS: PlatformOption[] = [
  {
    id: 'slack',
    name: 'Slack',
    icon: SlackIcon,
    connectionType: 'Chat',
    description: 'Mention Kilo from Slack channels and threads.',
  },
  {
    id: 'discord',
    name: 'Discord',
    icon: DiscordIcon,
    connectionType: 'Chat',
    description: 'Start Kilo work from Discord servers and channels.',
  },
  {
    id: 'microsoft-teams',
    name: 'Microsoft Teams',
    icon: MicrosoftTeamsIcon,
    connectionType: 'Chat',
    description: 'Bring Kilo into the Teams spaces your organization uses.',
  },
  {
    id: 'google-chat',
    name: 'Google Chat',
    icon: GoogleChatIcon,
    connectionType: 'Chat',
    description: 'Use Kilo from Google Chat spaces and direct messages.',
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: GitHubIcon,
    connectionType: 'Code and issues',
    description: 'Read repositories, open pull requests, and link GitHub issues.',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    icon: GitLabIcon,
    connectionType: 'Code and issues',
    description: 'Connect repositories and merge requests from GitLab.',
  },
  {
    id: 'linear',
    name: 'Linear',
    icon: LinearIcon,
    connectionType: 'Issues',
    description: 'Attach Kilo sessions to Linear issues and product context.',
  },
];

export const ALL_PLATFORM_IDS: ReadonlySet<string> = new Set(ALL_PLATFORMS.map(p => p.id));

export function getPlatform(id: PlatformId): PlatformOption | undefined {
  return ALL_PLATFORMS.find(p => p.id === id);
}
