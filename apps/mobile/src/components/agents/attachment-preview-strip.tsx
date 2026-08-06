import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { AlertCircle, File as FileIcon, RotateCcw, X } from 'lucide-react-native';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type AgentAttachment } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { describeAttachmentChip } from '@/components/agents/attachment-chip-description';

type Props = {
  attachments: AgentAttachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
};

/** 28pt visible button + 8pt slop on every side = 44pt effective target. */
const CHIP_BUTTON_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

function AttachmentChip({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: AgentAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const colors = useThemeColors();
  const isImage = attachment.kind === 'image';
  const isUploading = attachment.status === 'pending' || attachment.status === 'uploading';
  const isErrored = attachment.status === 'error';
  const description = describeAttachmentChip({
    filename: attachment.filename,
    size: attachment.size,
    status: attachment.status,
    progress: attachment.progress,
    terminal: attachment.terminal,
  });

  return (
    <View
      className={cn(
        'relative mr-2 overflow-hidden rounded-md border border-border bg-card',
        isImage ? 'h-16 w-20' : 'h-12 w-48',
        description.showRetry && 'border-destructive',
        isErrored && !description.showRetry && 'border-destructive/60'
      )}
    >
      {/* Chip body — the single accessible element describing the attachment.
          The container above stays non-accessible so the sibling Retry and
          Remove controls are individually reachable instead of being shadowed
          by an accessible parent. */}
      <View
        className="h-full w-full"
        accessible
        accessibilityLabel={description.accessibilityLabel}
        accessibilityRole={isUploading ? 'progressbar' : undefined}
        accessibilityValue={
          isUploading && attachment.progress !== null
            ? { min: 0, max: 100, now: Math.round(attachment.progress * 100) }
            : undefined
        }
        accessibilityState={
          isUploading && attachment.progress === null ? { busy: true } : undefined
        }
      >
        {/* Visual descendants are excluded from the accessibility tree so
            the body stays the single announced element: the nested Texts,
            the decorative thumbnail, and the uploading ActivityIndicator
            must never surface as duplicate nodes. */}
        <View
          className="h-full w-full"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {isImage ? (
            <Image
              source={{ uri: attachment.localUri }}
              className="h-full w-full"
              contentFit="cover"
              transition={0}
            />
          ) : (
            <View
              className={cn(
                'h-full w-full flex-row items-center gap-2',
                // Row 3.3: the Retry control sits in the bottom-LEFT corner, so
                // the retryable chip's file content shifts right of its 44pt
                // target instead of being hidden underneath it.
                description.showRetry ? 'pl-10 pr-2' : 'px-2'
              )}
            >
              {isErrored ? (
                <AlertCircle size={14} color={colors.destructive} />
              ) : (
                <FileIcon size={14} color={colors.mutedForeground} />
              )}
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-xs text-foreground">
                  {description.filename}
                </Text>
                <Text numberOfLines={1} className="text-[10px] text-muted-foreground">
                  {description.message ?? `${description.sizeText} · ${description.progressText}`}
                </Text>
              </View>
            </View>
          )}

          {isImage && isUploading ? (
            <View className="absolute inset-0 items-center justify-center bg-black/30">
              <ActivityIndicator size="small" color={colors.foreground} />
            </View>
          ) : null}

          {isImage && isErrored ? (
            <View className="absolute inset-0 items-center justify-center bg-black/30">
              <AlertCircle size={20} color="white" />
            </View>
          ) : null}
        </View>
      </View>

      {description.showRetry ? (
        <Pressable
          onPress={onRetry}
          hitSlop={CHIP_BUTTON_HIT_SLOP}
          className="absolute bottom-1 left-1 h-7 w-7 items-center justify-center rounded-full bg-background active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={`Retry uploading ${attachment.filename}`}
        >
          <RotateCcw size={14} color={colors.foreground} />
        </Pressable>
      ) : null}

      {description.showRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={CHIP_BUTTON_HIT_SLOP}
          className="absolute right-1 top-1 h-7 w-7 items-center justify-center rounded-full bg-background active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={`Remove attachment ${attachment.filename}`}
        >
          <X size={14} color={colors.foreground} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function AttachmentPreviewStrip({ attachments, onRemove, onRetry }: Readonly<Props>) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="mb-2"
      contentContainerClassName="items-center"
      keyboardShouldPersistTaps="handled"
    >
      {attachments.map(attachment => (
        <AttachmentChip
          key={attachment.id}
          attachment={attachment}
          onRemove={() => {
            onRemove(attachment.id);
          }}
          onRetry={() => {
            onRetry(attachment.id);
          }}
        />
      ))}
    </ScrollView>
  );
}
