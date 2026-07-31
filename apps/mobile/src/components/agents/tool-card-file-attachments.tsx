import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { FileIcon, Share2 } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
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
  const uri = useToolCardImageUri(partId);
  const available = uri !== undefined;

  if (!available) {
    return (
      <View className="flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
        <FileIcon size={14} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">File unavailable in this session.</Text>
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
        toast.error('File sharing is not available on this device.');
        return;
      }
      if (error instanceof ShareRemoteFileError) {
        toast.error('Failed to share file. Please try again.');
        return;
      }
      toast.error('Share failed');
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
        accessibilityLabel={`Share ${label}`}
      >
        <Share2 size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

export function ToolCardFileAttachments({ part }: Readonly<{ part: ToolPart }>) {
  const attachments = getToolFileAttachments(part);
  if (attachments.length === 0) {
    return null;
  }

  return (
    <View className="gap-2">
      {attachments.map(attachment => {
        const label = attachment.filename ?? 'File';
        return (
          <FileChip key={attachment.id} label={label} mime={attachment.mime} partId={part.id} />
        );
      })}
    </View>
  );
}
