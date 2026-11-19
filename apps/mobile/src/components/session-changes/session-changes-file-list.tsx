// The session's changed files: one row per file with its status and line
// counts, and a pull-to-refresh that asks the session for a fresh capture.

import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { RowsRefreshControl } from '@/components/agents/rows-refresh-control';
import { TruncationBannerRow } from '@/components/pr-review/diff/pr-diff-file-rows';
import { fileStatusIcon, fileStatusLabel } from '@/components/pr-review/diff/pr-diff-file-status';
import { RowChevron } from '@/components/ui/row-chevron';
import { Text } from '@/components/ui/text';
import { isolateLtrBidiText } from '@/lib/bidi';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';
import { type SessionChangesFile, sessionChangesFileKey } from '@/lib/session-changes-review';

/** A worktree file's status uses the diff vocabulary; `deleted` reads as `removed`. */
function fileStatusForLabel(status: SessionChangesFile['status']): string {
  return status === 'deleted' ? 'removed' : status;
}

function SessionChangesFileRow({
  file,
  onOpen,
}: Readonly<{ file: SessionChangesFile; onOpen: (file: SessionChangesFile) => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const StatusIcon = fileStatusIcon(fileStatusForLabel(file.status));
  const statusLabel = fileStatusLabel(fileStatusForLabel(file.status));
  return (
    <Pressable
      onPress={() => {
        onOpen(file);
      }}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.sessionChanges.openFile', {
        path: file.path,
        status: statusLabel,
        // A partial capture: the numbers are a floor, never an exact count.
        additions: file.countsComplete ? file.additions : `~${file.additions}`,
        deletions: file.countsComplete ? file.deletions : `~${file.deletions}`,
      })}
      className="flex-row items-center gap-2 border-b-[0.5px] border-hair-soft px-4 py-3 active:opacity-70"
      testID="session-changes-file-row"
    >
      <StatusIcon size={14} color={colors.mutedForeground} />
      <View className="flex-1">
        <Text variant="mono" numberOfLines={2}>
          {isolateLtrBidiText(file.path)}
        </Text>
        <View className="mt-0.5 flex-row items-center gap-2">
          <Text variant="caption">{statusLabel}</Text>
          {file.countsComplete ? (
            <>
              <Text variant="caption">{isolateLtrBidiText(`+${file.additions}`)}</Text>
              <Text variant="caption">{isolateLtrBidiText(`-${file.deletions}`)}</Text>
            </>
          ) : (
            <Text variant="caption">{t('agentChat.sessionChanges.partialCounts')}</Text>
          )}
          {file.binary ? (
            <Text variant="caption">{t('agentChat.sessionChanges.binaryFile')}</Text>
          ) : null}
        </View>
      </View>
      <RowChevron />
    </Pressable>
  );
}

export function SessionChangesFileList({
  files,
  truncated,
  refreshing,
  onRefresh,
  onOpen,
}: Readonly<{
  files: SessionChangesFile[];
  truncated: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (file: SessionChangesFile) => void;
}>) {
  const { t } = useTranslation();
  const bottomPadding = useDetailScreenBottomPadding();
  return (
    <FlashList
      data={files}
      keyExtractor={sessionChangesFileKey}
      renderItem={({ item }) => <SessionChangesFileRow file={item} onOpen={onOpen} />}
      ListHeaderComponent={
        truncated ? <TruncationBannerRow text={t('agentChat.sessionChanges.truncated')} /> : null
      }
      contentContainerStyle={{ paddingBottom: bottomPadding }}
      refreshControl={
        <RowsRefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          testID="session-changes-refresh"
        />
      }
      testID="session-changes-file-list"
    />
  );
}
