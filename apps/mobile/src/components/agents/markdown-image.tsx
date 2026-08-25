import { useReducer, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ImageViewerModal } from '@/components/image-viewer-modal';
import { AlertCircle, Download } from '@/components/ui/icons';
import { Image } from '@/components/ui/image';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { buildAuthHeaders } from '@/lib/auth/auth-header';
import { getActiveToken } from '@/lib/auth/token-owner';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { confirmMarkdownImage, isMarkdownImageConfirmed } from './markdown-image-confirm';
import { resolveMarkdownImageSrc } from './markdown-image-src';
import { getLinkAccessibilityActions } from './markdown-link';
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
function BlockedImageChip({
  kind,
  uri,
  onShowLinkActions,
}: Readonly<{ kind: 'http' | 'data'; uri: string; onShowLinkActions?: () => void }>) {
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
      accessibilityActions={onShowLinkActions ? getLinkAccessibilityActions(true) : undefined}
      onAccessibilityAction={event => {
        if (event.nativeEvent.actionName === 'showLinkActions') {
          onShowLinkActions?.();
        }
      }}
    >
      <AlertCircle size={14} color={colors.mutedForeground} />
      <Text className="shrink text-xs text-muted-foreground" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** HTTPS, not yet confirmed: source host plus a Load affordance. No Image mounts. */
function UnconfirmedImageChip({
  uri,
  onLoad,
  onShowLinkActions,
}: Readonly<{ uri: string; onLoad: () => void; onShowLinkActions?: () => void }>) {
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
        accessibilityLabel={
          host
            ? t('agentChat.markdownImage.loadWithHost', { host })
            : t('agentChat.markdownImage.load')
        }
        accessibilityActions={onShowLinkActions ? getLinkAccessibilityActions(true) : undefined}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'showLinkActions') {
            onShowLinkActions?.();
          }
        }}
        className="min-h-11 min-w-11 shrink-0 items-center justify-center active:opacity-70"
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
  onShowLinkActions,
}: Readonly<{
  uri: string;
  alt: string;
  aspectRatio?: number;
  onShowLinkActions?: () => void;
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

  // A recycled FlashList cell must not carry the previous uri's fail or viewer
  // state into the new uri. Reset synchronously during render (React's
  // "adjust state when a prop changes" pattern) so no frame shows a stale chip.
  const [prevUri, setPrevUri] = useState(uri);
  if (prevUri !== uri) {
    setPrevUri(uri);
    setFailed(false);
    setViewerVisible(false);
    setAttempt(0);
    setMeasuredAspectRatio(undefined);
  }

  const filename =
    alt || (uri.startsWith('http') ? getFilename(uri.split('?')[0] ?? '') : '') || 'image';

  const kind = classifyUri(uri);
  const confirmed = isMarkdownImageConfirmed(uri);

  if (kind === 'http' || kind === 'data') {
    return <BlockedImageChip kind={kind} uri={uri} onShowLinkActions={onShowLinkActions} />;
  }

  if (kind === 'https' && !confirmed) {
    return (
      <UnconfirmedImageChip
        uri={uri}
        onShowLinkActions={onShowLinkActions}
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

  // The media proxy requires authentication. With no sync token we cannot
  // request the image, so render the retry fail chip and never fetch (an
  // unauthenticated expo-image source would just 401).
  const token = getActiveToken();

  if (failed || !token) {
    return (
      <Pressable
        onPress={() => {
          setFailed(false);
          setMeasuredAspectRatio(undefined);
          setAttempt(prev => prev + 1);
        }}
        onLongPress={onShowLinkActions}
        className="flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 active:opacity-80 dark:bg-neutral-900"
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.filePart.imageUnavailableRetry')}
        accessibilityActions={onShowLinkActions ? getLinkAccessibilityActions(true) : undefined}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'showLinkActions') {
            onShowLinkActions?.();
          }
        }}
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
        onLongPress={onShowLinkActions}
        className="my-1 w-full overflow-hidden rounded-md bg-neutral-100 active:opacity-80 dark:bg-neutral-900"
        accessibilityRole="button"
        accessibilityLabel={
          alt
            ? t('agentChat.filePart.viewImageWithAlt', { alt })
            : t('agentChat.filePart.viewImage')
        }
        accessibilityActions={onShowLinkActions ? getLinkAccessibilityActions(true) : undefined}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'showLinkActions') {
            onShowLinkActions?.();
          }
        }}
        // eslint-disable-next-line react-native/no-inline-styles -- measured aspect ratio cannot be a Tailwind class
        style={{
          aspectRatio: measuredAspectRatio ?? aspectRatio ?? IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO,
        }}
      >
        {measuredAspectRatio === undefined ? <Skeleton className="absolute inset-0" /> : null}
        <Image
          key={attempt}
          source={{
            uri: resolveMarkdownImageSrc(uri),
            headers: buildAuthHeaders(token.token),
          }}
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
          uri={resolveMarkdownImageSrc(uri)}
          headers={buildAuthHeaders(token.token)}
          filename={filename}
          onClose={() => {
            setViewerVisible(false);
          }}
        />
      )}
    </>
  );
}
