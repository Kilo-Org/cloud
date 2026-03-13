import type React from 'react';
import type { SecretIconKey } from '@kilocode/kiloclaw-secret-catalog';
import { Send, Slack, Key, Github } from 'lucide-react';
import { DiscordIcon } from './icons/DiscordIcon';

const ICON_MAP: Record<SecretIconKey, React.ComponentType<{ className?: string }>> = {
  send: Send,
  discord: DiscordIcon,
  slack: Slack,
  key: Key,
  github: Github,
};

export function getIcon(iconKey: SecretIconKey): React.ComponentType<{ className?: string }> {
  return ICON_MAP[iconKey];
}
