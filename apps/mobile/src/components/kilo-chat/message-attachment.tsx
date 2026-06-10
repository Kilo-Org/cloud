import { useAttachmentUrl } from '@kilocode/kilo-chat-hooks';
import { type AttachmentBlock, formatFileSize, type KiloChatClient } from '@kilocode/kilo-chat';
import { AlertCircle, File as FileIcon } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import {
  getAttachmentImageRenderState,
  getAttachmentOpenErrorMessage,
  getFreshAttachmentPreviewUrl,
  shareRemoteAttachment,
} from './message-attachment-open';
import { isImageMimeType } from './message-attachment-state';
import { MessageImagePreviewModal } from './message-image-preview-modal';

type Props = {
  client: KiloChatClient;
  conversationId: string;
  block: AttachmentBlock;
  isFromMe: boolean;
};

export function MessageAttachment({ client, conversationId, block, isFromMe }: Props) {
  const colors = useThemeColors();
  const isImage = isImageMimeType(block.mimeType);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const urlQuery = useAttachmentUrl(client, conversationId, block.attachmentId, {
    enabled: isImage,
  });
  const imageState = getAttachmentImageRenderState({
    hasUrl: Boolean(urlQuery.data?.url),
    isError: urlQuery.isError,
    isLoading: urlQuery.isLoading,
  });

  async function handleShare() {
    setSharing(true);
    try {
      const result = await urlQuery.refetch();
      const url = result.data?.url;
      if (!url) {
        throw new Error(getAttachmentOpenErrorMessage());
      }

      await shareRemoteAttachment({
        url,
        attachmentId: block.attachmentId,
        filename: block.filename,
      });
    } catch {
      toast.error(getAttachmentOpenErrorMessage());
    } finally {
      setSharing(false);
    }
  }

  async function handleOpenImagePreview() {
    try {
      const result = await urlQuery.refetch();
      const freshUrl = getFreshAttachmentPreviewUrl(result.data);
      if (!freshUrl) {
        throw new Error(getAttachmentOpenErrorMessage());
      }

      setPreviewUrl(freshUrl);
    } catch {
      toast.error(getAttachmentOpenErrorMessage());
    }
  }

  function renderImageThumbnail() {
    if (imageState === 'ready' && urlQuery.data) {
      return (
        <Image
          source={{ uri: urlQuery.data.url }}
          className="aspect-[4/3] w-full"
          contentFit="cover"
        />
      );
    }

    if (imageState === 'loading') {
      return (
        <View className="aspect-[4/3] w-full items-center justify-center">
          <ActivityIndicator size="small" color={colors.foreground} />
        </View>
      );
    }

    return (
      <View className="aspect-[4/3] w-full items-center justify-center gap-2">
        <AlertCircle size={18} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">Image unavailable</Text>
      </View>
    );
  }

  if (isImage) {
    return (
      <View className="mt-2 w-64 max-w-full">
        <Pressable
          onPress={() => {
            void handleOpenImagePreview();
          }}
          className="overflow-hidden rounded-lg bg-neutral-200 active:opacity-80 dark:bg-neutral-900"
          accessibilityRole="button"
          accessibilityLabel={`Open ${block.filename}`}
        >
          {renderImageThumbnail()}
        </Pressable>
        <MessageImagePreviewModal
          visible={previewUrl !== null}
          uri={previewUrl}
          filename={block.filename}
          sharing={sharing}
          onClose={() => {
            setPreviewUrl(null);
          }}
          onShare={() => {
            void handleShare();
          }}
        />
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => {
        void handleShare();
      }}
      disabled={sharing}
      className={cn(
        'mt-2 max-w-56 flex-row items-center gap-2 rounded-md border px-3 py-2 active:opacity-80 disabled:opacity-60',
        isFromMe ? 'border-primary-foreground' : 'border-border bg-secondary'
      )}
      accessibilityRole="button"
      accessibilityLabel={`Open ${block.filename}`}
    >
      {sharing ? (
        <ActivityIndicator
          size="small"
          color={isFromMe ? colors.primaryForeground : colors.mutedForeground}
        />
      ) : (
        <FileIcon size={14} color={isFromMe ? colors.primaryForeground : colors.mutedForeground} />
      )}
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className={cn('text-xs', isFromMe ? 'text-primary-foreground' : 'text-foreground')}
        >
          {block.filename}
        </Text>
        {block.size > 0 ? (
          <Text
            numberOfLines={1}
            className={cn(
              'text-[10px]',
              isFromMe ? 'text-primary-foreground opacity-70' : 'text-muted-foreground'
            )}
          >
            {formatFileSize(block.size)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
