import {
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  type LucideIcon,
  Plus,
} from 'lucide-react-native';
import { View } from 'react-native';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type PrStateChipTone = 'good' | 'warn' | 'muted' | 'destructive';

type PrStateChipDescriptor = {
  label: string;
  tone: PrStateChipTone;
  icon: LucideIcon;
};

export function describePrState(args: {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
}): PrStateChipDescriptor {
  if (args.state === 'merged') {
    return { label: 'Merged', tone: 'muted', icon: GitMerge };
  }
  if (args.state === 'closed') {
    return { label: 'Closed', tone: 'muted', icon: GitPullRequest };
  }
  if (args.draft) {
    return { label: 'Draft', tone: 'muted', icon: GitPullRequest };
  }
  // state === 'open'
  if (args.reviewDecision === 'APPROVED') {
    return { label: 'Open · Approved', tone: 'good', icon: GitPullRequest };
  }
  if (args.reviewDecision === 'CHANGES_REQUESTED') {
    return { label: 'Open · Changes requested', tone: 'destructive', icon: GitPullRequest };
  }
  if (args.reviewDecision === 'REVIEW_REQUIRED') {
    return { label: 'Open · Review required', tone: 'warn', icon: GitPullRequest };
  }
  return { label: 'Open', tone: 'muted', icon: GitPullRequest };
}

// Theme colors are CSS variables — Tailwind opacity modifiers like
// `bg-good/10` don't work on them. The chip uses a flat muted background
// and lets the foreground color carry the tone so it stays legible in
// both themes without needing per-tone backgrounds.
const TONE_FG_CLASS: Record<PrStateChipTone, string> = {
  good: 'text-good',
  warn: 'text-warn',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

export function PrStateChip({ descriptor }: Readonly<{ descriptor: PrStateChipDescriptor }>) {
  const Icon = descriptor.icon;
  return (
    <View className="flex-row items-center gap-1.5 self-start rounded-full bg-secondary px-2.5 py-1">
      <Icon size={12} className={TONE_FG_CLASS[descriptor.tone]} />
      <Text className={cn('text-xs font-medium', TONE_FG_CLASS[descriptor.tone])}>
        {descriptor.label}
      </Text>
    </View>
  );
}

export function PrAuthorRow({
  author,
}: Readonly<{ author: { login: string; avatarUrl: string | null } | null }>) {
  if (!author) {
    return (
      <View className="flex-row items-center gap-2">
        <View className="size-6 rounded-full bg-muted" />
        <Text variant="muted" className="text-sm">
          Unknown author
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
  return (
    <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
      <View className="flex-row items-center gap-1.5">
        <GitCommit size={14} color={colors.mutedForeground} />
        <Text variant="muted" className="text-sm">
          {commits.toLocaleString()} {commits === 1 ? 'commit' : 'commits'}
        </Text>
      </View>
      <View className="flex-row items-center gap-1.5">
        <GitPullRequest size={14} color={colors.mutedForeground} />
        <Text variant="muted" className="text-sm">
          {changedFiles.toLocaleString()} {changedFiles === 1 ? 'file' : 'files'}
        </Text>
      </View>
      <View className="flex-row items-center gap-1.5">
        <Plus size={14} color={colors.good} />
        <Text className="text-sm text-good">{additions.toLocaleString()}</Text>
        <Text variant="muted" className="text-sm">
          / −{deletions.toLocaleString()}
        </Text>
      </View>
    </View>
  );
}

function localizeNumber(n: number): string {
  return n.toLocaleString();
}

export function formatPrCounts(additions: number, deletions: number): string {
  return `+${localizeNumber(additions)} / −${localizeNumber(deletions)}`;
}
