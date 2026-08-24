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
} from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';
import { openExternalUrl } from '@/lib/external-link';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { resolveSessionPrTapTarget } from '@/lib/session-pr-navigation';
import { cn } from '@/lib/utils';

import {
  describePrBadge,
  type PrBadgeAccent,
  type PrBadgeIconKind,
} from './session-pr-badge-model';

const ICON_BY_KIND = {
  check: CircleCheck,
  x: CircleX,
  'pull-request': GitPullRequest,
  draft: GitPullRequestDraft,
  merge: GitMerge,
  closed: GitPullRequestClosed,
} satisfies Readonly<Record<PrBadgeIconKind, LucideIcon>>;

const ACCENT_TEXT_CLASS = {
  good: 'text-good',
  warn: 'text-warn',
  muted: 'text-muted-foreground',
  destructive: 'text-destructive',
} satisfies Readonly<Record<PrBadgeAccent, string>>;

const ACCENT_COLOR_KEY = {
  good: 'good',
  warn: 'warn',
  muted: 'mutedForeground',
  destructive: 'destructive',
} satisfies Readonly<Record<PrBadgeAccent, keyof ThemeColors>>;

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
export function SessionPrBadge(props: SessionPrBadgeProps) {
  const { loading } = props;
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);

  if (loading) {
    return <Skeleton className="h-5 w-[52px] rounded-full" />;
  }
  if (!props.pr) {
    return null;
  }
  const pr = props.pr;

  const descriptor = describePrBadge({
    state: pr.state,
    number: pr.number,
    reviewDecision: pr.reviewDecision,
    reviewDecisionPending: pr.reviewDecisionPending,
  });
  const Icon = ICON_BY_KIND[descriptor.icon];

  function handlePress() {
    // Flag off: GitHub taps fall back to the browser (same as chat links).
    if (!prReviewEnabled) {
      void openExternalUrl(pr.url, { label: t('agentChat.prBadge.externalLinkLabel') });
      return;
    }
    const target = resolveSessionPrTapTarget({
      url: pr.url,
      number: pr.number,
    });
    if (target.kind === 'in-app') {
      router.push(target.href);
      return;
    }
    void openExternalUrl(target.url, { label: t('agentChat.prBadge.externalLinkLabel') });
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
          #{pr.number}
        </Text>
      </View>
    </Pressable>
  );
}
