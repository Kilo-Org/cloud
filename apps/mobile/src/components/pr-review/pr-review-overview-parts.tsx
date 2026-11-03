import {
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  type LucideIcon,
  UserRound,
} from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { DirectionalArrowLeft } from '@/components/ui/directional-icons';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { isolateLtrBidiText } from '@/lib/bidi';
import { formatNumber } from '@/lib/format';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type PrStateChipTone = 'good' | 'warn' | 'muted' | 'destructive';

type PrStateChipLabelKey =
  | 'prReview.overview.stateMerged'
  | 'common.closed'
  | 'common.draft'
  | 'prReview.overview.stateOpenApproved'
  | 'prReview.overview.stateOpenChangesRequested'
  | 'prReview.overview.stateOpenReviewRequired'
  | 'prReview.overview.stateOpen';

type PrStateChipDescriptor = {
  labelKey: PrStateChipLabelKey;
  tone: PrStateChipTone;
  icon: LucideIcon;
};

export function describePrState(args: {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
}): PrStateChipDescriptor {
  if (args.state === 'merged') {
    return { labelKey: 'prReview.overview.stateMerged', tone: 'muted', icon: GitMerge };
  }
  if (args.state === 'closed') {
    return { labelKey: 'common.closed', tone: 'muted', icon: GitPullRequest };
  }
  if (args.draft) {
    return { labelKey: 'common.draft', tone: 'muted', icon: GitPullRequest };
  }
  // state === 'open'
  if (args.reviewDecision === 'APPROVED') {
    return { labelKey: 'prReview.overview.stateOpenApproved', tone: 'good', icon: GitPullRequest };
  }
  if (args.reviewDecision === 'CHANGES_REQUESTED') {
    return {
      labelKey: 'prReview.overview.stateOpenChangesRequested',
      tone: 'destructive',
      icon: GitPullRequest,
    };
  }
  if (args.reviewDecision === 'REVIEW_REQUIRED') {
    return {
      labelKey: 'prReview.overview.stateOpenReviewRequired',
      tone: 'warn',
      icon: GitPullRequest,
    };
  }
  return { labelKey: 'prReview.overview.stateOpen', tone: 'muted', icon: GitPullRequest };
}

// Theme colors are CSS variables, so Tailwind opacity modifiers on them are
// silently dropped. The chip uses a flat muted background and lets the
// foreground color carry the tone so it stays legible in both themes
// without needing per-tone backgrounds.
const TONE_FG_CLASS = {
  good: 'text-good',
  warn: 'text-warn',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
} satisfies Record<PrStateChipTone, string>;

// Lucide icons do not take a `className` color, so the icon reads its tone
// from the theme color token instead of a Tailwind text class.
const TONE_FG_COLOR = {
  good: 'good',
  warn: 'warn',
  destructive: 'destructive',
  muted: 'mutedForeground',
} satisfies Record<PrStateChipTone, keyof ThemeColors>;

export function PrStateChip({ descriptor }: Readonly<{ descriptor: PrStateChipDescriptor }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const Icon = descriptor.icon;
  return (
    <View className="flex-row items-center gap-1.5 self-start rounded-full bg-secondary px-2.5 py-1">
      <Icon size={12} color={colors[TONE_FG_COLOR[descriptor.tone]]} />
      <Text className={cn('text-xs font-medium', TONE_FG_CLASS[descriptor.tone])}>
        {t(descriptor.labelKey)}
      </Text>
    </View>
  );
}

/**
 * A GitHub account's avatar at the size every PR-review row uses. Falls back to
 * the account's initial on a filled disc when GitHub reports no avatar, so a
 * row without a picture still reads as a person instead of an empty circle.
 * The fallback is decoration: the login beside it is the text a reader gets, so
 * the disc stays out of both accessibility trees instead of adding a lone
 * initial to a row that is announced as one element.
 */
export function PrAvatar({
  avatarUrl,
  login,
}: Readonly<{ avatarUrl: string | null; login: string | null }>) {
  const colors = useThemeColors();
  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        className="size-6 rounded-full"
        transition={0}
        cachePolicy="memory"
        accessibilityIgnoresInvertColors
      />
    );
  }
  const initial = login?.trim().charAt(0).toLocaleUpperCase(i18n.language);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="size-6 items-center justify-center rounded-full bg-secondary-fill"
    >
      {initial ? (
        <Text className="text-[11px] font-semibold text-secondary-foreground">{initial}</Text>
      ) : (
        <UserRound size={12} color={colors.secondaryForeground} />
      )}
    </View>
  );
}

export function PrAuthorRow({
  author,
}: Readonly<{ author: { login: string; avatarUrl: string | null } | null }>) {
  const { t } = useTranslation();
  if (!author) {
    return (
      <View className="flex-row items-center gap-2">
        <PrAvatar avatarUrl={null} login={null} />
        <Text variant="muted" className="text-sm">
          {t('prReview.overview.unknownAuthor')}
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-row items-center gap-2">
      <PrAvatar avatarUrl={author.avatarUrl} login={author.login} />
      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
        {author.login}
      </Text>
    </View>
  );
}

export function PrRefsRow({
  baseRef,
  headRef,
  headRepoFullName,
  isCrossRepo,
}: Readonly<{
  baseRef: string;
  headRef: string;
  headRepoFullName: string | null;
  isCrossRepo: boolean;
}>) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-2">
      <GitBranch size={14} color={colors.mutedForeground} />
      {/* The head ref is the row's flexible value: it shrinks so it ellipsizes
          instead of running past the screen edge, while the short base ref
          keeps its full width. `min-w-0` lets the text go below its content
          width; without it the row overflows and hard-clips. */}
      <Text
        variant="mono"
        className="min-w-0 shrink text-[13px]"
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {headRepoFullName && isCrossRepo ? `${headRepoFullName}:` : ''}
        {headRef}
      </Text>
      {/* The flow reads "head ← base": a mirrored arrow icon sized to the
          13 px ref text, so its ink centers on the row instead of sitting on
          the baseline of a text glyph. */}
      <DirectionalArrowLeft size={13} color={colors.mutedForeground} />
      <Text
        variant="mono"
        className="max-w-1/2 shrink-0 text-[13px]"
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {baseRef}
      </Text>
    </View>
  );
}

export function PrCountsLine({
  commits,
  changedFiles,
}: Readonly<{
  /** Null where the provider reports no commit count; the chip is dropped. */
  commits: number | null;
  changedFiles: number;
}>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
      {commits === null ? null : (
        <View className="flex-row items-center gap-1.5">
          <GitCommit size={14} color={colors.mutedForeground} />
          <Text variant="muted" className="text-sm">
            {formatNumber(commits, i18n.language)}{' '}
            {t('prReview.overview.commit', { count: commits })}
          </Text>
        </View>
      )}
      <View className="flex-row items-center gap-1.5">
        <GitPullRequest size={14} color={colors.mutedForeground} />
        <Text variant="muted" className="text-sm">
          {formatNumber(changedFiles, i18n.language)}{' '}
          {t('prReview.overview.file', { count: changedFiles })}
        </Text>
      </View>
    </View>
  );
}

function localizeNumber(n: number): string {
  return formatNumber(n, i18n.language);
}

/**
 * The added/removed counts as one left-to-right run. Without the isolate, bidi
 * on a right-to-left screen moves each sign behind its number, so the line
 * reads "3+ / 1−" and the counts look like they added the sign.
 */
export function formatPrCounts(additions: number, deletions: number): string {
  return isolateLtrBidiText(`+${localizeNumber(additions)} / −${localizeNumber(deletions)}`);
}
