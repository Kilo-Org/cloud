// File-level row components for the PR diff FlashList.

import { ChevronDown, ChevronRight, File, Link2 } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { fileStatusIcon, fileStatusLabel } from '@/components/pr-review/diff/pr-diff-file-status';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

function ExpandChevron({ hasDiff, expanded }: { hasDiff: boolean; expanded: boolean }) {
  const colors = useThemeColors();
  if (!hasDiff) {
    return <View className="h-3 w-3" />;
  }
  if (expanded) {
    return <ChevronDown size={18} color={colors.mutedForeground} />;
  }
  return <ChevronRight size={18} color={colors.mutedForeground} />;
}

export function TruncationBannerRow({ text }: { text: string }) {
  return (
    <View className="mx-4 mt-3 rounded-lg border border-warn-tile-border bg-warn-tile-bg p-3">
      <Text className="text-sm text-foreground">{text}</Text>
    </View>
  );
}

export function FileHeaderRow({
  file,
  expanded,
  hasDiff,
  viewed,
  onToggleExpand,
  onToggleViewed,
}: {
  file: PrReviewFile;
  expanded: boolean;
  hasDiff: boolean;
  viewed: boolean;
  onToggleExpand: () => void;
  onToggleViewed: () => void;
}) {
  const colors = useThemeColors();
  const StatusIcon = fileStatusIcon(file.status);
  const isRename = Boolean(file.previousPath) && file.previousPath !== file.path;
  const pathLine = isRename ? `${file.previousPath} → ${file.path}` : file.path;

  return (
    <View className="border-b border-hair-soft bg-card px-4 py-3">
      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={hasDiff ? onToggleExpand : undefined}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Collapse file' : 'Expand file'}
          accessibilityState={{ expanded }}
          className="h-7 w-7 items-center justify-center"
        >
          <ExpandChevron hasDiff={hasDiff} expanded={expanded} />
        </Pressable>
        <StatusIcon size={14} color={colors.mutedForeground} />
        <View className="flex-1">
          <Text className="font-mono-medium text-sm text-foreground" numberOfLines={2}>
            {pathLine}
          </Text>
          <View className="mt-0.5 flex-row items-center gap-2">
            <Text variant="muted" className="text-xs">
              {fileStatusLabel(file.status)}
            </Text>
            <Text variant="muted" className="text-xs">
              +{file.additions}
            </Text>
            <Text variant="muted" className="text-xs">
              -{file.deletions}
            </Text>
          </View>
        </View>
        <ChoiceRow multi selected={viewed} onPress={onToggleViewed} className="min-h-9 px-1">
          <View className="flex-row items-center gap-1.5 pr-2">
            <Text variant="muted" className="text-xs">
              {viewed ? 'Viewed' : 'Mark viewed'}
            </Text>
          </View>
        </ChoiceRow>
      </View>
    </View>
  );
}

export function PatchMissingRow({
  file,
  viewed,
  githubUrl,
  onToggleViewed,
}: {
  file: PrReviewFile;
  viewed: boolean;
  githubUrl: string;
  onToggleViewed: () => void;
}) {
  const colors = useThemeColors();
  return (
    <View className="border-b border-hair-soft bg-secondary px-4 py-3">
      <View className="flex-row items-center gap-2">
        <File size={14} color={colors.mutedForeground} />
        <View className="flex-1">
          <Text className="text-sm text-foreground">Diff too large to display</Text>
          <Text variant="muted" className="text-xs">
            {file.path}
          </Text>
        </View>
        <ChoiceRow multi selected={viewed} onPress={onToggleViewed} className="min-h-9 px-1">
          <View className="flex-row items-center gap-1.5 pr-2">
            <Text variant="muted" className="text-xs">
              {viewed ? 'Viewed' : 'Mark viewed'}
            </Text>
          </View>
        </ChoiceRow>
      </View>
      <Pressable
        onPress={() => {
          if (githubUrl) {
            void openExternalUrl(githubUrl, { label: 'GitHub diff' });
          }
        }}
        accessibilityRole="link"
        accessibilityLabel="Open this file's diff on GitHub"
        className="mt-2 flex-row items-center gap-1.5 self-start"
      >
        <Link2 size={14} color={colors.info} />
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme info color */}
        <Text className="text-sm" style={{ color: colors.info }}>
          Open on GitHub
        </Text>
      </Pressable>
    </View>
  );
}
