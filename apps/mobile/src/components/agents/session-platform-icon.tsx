import { type ReactElement } from 'react';
import { Cloud, Code, Terminal } from '@/components/ui/icons';

import { GitHubIcon } from '@/components/icons/github-icon';
import { SlackIcon } from '@/components/icons/slack-icon';
import { repoNameFromGitUrl } from './session-list-helpers';

type SessionPlatformIconKind = 'cloud' | 'terminal' | 'code' | 'slack' | 'github';

const PLATFORM_TO_KIND = {
  'cloud-agent': 'cloud',
  'cloud-agent-web': 'cloud',
  cli: 'terminal',
  vscode: 'code',
  'agent-manager': 'code',
  slack: 'slack',
  github: 'github',
} satisfies Record<string, SessionPlatformIconKind>;

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
  return Object.hasOwn(PLATFORM_TO_KIND, platform)
    ? PLATFORM_TO_KIND[platform as keyof typeof PLATFORM_TO_KIND]
    : null;
}

type RowPlatformPresentationInput = Readonly<{
  platform: string | null | undefined;
  variant: 'list' | 'card';
  needsInput: boolean;
  gitUrl: string | null | undefined;
}>;

type RowPlatformPresentation = Readonly<{
  iconKind: SessionPlatformIconKind | null;
  spokenPlatform: string | undefined;
}>;

/**
 * Shared list/card platform glyph + VoiceOver rule for stored and live rows.
 * Icon only for `variant === 'list'` with a mapped platform. Platform is
 * spoken only when an icon is shown, the row is not needs-input, and the
 * eyebrow is a repo name (so the badge does not already speak the platform).
 */
export function selectRowPlatformPresentation({
  platform,
  variant,
  needsInput,
  gitUrl,
}: RowPlatformPresentationInput): RowPlatformPresentation {
  const iconKind = variant === 'list' ? sessionPlatformIconKind(platform) : null;
  const spokenPlatform =
    iconKind != null && !needsInput && repoNameFromGitUrl(gitUrl) != null
      ? (platform ?? undefined)
      : undefined;
  return {
    iconKind,
    spokenPlatform: spokenPlatform === '' ? undefined : spokenPlatform,
  };
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
