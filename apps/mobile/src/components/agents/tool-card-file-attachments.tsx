import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { FileIcon, Share2 } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import {
  getShareRemoteFileReason,
  shareLocalFile,
  ShareRemoteFileError,
} from '@/lib/share-remote-file';

import { getToolFileAttachments } from './tool-card-attachments';
import { isToolCardImagePending, useToolCardImageUri } from './tool-card-image-cache';

/**
 * The share control's own box: 28 dp clears the platform minimum target, and
 * `SHARE_CONTROL_HIT_SLOP` lifts the touch region to the 44 dp minimum without
 * widening the box, so the filename keeps its width. The hidden pending
 * placeholder reuses this frame, so the name's truncation point is the same
 * before and after the cache write lands.
 */
const SHARE_CONTROL_FRAME = 'min-h-8 min-w-8 shrink-0 items-center justify-center rounded';
const SHARE_CONTROL_HIT_SLOP = 8;

/**
 * One row frame for every cache state, so a row that starts unavailable keeps
 * the height and inset of the row whose bytes land later.
 */
const CHIP_ROW_CLASS =
  'flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900';

function FileChip({
  label,
  mime,
  partId,
}: Readonly<{
  label: string;
  mime: string;
  partId: string;
}>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const uri = useToolCardImageUri(partId);
  const pending = uri === undefined && isToolCardImagePending(partId);

  // One row body for every cache state: the filename keeps its line, and the
  // subtitle names either the mime type or why the bytes are missing.
  function renderRowBody(subtitle: string) {
    return (
      <>
        <FileIcon size={16} color={colors.mutedForeground} />
        <View className="flex-1">
          <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
            {label}
          </Text>
          <Text className="text-xs text-muted-foreground">{subtitle}</Text>
        </View>
      </>
    );
  }

  if (uri === undefined && !pending) {
    // The row keeps its normal height and icon size so a missing cache entry
    // reads as one more file row, not as a broken card: only the share control
    // is absent, because there is no local file to hand to the platform.
    return (
      <View className={CHIP_ROW_CLASS}>
        {renderRowBody(t('agentChat.filePart.fileUnavailableInSession'))}
      </View>
    );
  }

  if (uri === undefined) {
    // The body is still being written. The share control's box stays in the
    // row at its real width while it is hidden, so the filename's truncation
    // point does not move when the write resolves.
    return (
      <View
        className={CHIP_ROW_CLASS}
        accessible
        accessibilityRole="text"
        accessibilityState={{ busy: true }}
      >
        {renderRowBody(mime)}
        <View
          className={cn(SHARE_CONTROL_FRAME, 'opacity-0')}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Share2 size={16} color={colors.mutedForeground} />
        </View>
      </View>
    );
  }

  const fileUri = uri;

  async function handleShare() {
    try {
      await shareLocalFile(fileUri, { mimeType: mime });
    } catch (error: unknown) {
      const reason = getShareRemoteFileReason(error);
      if (reason === 'sharing-unavailable') {
        toast.error(t('agentChat.filePart.sharingUnavailable'));
        return;
      }
      if (error instanceof ShareRemoteFileError) {
        toast.error(t('agentChat.filePart.shareFailedRetry'));
        return;
      }
      toast.error(t('agentChat.filePart.shareFailed'));
    }
  }

  return (
    <View className={CHIP_ROW_CLASS}>
      {renderRowBody(mime)}
      <Pressable
        className={cn(SHARE_CONTROL_FRAME, 'active:opacity-60')}
        hitSlop={SHARE_CONTROL_HIT_SLOP}
        onPress={() => {
          void handleShare();
        }}
        accessibilityRole="button"
        accessibilityLabel={t('common.share', { title: label })}
      >
        <Share2 size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

export function ToolCardFileAttachments({ part }: Readonly<{ part: ToolPart }>) {
  const { t } = useTranslation();
  const attachments = getToolFileAttachments(part);
  if (attachments.length === 0) {
    return null;
  }

  // Render only the first non-image attachment: the cache keeps the first
  // attachment's bytes per part id (see tool-card-image-cache.ts). A second
  // chip would share the first file's bytes under the second file's name and
  // would duplicate the unavailable row on a cache miss.
  const first = attachments[0];
  if (!first) {
    return null;
  }

  // i18n-dup-ok: prReview.overview.file_* is a numeral count unit ('1 file'), which
  // languages inflect by number; this key is the standalone noun label.
  const label = first.filename ?? t('common.file');

  return (
    <View className="gap-2">
      <FileChip label={label} mime={first.mime} partId={part.id} />
    </View>
  );
}
