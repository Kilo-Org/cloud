import { type ReactElement } from 'react';
import { Cloud, Code, Terminal } from 'lucide-react-native';

import { GitHubIcon } from '@/components/icons/github-icon';
import { SlackIcon } from '@/components/icons/slack-icon';

type SessionPlatformIconKind = 'cloud' | 'terminal' | 'code' | 'slack' | 'github';

const PLATFORM_TO_KIND: Readonly<Record<string, SessionPlatformIconKind>> = {
  'cloud-agent': 'cloud',
  'cloud-agent-web': 'cloud',
  cli: 'terminal',
  vscode: 'code',
  'agent-manager': 'code',
  slack: 'slack',
  github: 'github',
};

/**
 * Map a backend `created_on_platform` string to a list/detail icon kind.
 * Unmapped / absent platforms return null so callers render nothing
 * (subtle-by-design — no wrong or generic glyph).
 */
export function sessionPlatformIconKind(
  platform: string | null | undefined
): SessionPlatformIconKind | null {
  if (platform == null || platform === '') {
    return null;
  }
  return PLATFORM_TO_KIND[platform] ?? null;
}

type SessionPlatformIconProps = Readonly<{
  platform: string | null | undefined;
  size: number;
  color: string;
}>;

/**
 * Pure renderer for the session-origin platform glyph. Returns null when
 * the platform is unmapped. No wrapper View, testID, or a11y props —
 * call sites own those.
 */
export function SessionPlatformIcon({
  platform,
  size,
  color,
}: SessionPlatformIconProps): ReactElement | null {
  const kind = sessionPlatformIconKind(platform);
  if (kind === 'cloud') {
    return <Cloud size={size} color={color} />;
  }
  if (kind === 'terminal') {
    return <Terminal size={size} color={color} />;
  }
  if (kind === 'code') {
    return <Code size={size} color={color} />;
  }
  if (kind === 'slack') {
    return <SlackIcon size={size} color={color} />;
  }
  if (kind === 'github') {
    return <GitHubIcon size={size} color={color} />;
  }
  return null;
}
