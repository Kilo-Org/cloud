import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { AlertCircle, File as FileIcon, X } from 'lucide-react-native';

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

const REMOVE_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

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
    <Pressable
      onPress={description.showRetry ? onRetry : undefined}
      disabled={!description.showRetry}
      className={cn(
        'relative mr-2 overflow-hidden rounded-md border border-border bg-card',
        isImage ? 'h-16 w-20' : 'h-12 w-48 flex-row items-center gap-2 px-2',
        description.showRetry && 'border-destructive active:opacity-70',
        isErrored && !description.showRetry && 'border-destructive/60'
      )}
      accessibilityRole={description.showRetry ? 'button' : undefined}
      accessibilityLabel={
        description.showRetry
          ? `Retry uploading ${attachment.filename}`
          : `${attachment.filename}, ${attachment.status}`
      }
    >
      {isImage ? (
        <Image
          source={{ uri: attachment.localUri }}
          className="h-full w-full"
          contentFit="cover"
          transition={0}
        />
      ) : (
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
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

      {description.showRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={REMOVE_HIT_SLOP}
          className="absolute right-1 top-1 h-7 w-7 items-center justify-center rounded-full bg-background active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={`Remove attachment ${attachment.filename}`}
        >
          <X size={14} color={colors.foreground} />
        </Pressable>
      ) : null}
    </Pressable>
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
      accessibilityRole="summary"
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
