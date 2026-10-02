import { AlertCircle, Share, X } from '@/components/ui/icons';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ResumableZoom } from 'react-native-zoom-toolkit';
import { scheduleOnRN } from 'react-native-worklets';

import { CenteredState } from '@/components/centered-state';
import { StateSurface } from '@/components/centered-state-surface';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Image } from '@/components/ui/image';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The app's full-screen image viewer: pinch, pan, double-tap and swipe-to-
 * dismiss, taken from `react-native-zoom-toolkit` rather than hand-rolled from
 * raw gestures. This file is the only place that imports the zoom library; see
 * the "Unified Elements" table in `apps/mobile/AGENTS.md`.
 *
 * The viewer is a native sheet at the full detent, so it presents above the
 * session page sheet — also a native sheet — where a `@rn-primitives/portal`
 * overlay would render behind it.
 */

/** The one detent: the whole window. */
const VIEWER_SNAP_POINTS = ['100%'];

/** Zoom limits: 1x at content fit, 5x at the deepest zoom. */
const VIEWER_MAX_SCALE = 5;

/** Fills the viewer area; `alignSelf: 'stretch'` overrides the parent's centering. */
const ZOOM_SURFACE_STYLE = { flex: 1, alignSelf: 'stretch' } as const;

type ImageViewerProps = {
  visible: boolean;
  uri: string | null;
  /** Header a11y labels; kilo-chat passes the filename. */
  filename: string;
  /** Omit to hide the share action entirely. */
  onShare?: () => void;
  sharing?: boolean;
  /** Share failure message. Rendered inline — the toast layer sits behind this surface. */
  shareError?: string | null;
  onClose: () => void;
};

export function ImageViewer({
  visible,
  uri,
  filename,
  sharing = false,
  shareError = null,
  onClose,
  onShare,
}: ImageViewerProps) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  // iOS presents the sheet below the status bar; Android expands it over the
  // status bar, so only Android pads the header by the top inset.
  const headerTopInset = Platform.OS === 'ios' ? 0 : insets.top;

  // Landscape side safe areas (notch/Dynamic Island, Android cutouts) shift the
  // header row off the sensor on this full-screen modal. They go on an inner
  // wrapper so they ADD to the `px-4` gutter: an inline padding on the header
  // container would beat the className (inline style wins in React Native) and
  // swallow the gutter. Zero insets collapse the wrapper style to `undefined`,
  // so portrait pixels are byte-identical and a rotation never moves anything
  // vertically.
  const sideInsetStyle =
    insets.left > 0 || insets.right > 0
      ? {
          ...(insets.left > 0 ? { paddingLeft: insets.left } : undefined),
          ...(insets.right > 0 ? { paddingRight: insets.right } : undefined),
        }
      : undefined;

  const [imageError, setImageError] = useState(false);
  // Reset a prior decode error in render when the URL changes. A successful
  // renew writes a NEW signed URL; the reset must land in the same commit so
  // the refreshed image, not the "Image unavailable" row, renders. A failed
  // renew keeps the same URL, so `imageError` survives and the row stays until
  // a new URL lands.
  const [previousUri, setPreviousUri] = useState(uri);
  if (uri !== previousUri) {
    setPreviousUri(uri);
    setImageError(false);
  }

  // A new image (or a reopen) retries the decode from a clean slate.
  useEffect(() => {
    setImageError(false);
  }, [visible]);

  const handleSwipe = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right') => {
      // One image per viewer, so a horizontal swipe has nothing to move to.
      // Only the vertical swipe dismisses, the platform's photo-viewer gesture.
      if (direction === 'up' || direction === 'down') {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      snapPoints={VIEWER_SNAP_POINTS}
      showHandle={false}
      background={colors.background}
    >
      <StateSurface className="flex-1 bg-background">
        <View
          className="border-b border-border bg-background"
          style={{ paddingTop: headerTopInset, height: headerTopInset + 56 }}
        >
          <View
            className="flex-1 flex-row items-center justify-between px-4"
            style={sideInsetStyle}
          >
            <Pressable
              onPress={onClose}
              className="min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md bg-secondary active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel={t('imageViewer.close', { filename })}
            >
              <X size={20} color={colors.foreground} />
            </Pressable>
            {onShare !== undefined ? (
              <Pressable
                onPress={onShare}
                disabled={sharing || uri === null}
                accessibilityState={{ disabled: uri === null, busy: sharing }}
                className="min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md bg-secondary active:opacity-70 disabled:opacity-50"
                accessibilityRole="button"
                accessibilityLabel={t('imageViewer.share', { filename })}
              >
                <Share size={20} color={colors.foreground} />
              </Pressable>
            ) : null}
          </View>
        </View>
        {/* RNGH gestures need their own root inside the sheet — the app-root
            GestureHandlerRootView does not reach the sheet's native window. */}
        <GestureHandlerRootView className="flex-1">
          <View className="flex-1 items-center justify-center overflow-hidden bg-black">
            {/* Mounted only while the viewer is open and the bitmap decodes, so
                every open starts at 1x and no zoom survives a close. */}
            {visible && uri !== null && !imageError ? (
              <ResumableZoom
                style={ZOOM_SURFACE_STYLE}
                maxScale={VIEWER_MAX_SCALE}
                // onSwipe runs on the UI thread; hand the decision back to JS.
                onSwipe={direction => {
                  'worklet';
                  scheduleOnRN(handleSwipe, direction);
                }}
              >
                <Image
                  source={{ uri }}
                  cachePolicy="memory"
                  className="h-full w-full"
                  contentFit="contain"
                  onError={() => {
                    setImageError(true);
                  }}
                />
              </ResumableZoom>
            ) : null}
            {uri !== null && imageError ? (
              <CenteredState className="w-full">
                <View className="flex-row items-center justify-center gap-2 px-6">
                  <AlertCircle size={14} color="#ffffff" />
                  <Text className="text-xs text-white">{t('common.imageUnavailable')}</Text>
                </View>
              </CenteredState>
            ) : null}
          </View>
        </GestureHandlerRootView>
        {shareError ? (
          <View
            className="absolute inset-x-0 items-center px-6"
            style={{ bottom: insets.bottom + 16 }}
          >
            <View className="rounded-md bg-neutral-900/90 px-4 py-2 dark:bg-neutral-100/90">
              <AccessibleStatus
                message={shareError}
                className="text-center text-sm text-white dark:text-neutral-900"
              />
            </View>
          </View>
        ) : null}
      </StateSurface>
    </Sheet>
  );
}
