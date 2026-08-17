import { AlertCircle } from '@/components/ui/icons';
import { useState } from 'react';
import { Pressable } from 'react-native';

import { ImageViewerModal } from '@/components/image-viewer-modal';
import { Image } from '@/components/ui/image';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import {
  IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO,
  resolveImagePreviewAspectRatio,
} from './tool-card-attachments';
import { getFilename } from './tool-card-utils';

export function MarkdownImage({
  uri,
  alt,
  aspectRatio,
}: Readonly<{
  uri: string;
  alt: string;
  aspectRatio?: number;
}>) {
  const colors = useThemeColors();
  const [measuredAspectRatio, setMeasuredAspectRatio] = useState<number | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const filename =
    alt || (uri.startsWith('http') ? getFilename(uri.split('?')[0] ?? '') : '') || 'image';

  if (failed) {
    return (
      <Pressable
        onPress={() => {
          setFailed(false);
          setMeasuredAspectRatio(undefined);
          setAttempt(prev => prev + 1);
        }}
        className="flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900"
        accessibilityRole="button"
        accessibilityLabel="Image unavailable, retry loading"
      >
        <AlertCircle size={14} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">
          {alt ? `Image unavailable ${alt}` : 'Image unavailable'}
        </Text>
      </Pressable>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => {
          setViewerVisible(true);
        }}
        className="my-1 w-full overflow-hidden rounded-md bg-neutral-100 active:opacity-80 dark:bg-neutral-900"
        accessibilityRole="button"
        accessibilityLabel={alt ? `View image ${alt}` : 'View image'}
        // eslint-disable-next-line react-native/no-inline-styles -- measured aspect ratio cannot be a Tailwind class
        style={{
          aspectRatio: measuredAspectRatio ?? aspectRatio ?? IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO,
        }}
      >
        {measuredAspectRatio === undefined ? <Skeleton className="absolute inset-0" /> : null}
        <Image
          key={attempt}
          source={{ uri }}
          className="h-full w-full"
          contentFit="contain"
          transition={0}
          accessibilityIgnoresInvertColors
          onLoad={event => {
            setMeasuredAspectRatio(
              resolveImagePreviewAspectRatio(event.source.width, event.source.height)
            );
          }}
          onError={() => {
            setFailed(true);
          }}
        />
      </Pressable>
      {viewerVisible && (
        <ImageViewerModal
          visible={viewerVisible}
          uri={uri}
          filename={filename}
          onClose={() => {
            setViewerVisible(false);
          }}
        />
      )}
    </>
  );
}
