import { Platform, Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import { AlertCircle, File as FileIcon, RotateCcw, X } from '@/components/ui/icons';
import { type QueuedAttachment } from '@kilocode/kilo-chat-hooks';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatFileSize, formatPercent } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { isImageMimeType } from './message-attachment-state';

type Props = {
  row: QueuedAttachment;
  localUri: string | null;
  onRemove: () => void;
  onRetry: () => void;
};

/**
 * Retry and Remove render a visible `h-7 w-7` badge. Tailwind's `h-7` is
 * 1.75rem, and NativeWind renders 1rem as 14 on native (react-native-css
 * `rem: 14`), so the badge measures 24.5pt — not the 28pt the 4px spacing scale
 * implies. The hitSlop is derived from that real size, otherwise the effective
 * target falls short of the platform minimum (measured 24.5 + 2x10 = 44.5dp on
 * Android, below 48dp).
 */
const ATTACHMENT_CONTROL_BADGE_SIZE = 7 * 0.25 * 14;

/**
 * Reach the platform minimum touch target through hitSlop. Read at render time
 * so it follows the platform, never captured once at module load.
 */
function controlHitSlop() {
  const minimum = Platform.OS === 'android' ? 48 : 44;
  const slop = Math.ceil((minimum - ATTACHMENT_CONTROL_BADGE_SIZE) / 2);
  return { top: slop, bottom: slop, left: slop, right: slop };
}

export function MessageAttachmentPreviewChip({ row, localUri, onRemove, onRetry }: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const isImage = isImageMimeType(row.mimeType);
  const failed = row.status === 'failed';
  const uploading = row.status === 'uploading';

  function renderLeadingIcon() {
    if (failed) {
      return <AlertCircle size={14} color={colors.destructive} />;
    }
    if (uploading) {
      return <ActivityIndicator size="small" color={colors.mutedForeground} />;
    }
    return <FileIcon size={14} color={colors.mutedForeground} />;
  }

  return (
    // The outer wrapper anchors the absolute Retry/Remove controls and keeps
    // the strip's spacing (mr-2). It has NO overflow-hidden, so the controls'
    // hitSlop is never clipped; the rounded, clipping chip surface below is a
    // sibling of the controls, not their ancestor.
    <View
      className="relative mr-2"
      accessibilityLabel={t('chat.attachmentPreview.accessibility', {
        filename: row.filename,
        status: row.status,
      })}
    >
      <View
        className={cn(
          'overflow-hidden rounded-md border border-border bg-card',
          isImage ? 'h-16 w-20' : 'h-12 w-48 flex-row items-center gap-2 px-2'
        )}
      >
        {isImage && localUri ? (
          <Image
            source={{ uri: localUri }}
            className="h-full w-full"
            contentFit="cover"
            transition={0}
          />
        ) : (
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            {renderLeadingIcon()}
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-xs text-foreground">
                {row.filename}
              </Text>
              <Text numberOfLines={1} className="text-[10px] text-muted-foreground">
                {uploading
                  ? formatPercent(row.progress * 100, i18n.language)
                  : formatFileSize(row.size, i18n.language)}
              </Text>
            </View>
          </View>
        )}

        {isImage && uploading ? (
          <View className="absolute inset-0 items-center justify-center bg-[#00000033]">
            <ActivityIndicator size="small" color={colors.foreground} />
            <Text className="mt-1 text-[10px] text-foreground">
              {formatPercent(row.progress * 100, i18n.language)}
            </Text>
          </View>
        ) : null}
      </View>

      {failed ? (
        <Pressable
          onPress={onRetry}
          hitSlop={controlHitSlop()}
          className="absolute bottom-1 left-1 h-7 w-7 items-center justify-center rounded-full bg-background active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={t('chat.attachmentPreview.retryUploading', {
            filename: row.filename,
          })}
        >
          <RotateCcw size={14} color={colors.foreground} />
        </Pressable>
      ) : null}

      <Pressable
        onPress={onRemove}
        hitSlop={controlHitSlop()}
        className="absolute right-1 top-1 h-7 w-7 items-center justify-center rounded-full bg-background active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('chat.attachmentPreview.remove', { filename: row.filename })}
      >
        <X size={14} color={colors.foreground} />
      </Pressable>
    </View>
  );
}
