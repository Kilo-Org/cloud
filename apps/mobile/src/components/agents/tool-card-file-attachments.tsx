import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { FileIcon, Share2 } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getShareRemoteFileReason,
  shareLocalFile,
  ShareRemoteFileError,
} from '@/lib/share-remote-file';

import { getToolFileAttachments } from './tool-card-attachments';
import { useToolCardImageUri } from './tool-card-image-cache';

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
  const available = uri !== undefined;

  if (!available) {
    return (
      <View className="flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
        <FileIcon size={14} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">
          {t('agentChat.filePart.fileUnavailableInSession')}
        </Text>
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
    <View className="flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
      <FileIcon size={16} color={colors.mutedForeground} />
      <View className="flex-1">
        <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
          {label}
        </Text>
        <Text className="text-xs text-muted-foreground">{mime}</Text>
      </View>
      <Pressable
        className="rounded p-1 active:opacity-60"
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

  const label = first.filename ?? t('agentChat.filePart.defaultName');

  return (
    <View className="gap-2">
      <FileChip label={label} mime={first.mime} partId={part.id} />
    </View>
  );
}
