import { type AssociatedPrData } from '@kilocode/cloud-agent-sdk';
import { useRouter } from 'expo-router';
import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors, type ThemeColors } from '@/lib/hooks/use-theme-colors';
import { resolveSessionPrTapTarget } from '@/lib/session-pr-navigation';
import { cn } from '@/lib/utils';

import {
  describePrBadge,
  type PrBadgeAccent,
  type PrBadgeIconKind,
} from './session-pr-badge-model';

const ICON_BY_KIND: Readonly<Record<PrBadgeIconKind, LucideIcon>> = {
  check: CircleCheck,
  x: CircleX,
  'pull-request': GitPullRequest,
  draft: GitPullRequestDraft,
  merge: GitMerge,
  closed: GitPullRequestClosed,
};

const ACCENT_TEXT_CLASS: Readonly<Record<PrBadgeAccent, string>> = {
  good: 'text-good',
  warn: 'text-warn',
  muted: 'text-muted-foreground',
  destructive: 'text-destructive',
};

const ACCENT_COLOR_KEY: Readonly<Record<PrBadgeAccent, keyof ThemeColors>> = {
  good: 'good',
  warn: 'warn',
  muted: 'mutedForeground',
  destructive: 'destructive',
};

export type SessionPrBadgeProps = Readonly<{
  pr: AssociatedPrData | null;
  loading: boolean;
}>;

/**
 * Compact pill summarizing the PR associated with a session.
 *
 * Shows `#N` with an icon/accent derived from the PR state and review
 * decision. While `loading` is true it reserves a fixed-width skeleton; after
 * the fetch it renders the badge or nothing (never a guess from `git_branch`).
 * Tapping navigates in-app for GitHub PRs and opens the browser otherwise.
 */
export function SessionPrBadge({ pr, loading }: SessionPrBadgeProps) {
  const router = useRouter();
  const colors = useThemeColors();

  if (loading) {
    return <Skeleton className="h-5 w-[52px] rounded-full" />;
  }
  if (!pr) {
    return null;
  }

  const prData = pr;
  const descriptor = describePrBadge({
    state: prData.state,
    number: prData.number,
    reviewDecision: prData.reviewDecision,
    reviewDecisionPending: prData.reviewDecisionPending,
  });
  const Icon = ICON_BY_KIND[descriptor.icon];

  function handlePress() {
    const target = resolveSessionPrTapTarget({
      platform: prData.platform,
      url: prData.url,
      number: prData.number,
    });
    if (target.kind === 'in-app') {
      router.push(target.href);
      return;
    }
    void openExternalUrl(target.url, { label: 'pull request' });
  }

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={descriptor.accessibilityLabel}
      className="active:opacity-70"
    >
      <View className="flex-row items-center gap-1 rounded-full bg-secondary py-0.5 pl-1.5 pr-2">
        <Icon size={12} color={colors[ACCENT_COLOR_KEY[descriptor.accent]]} />
        <Text
          className={cn('text-xs font-medium tabular-nums', ACCENT_TEXT_CLASS[descriptor.accent])}
        >
          #{prData.number}
        </Text>
      </View>
    </Pressable>
  );
}
