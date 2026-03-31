import type React from 'react';
import type { SecretIconKey } from '@kilocode/kiloclaw-secret-catalog';
import { Key, Lock } from 'lucide-react';
import { TelegramIcon } from './icons/TelegramIcon';
import { DiscordIcon } from './icons/DiscordIcon';
import { SlackIcon } from './icons/SlackIcon';
import { GitHubIcon } from './icons/GitHubIcon';
import { AgentCardIcon } from './icons/AgentCardIcon';
import { BraveSearchIcon } from './icons/BraveSearchIcon';
import { LinearIcon } from './icons/LinearIcon';

const ICON_MAP: Record<SecretIconKey, React.ComponentType<{ className?: string }>> = {
  send: TelegramIcon,
  discord: DiscordIcon,
  slack: SlackIcon,
  key: Key,
  github: GitHubIcon,
  linear: LinearIcon,
  'credit-card': AgentCardIcon,
  lock: Lock,
  brave: BraveSearchIcon,
};

export function getIcon(iconKey: SecretIconKey): React.ComponentType<{ className?: string }> {
  return ICON_MAP[iconKey];
}

/** Short descriptions for each secret entry, shown in the collapsed accordion header. */
const DESCRIPTION_MAP: Record<string, string> = {
  telegram: 'Connect your Telegram bot',
  discord: 'Connect your Discord bot',
  slack: 'Connect your Slack workspace',
  github: 'Connect a GitHub account for code operations',
  linear: 'Connect your Linear account for issue tracking',
  agentcard: 'Give your bot virtual debit cards for spending',
  onepassword: 'Look up credentials and manage vault items via the op CLI',
  'brave-search': 'Add a Brave Search API key for web search',
};

export function getDescription(entryId: string): string {
  return DESCRIPTION_MAP[entryId] ?? '';
}
