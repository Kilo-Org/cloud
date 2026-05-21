import { ActivityIndicator, Pressable, View } from 'react-native';
import { AlertCircle, File as FileIcon, RotateCcw, X } from 'lucide-react-native';
import { type QueuedAttachment } from '@kilocode/kilo-chat-hooks';
import { formatFileSize } from '@kilocode/kilo-chat';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { isImageMimeType } from './message-attachment-state';

type Props = {
  row: QueuedAttachment;
  localUri: string | null;
  onRemove: () => void;
  onRetry: () => void;
};

export function MessageAttachmentPreviewChip({ row, localUri, onRemove, onRetry }: Props) {
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
    <View
      className={cn(
        'relative mr-2 overflow-hidden rounded-md border border-border bg-card',
        isImage ? 'h-16 w-20' : 'h-12 w-48 flex-row items-center gap-2 px-2'
      )}
      accessibilityLabel={`${row.filename}, ${row.status}`}
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
              {uploading ? `${Math.round(row.progress * 100)}%` : formatFileSize(row.size)}
            </Text>
          </View>
        </View>
      )}

      {isImage && uploading ? (
        <View className="absolute inset-0 items-center justify-center bg-black/20">
          <ActivityIndicator size="small" color={colors.foreground} />
          <Text className="mt-1 text-[10px] text-foreground">
            {Math.round(row.progress * 100)}%
          </Text>
        </View>
      ) : null}

      {failed ? (
        <Pressable
          onPress={onRetry}
          className="absolute bottom-1 left-1 h-7 w-7 items-center justify-center rounded-full bg-background active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={`Retry upload for ${row.filename}`}
        >
          <RotateCcw size={14} color={colors.foreground} />
        </Pressable>
      ) : null}

      <Pressable
        onPress={onRemove}
        className="absolute right-1 top-1 h-7 w-7 items-center justify-center rounded-full bg-background active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={`Remove ${row.filename}`}
      >
        <X size={14} color={colors.foreground} />
      </Pressable>
    </View>
  );
}
