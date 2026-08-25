import { useReducer, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ImageViewerModal } from '@/components/image-viewer-modal';
import { AlertCircle, Download } from '@/components/ui/icons';
import { Image } from '@/components/ui/image';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { confirmMarkdownImage, isMarkdownImageConfirmed } from './markdown-image-confirm';
import { resolveMarkdownImageSrc } from './markdown-image-src';
import {
  IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO,
  resolveImagePreviewAspectRatio,
} from './tool-card-attachments';
import { getFilename } from './tool-card-utils';

type MarkdownImageKind = 'https' | 'http' | 'data' | null;

function classifyUri(uri: string): MarkdownImageKind {
  if (uri.startsWith('https://')) {
    return 'https';
  }
  if (uri.startsWith('http://')) {
    return 'http';
  }
  if (uri.startsWith('data:image/')) {
    return 'data';
  }
  return null;
}

function imageHostDisplay(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Static chip for http and data URIs: HTTPS-only copy, host name for http. */
function BlockedImageChip({ kind, uri }: Readonly<{ kind: 'http' | 'data'; uri: string }>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const host = kind === 'http' ? imageHostDisplay(uri) : null;
  const label = host
    ? `${host} · ${t('agentChat.markdownImage.httpsOnly')}`
    : t('agentChat.markdownImage.httpsOnly');
  return (
    <View
      className="flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900"
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      <AlertCircle size={14} color={colors.mutedForeground} />
      <Text className="shrink text-xs text-muted-foreground" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** HTTPS, not yet confirmed: source host plus a Load affordance. No Image mounts. */
function UnconfirmedImageChip({ uri, onLoad }: Readonly<{ uri: string; onLoad: () => void }>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const host = imageHostDisplay(uri);
  return (
    <View className="flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
      <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={1}>
        {host ?? t('agentChat.markdownImage.httpsOnly')}
      </Text>
      <Pressable
        onPress={onLoad}
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.markdownImage.load')}
        className="min-h-11 shrink-0 items-center justify-center active:opacity-70"
      >
        <Download size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

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
  const { t } = useTranslation();
  // Confirmation follows the current uri on every render, so a recycled
  // instance never keeps a previous uri's consent. forceRender only re-runs
  // the render after confirmMarkdownImage mutates the module Set.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const [measuredAspectRatio, setMeasuredAspectRatio] = useState<number | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const filename =
    alt || (uri.startsWith('http') ? getFilename(uri.split('?')[0] ?? '') : '') || 'image';

  const kind = classifyUri(uri);
  const confirmed = isMarkdownImageConfirmed(uri);

  if (kind === 'http' || kind === 'data') {
    return <BlockedImageChip kind={kind} uri={uri} />;
  }

  if (kind === 'https' && !confirmed) {
    return (
      <UnconfirmedImageChip
        uri={uri}
        onLoad={() => {
          confirmMarkdownImage(uri);
          forceRender();
        }}
      />
    );
  }

  // Other schemes never reach MarkdownImage from the renderer; keep the alt
  // text visible so a direct or fallback use never drops the description.
  if (kind === null) {
    return <Text className="text-xs text-muted-foreground">{alt || 'image'}</Text>;
  }

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
        accessibilityLabel={t('agentChat.filePart.imageUnavailableRetry')}
      >
        <AlertCircle size={14} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">
          {alt
            ? t('agentChat.filePart.imageUnavailableWithAlt', { alt })
            : t('agentChat.filePart.imageUnavailable')}
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
        accessibilityLabel={
          alt
            ? t('agentChat.filePart.viewImageWithAlt', { alt })
            : t('agentChat.filePart.viewImage')
        }
        // eslint-disable-next-line react-native/no-inline-styles -- measured aspect ratio cannot be a Tailwind class
        style={{
          aspectRatio: measuredAspectRatio ?? aspectRatio ?? IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO,
        }}
      >
        {measuredAspectRatio === undefined ? <Skeleton className="absolute inset-0" /> : null}
        <Image
          key={attempt}
          source={{ uri: resolveMarkdownImageSrc(uri) }}
          cachePolicy="memory"
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
