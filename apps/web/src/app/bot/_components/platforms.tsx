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
};

export type CategoryId = 'chat' | 'code' | 'issues';

export type Category = {
  id: CategoryId;
  step: number;
  eyebrow: string;
  title: string;
  hint: string;
  options: PlatformOption[];
};

const ALL_PLATFORMS: PlatformOption[] = [
  { id: 'slack', name: 'Slack', icon: SlackIcon },
  { id: 'discord', name: 'Discord', icon: DiscordIcon },
  { id: 'microsoft-teams', name: 'Microsoft Teams', icon: MicrosoftTeamsIcon },
  { id: 'google-chat', name: 'Google Chat', icon: GoogleChatIcon },
  { id: 'github', name: 'GitHub', icon: GitHubIcon },
  { id: 'gitlab', name: 'GitLab', icon: GitLabIcon },
  { id: 'linear', name: 'Linear', icon: LinearIcon },
];

export function getPlatform(id: PlatformId): PlatformOption | undefined {
  return ALL_PLATFORMS.find(p => p.id === id);
}

export const CATEGORIES: Category[] = [
  {
    id: 'chat',
    step: 1,
    eyebrow: 'Step 1 of 3',
    title: 'Where will you talk to Kilo?',
    hint: 'Pick the workspace you live in. Kilo will listen for mentions there.',
    options: [
      { id: 'slack', name: 'Slack', icon: SlackIcon },
      { id: 'discord', name: 'Discord', icon: DiscordIcon },
      { id: 'microsoft-teams', name: 'Microsoft Teams', icon: MicrosoftTeamsIcon },
      { id: 'google-chat', name: 'Google Chat', icon: GoogleChatIcon },
      { id: 'github', name: 'GitHub', icon: GitHubIcon },
      { id: 'linear', name: 'Linear', icon: LinearIcon },
    ],
  },
  {
    id: 'code',
    step: 2,
    eyebrow: 'Step 2 of 3',
    title: 'Where does your code live?',
    hint: 'Connect the host that owns the repos Kilo will read and open PRs against.',
    options: [
      { id: 'github', name: 'GitHub', icon: GitHubIcon },
      { id: 'gitlab', name: 'GitLab', icon: GitLabIcon },
    ],
  },
  {
    id: 'issues',
    step: 3,
    eyebrow: 'Step 3 of 3',
    title: 'Where do you track work?',
    hint: 'Kilo links sessions to issues so the trail back to product context stays clean.',
    options: [
      { id: 'linear', name: 'Linear', icon: LinearIcon },
      { id: 'github', name: 'GitHub', icon: GitHubIcon },
      { id: 'gitlab', name: 'GitLab', icon: GitLabIcon },
    ],
  },
];
