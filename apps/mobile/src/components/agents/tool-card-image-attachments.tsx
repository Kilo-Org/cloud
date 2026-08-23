import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { AlertCircle, ImageOff } from '@/components/ui/icons';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

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

const toolInputFilePathSchema = z.object({ filePath: z.string() });

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
  const { t } = useTranslation();
  const uri = useToolCardImageUri(part.id);
  const [aspectRatio, setAspectRatio] = useState<number | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [viewerVisible, setViewerVisible] = useState(false);

  if (uri === undefined) {
    return (
      <UnavailableRow
        icon={ImageOff}
        message={t('agentChat.filePart.imagePreviewUnavailableInSession')}
      />
    );
  }

  if (failed) {
    return <UnavailableRow icon={AlertCircle} message={t('agentChat.filePart.imageUnavailable')} />;
  }

  return (
    <>
      <Pressable
        onPress={() => {
          setViewerVisible(true);
        }}
        className="w-full overflow-hidden rounded-md bg-neutral-100 active:opacity-80 dark:bg-neutral-900"
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.filePart.openFullScreen', { name: label })}
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
      {viewerVisible ? (
        <ImageViewerModal
          visible={viewerVisible}
          uri={uri}
          filename={label}
          onClose={() => {
            setViewerVisible(false);
          }}
        />
      ) : null}
    </>
  );
}

export function ToolCardImageAttachments({ part }: Readonly<{ part: ToolPart }>) {
  const attachments = getToolImageAttachments(part);
  if (attachments.length === 0) {
    return null;
  }

  // Render only the first image attachment: the cache stores one image per
  // part id (first attachment wins, see tool-card-image-cache.ts). Later
  // entries would show the same cached bytes instead of their own content.
  // Prefer the first attachment's filename; fall back to tool input filePath.
  const attachmentFilename = attachments[0]?.filename;
  const filePath = toolInputFilePathSchema.safeParse(part.state.input).data?.filePath ?? '';
  const label = attachmentFilename ?? getFilename(filePath === '' ? part.tool : filePath);

  return (
    <View className="gap-2">
      <ToolCardImageAttachment part={part} label={label} />
    </View>
  );
}
