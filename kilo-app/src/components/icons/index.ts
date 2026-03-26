import { AgentCardIcon } from './agentcard-icon';
import { BraveIcon } from './brave-icon';
import { DiscordIcon } from './discord-icon';
import { GitHubIcon } from './github-icon';
import { OnePasswordIcon } from './onepassword-icon';
import { SlackIcon } from './slack-icon';
import { TelegramIcon } from './telegram-icon';
import { type BrandIconComponent } from './types';

export { GmailIcon } from './gmail-icon';
export { GoogleIcon } from './google-icon';

/** Maps catalog entry IDs to brand icon components. */
export const CATALOG_ICONS: Partial<Record<string, BrandIconComponent>> = {
  telegram: TelegramIcon,
  discord: DiscordIcon,
  slack: SlackIcon,
  github: GitHubIcon,
  agentcard: AgentCardIcon,
  onepassword: OnePasswordIcon,
  'brave-search': BraveIcon,
};
