import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { AlertCircle, ImageOff } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { ImageViewerModal } from '@/components/image-viewer-modal';
import { Image } from '@/components/ui/image';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import {
  getToolImageAttachments,
  IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO,
  resolveImagePreviewAspectRatio,
} from './tool-card-attachments';
import { useToolCardImageUri } from './tool-card-image-cache';
import { getFilename } from './tool-card-utils';

function UnavailableRow({
  icon: Icon,
  message,
}: Readonly<{
  icon: typeof ImageOff;
  message: string;
}>) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
      <Icon size={14} color={colors.mutedForeground} />
      <Text className="text-xs text-muted-foreground">{message}</Text>
    </View>
  );
}

function ToolCardImageAttachment({
  part,
  label,
}: Readonly<{
  part: ToolPart;
  label: string;
}>) {
  const uri = useToolCardImageUri(part.id);
  const [aspectRatio, setAspectRatio] = useState<number | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [viewerVisible, setViewerVisible] = useState(false);

  if (uri === undefined) {
    return <UnavailableRow icon={ImageOff} message="Image preview unavailable in this session." />;
  }

  if (failed) {
    return <UnavailableRow icon={AlertCircle} message="Image unavailable" />;
  }

  return (
    <>
      <Pressable
        onPress={() => {
          setViewerVisible(true);
        }}
        className="w-full overflow-hidden rounded-md bg-neutral-100 active:opacity-80 dark:bg-neutral-900"
        accessibilityRole="button"
        accessibilityLabel={`Open ${label} full screen`}
        // eslint-disable-next-line react-native/no-inline-styles -- measured aspect ratio cannot be a Tailwind class
        style={{ aspectRatio: aspectRatio ?? IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO }}
      >
        {aspectRatio === undefined ? <Skeleton className="absolute inset-0" /> : null}
        <Image
          source={{ uri }}
          className="h-full w-full"
          contentFit="contain"
          transition={0}
          onLoad={event => {
            setAspectRatio(resolveImagePreviewAspectRatio(event.source.width, event.source.height));
          }}
          onError={() => {
            setFailed(true);
          }}
        />
      </Pressable>
      <ImageViewerModal
        visible={viewerVisible}
        uri={uri}
        filename={label}
        onClose={() => {
          setViewerVisible(false);
        }}
      />
    </>
  );
}

export function ToolCardImageAttachments({ part }: Readonly<{ part: ToolPart }>) {
  const attachments = getToolImageAttachments(part);
  if (attachments.length === 0) {
    return null;
  }

  const filePath = typeof part.state.input.filePath === 'string' ? part.state.input.filePath : '';
  const label = getFilename(filePath) || part.tool;

  return (
    <View className="gap-2">
      {attachments.map((_, index) => (
        <ToolCardImageAttachment key={index} part={part} label={label} />
      ))}
    </View>
  );
}
