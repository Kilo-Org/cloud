import {
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  type LucideIcon,
  Plus,
} from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type PrStateChipTone = 'good' | 'warn' | 'muted' | 'destructive';

type PrStateChipLabelKey =
  | 'prReview.overview.stateMerged'
  | 'prReview.overview.stateClosed'
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
    return { labelKey: 'prReview.overview.stateClosed', tone: 'muted', icon: GitPullRequest };
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

// Theme colors are CSS variables — Tailwind opacity modifiers like
// `bg-good/10` don't work on them. The chip uses a flat muted background
// and lets the foreground color carry the tone so it stays legible in
// both themes without needing per-tone backgrounds.
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

export function PrAuthorRow({
  author,
}: Readonly<{ author: { login: string; avatarUrl: string | null } | null }>) {
  const { t } = useTranslation();
  if (!author) {
    return (
      <View className="flex-row items-center gap-2">
        <View className="size-6 rounded-full bg-muted" />
        <Text variant="muted" className="text-sm">
          {t('prReview.overview.unknownAuthor')}
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-row items-center gap-2">
      {author.avatarUrl ? (
        <Image
          source={{ uri: author.avatarUrl }}
          className="size-6 rounded-full"
          transition={0}
          cachePolicy="memory"
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View className="size-6 rounded-full bg-muted" />
      )}
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
      <Text variant="mono" className="text-[13px]" numberOfLines={1} ellipsizeMode="middle">
        {headRepoFullName && isCrossRepo ? `${headRepoFullName}:` : ''}
        {headRef}
      </Text>
      <Text variant="muted" className="text-sm">
        ←
      </Text>
      <Text variant="mono" className="text-[13px]" numberOfLines={1} ellipsizeMode="middle">
        {baseRef}
      </Text>
    </View>
  );
}

export function PrCountsLine({
  commits,
  changedFiles,
  additions,
  deletions,
}: Readonly<{
  commits: number;
  changedFiles: number;
  additions: number;
  deletions: number;
}>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
      <View className="flex-row items-center gap-1.5">
        <GitCommit size={14} color={colors.mutedForeground} />
        <Text variant="muted" className="text-sm">
          {formatNumber(commits, i18n.language)} {t('prReview.overview.commit', { count: commits })}
        </Text>
      </View>
      <View className="flex-row items-center gap-1.5">
        <GitPullRequest size={14} color={colors.mutedForeground} />
        <Text variant="muted" className="text-sm">
          {formatNumber(changedFiles, i18n.language)}{' '}
          {t('prReview.overview.file', { count: changedFiles })}
        </Text>
      </View>
      <View className="flex-row items-center gap-1.5">
        <Plus size={14} color={colors.good} />
        <Text className="text-sm text-good">{formatNumber(additions, i18n.language)}</Text>
        <Text variant="muted" className="text-sm">
          / −{formatNumber(deletions, i18n.language)}
        </Text>
      </View>
    </View>
  );
}

function localizeNumber(n: number): string {
  return formatNumber(n, i18n.language);
}

export function formatPrCounts(additions: number, deletions: number): string {
  return `+${localizeNumber(additions)} / −${localizeNumber(deletions)}`;
}
