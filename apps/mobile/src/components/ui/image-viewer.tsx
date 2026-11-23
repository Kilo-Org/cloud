import { AlertCircle, RotateCcw, Share, X } from '@/components/ui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Platform, Pressable, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { ResumableZoom } from 'react-native-zoom-toolkit';
import { scheduleOnRN } from 'react-native-worklets';

import { CenteredState } from '@/components/centered-state';
import { StateSurface } from '@/components/centered-state-surface';
import { StateAction } from '@/components/empty-state';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Image } from '@/components/ui/image';
import { Sheet } from '@/components/ui/sheet';

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

/**
 * The viewer surface: the exact value `bg-black` paints. Fixed rather than the
 * `background` token because the viewer paints one black surface in every
 * colour scheme — a light-mode sheet behind the canvas would flash white.
 */
const VIEWER_SURFACE = '#000000';

/**
 * The chrome glyph ink on that surface: fixed rather than `foreground` because
 * theme ink is scheme-dependent, and light `--foreground` measures 1.1:1 on
 * black.
 */
const VIEWER_INK = '#FFFFFF';

/**
 * A retried `Image` that never fires `onLoad` or `onError` — a hung request —
 * would otherwise leave the action busy and unpressed forever. This expiry
 * returns the action and never drops the request: the retried image stays
 * mounted, so a decode that lands later still clears the state.
 */
const RETRY_BUSY_LIMIT_MS = 10_000;

/**
 * The schemes a retry can help: a case-insensitive test, because a scheme is
 * ASCII and re-casing display text to compare it is what the case guard bans.
 */
const RETRYABLE_SCHEME = /^https?:\/\//i;

/**
 * Only a remote image can come back different: a local, content or data URI
 * re-reads the same bytes, so a retry could not change the result.
 */
function isRetryableUri(uri: string): boolean {
  return RETRYABLE_SCHEME.test(uri);
}

/**
 * One attempt's outcome. `failed` is the only phase that unmounts the decode,
 * and only a real `onError` from the mounted image publishes it. `stalled` is
 * the same attempt after its settle or the busy bound expires: the request may
 * still land, so the retried image stays mounted while the action becomes
 * pressable again.
 */
type ViewerImageStatus = 'ready' | 'failed' | 'retrying' | 'stalled';

type ImageViewerProps = {
  visible: boolean;
  uri: string | null;
  filename: string;
  /** Omit to hide the share action entirely. */
  onShare?: () => void;
  sharing?: boolean;
  /** Share failure message. Rendered inline — the toast layer sits behind this surface. */
  shareError?: string | null;
  /**
   * A caller that owns a renewal path (a re-presign) passes it, and the retry
   * awaits it before handing the state back to the action. Its settle — a
   * return or a throw — only returns the action: the retried image stays
   * mounted and its decode stays reachable, because the renewed bytes may yet
   * paint. Only a real `onError` from that image publishes the failure. Without
   * this prop the retry only remounts the image for the same URI, which is all
   * a local or already-fresh URL can do.
   */
  onRetry?: () => void | Promise<void>;
  onClose: () => void;
};

export function ImageViewer({
  visible,
  uri,
  filename,
  sharing = false,
  shareError = null,
  onRetry,
  onClose,
  onShare,
}: ImageViewerProps) {
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
  const sideInsetStyle = useSideInsetStyle();

  const [status, setStatus] = useState<ViewerImageStatus>('ready');
  // The attempt that owns the phase. A press bumps it, so a settle that lands
  // after a later press — reachable now that `stalled` makes the action
  // pressable again — can tell it no longer owns the state.
  const retryAttempt = useRef(0);
  // The attempt that is awaiting the caller's renewal path. The press remounts
  // the decode with the URL it is about to renew, so a presigned URL that has
  // already expired errors before that renewal lands. That error belongs to the
  // pending attempt: publishing it would return the action, and unmount the
  // decode, ahead of the renewed URL that is still on its way.
  const renewalAttempt = useRef<number | null>(null);
  // The attempt the mounted `Image` belongs to. It keys the image so a press
  // re-issues the fetch even when the component stays mounted: from `stalled`
  // the image is still there, and an unchanged `source` would otherwise decode
  // nothing at all.
  const [decodeAttempt, setDecodeAttempt] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const measureViewport = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    setViewport(current =>
      current.width === layout.width && current.height === layout.height
        ? current
        : { width: layout.width, height: layout.height }
    );
  }, []);
  // Reset a prior decode failure in render when the URL changes. A successful
  // renew writes a NEW signed URL; the reset must land in the same commit so
  // the refreshed image, not the "Image unavailable" row, renders. A failed
  // renew keeps the same URL, so the failure survives and the row stays until
  // a new URL lands.
  const [previousUri, setPreviousUri] = useState(uri);
  if (uri !== previousUri) {
    setPreviousUri(uri);
    setStatus('ready');
  }

  // A renewed URL takes ownership away from any in-flight attempt, so a pending
  // settle publishes nothing on top of the fresh image. The bump lives in an
  // effect because render must stay side-effect free. The pending renewal
  // clears with it: the URL it was waiting on has landed, so a decode error on
  // the fresh image is a real one again.
  useEffect(() => {
    retryAttempt.current += 1;
    renewalAttempt.current = null;
  }, [uri]);

  // A new image (or a reopen) retries the decode from a clean slate, so neither
  // a prior phase nor a renewal the closed viewer was awaiting can publish.
  useEffect(() => {
    setStatus('ready');
    renewalAttempt.current = null;
  }, [visible]);

  // A retry keeps the unavailable state mounted and marks it busy; the new
  // `Image` mounts at once and its `onLoad` clears the state, while its
  // `onError` returns it to the failed action. When the caller owns a renewal
  // path, the action also stays busy until that path settles — and that settle
  // returns the action without unmounting the decode. The status says which
  // phase is rendered; the attempt ref says which press owns it, because
  // `stalled` makes the action pressable while the first attempt is still in
  // flight; the renewal ref says which press is still awaiting `onRetry`, so
  // an error from the URL that press remounted publishes nothing.
  const retryImage = useCallback(() => {
    const attempt = retryAttempt.current + 1;
    retryAttempt.current = attempt;
    setDecodeAttempt(attempt);
    setStatus('retrying');
    if (onRetry === undefined) {
      return;
    }
    renewalAttempt.current = attempt;
    void (async () => {
      try {
        await onRetry();
      } catch {
        // A renewal that throws has the same outcome as one that returns a
        // stale url: return the action, never the pending decode.
      }
      // A landed uri, a later press or a decode outcome may already have taken
      // this renewal's place, so only its own attempt may clear the ref.
      if (renewalAttempt.current === attempt) {
        renewalAttempt.current = null;
      }
      if (retryAttempt.current !== attempt) {
        return;
      }
      // The retried image is still mounted and may yet paint, so the settle
      // returns the action in the phase that keeps it: `failed` would unmount
      // the decode that is still in flight.
      setStatus(current => (current === 'retrying' ? 'stalled' : current));
    })();
  }, [onRetry]);

  // A busy phase that outlives the bound returns the action while the retried
  // image stays mounted, so a late decode can still take the state back. The
  // timer pins its own attempt: a `stalled` phase can be re-entered by a new
  // press, and this timer must not expire that later attempt's phase.
  useEffect(() => {
    if (status !== 'retrying') {
      return undefined;
    }
    const attempt = retryAttempt.current;
    const timer = setTimeout(() => {
      if (retryAttempt.current !== attempt) {
        return;
      }
      // The request may still land, so the image stays mounted: the expiry only
      // returns the action, it never drops the fetch.
      setStatus(current => (current === 'retrying' ? 'stalled' : current));
    }, RETRY_BUSY_LIMIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);

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
      background={VIEWER_SURFACE}
    >
      <StateSurface className="flex-1 bg-black">
        <View
          className="bg-black"
          style={{ paddingTop: headerTopInset, height: headerTopInset + 56 }}
        >
          <View
            className="flex-1 flex-row items-center justify-between px-4"
            style={sideInsetStyle}
          >
            <Pressable
              onPress={onClose}
              className="min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md bg-neutral-800 active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel={t('imageViewer.close', { filename })}
            >
              <X size={20} color={VIEWER_INK} />
            </Pressable>
            {onShare !== undefined ? (
              <Pressable
                onPress={onShare}
                disabled={sharing || uri === null}
                accessibilityState={{ disabled: uri === null, busy: sharing }}
                className="min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md bg-neutral-800 active:opacity-70 disabled:opacity-50"
                accessibilityRole="button"
                accessibilityLabel={t('imageViewer.share', { filename })}
              >
                <Share size={20} color={VIEWER_INK} />
              </Pressable>
            ) : null}
          </View>
        </View>
        {/* RNGH gestures need their own root inside the sheet — the app-root
            GestureHandlerRootView does not reach the sheet's native window. */}
        <GestureHandlerRootView className="flex-1">
          <View
            className="flex-1 items-center justify-center overflow-hidden bg-black"
            onLayout={measureViewport}
          >
            {/* Mounted only while the viewer is open and the bitmap decodes, so
                every open starts at 1x and no zoom survives a close. A retry
                remounts it under the state layer, still at full size. */}
            {visible && uri !== null && status !== 'failed' ? (
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
                  // A press re-issues the fetch: from `stalled` the image is
                  // still mounted with the same `source`, so only a new key
                  // makes it decode again.
                  key={decodeAttempt}
                  source={{ uri }}
                  cachePolicy="memory"
                  // ResumableZoom measures an unconstrained child; percentages collapse it to zero.
                  style={viewport}
                  contentFit="contain"
                  onLoad={() => {
                    // A landed decode owns the state from any phase, so a retry
                    // still awaiting its renewal path publishes nothing — and
                    // the renewal it was awaiting no longer owns anything.
                    retryAttempt.current += 1;
                    renewalAttempt.current = null;
                    setStatus('ready');
                  }}
                  onError={() => {
                    // The press remounted this decode with the URL it is
                    // renewing, so an already-expired URL errors before that
                    // renewal lands. The error belongs to the pending attempt:
                    // it must keep the action busy and the decode mounted until
                    // the renewed URL arrives.
                    if (renewalAttempt.current !== null) {
                      return;
                    }
                    setStatus('failed');
                  }}
                />
              </ResumableZoom>
            ) : null}
            {/* The state is a layer over the canvas, not a sibling that shares
                its flex line: a retried `Image` mounts underneath at full size
                while this covers it, so the canvas never splits. The wrapper
                paints the viewer black itself, so no frame of the retried
                bitmap shows through behind the disc and the copy. */}
            {uri !== null && status !== 'ready' ? (
              <View className="absolute inset-0 bg-black">
                <CenteredState className="w-full">
                  <View className="items-center gap-4 px-6">
                    <View className="h-14 w-14 items-center justify-center rounded-full bg-neutral-800">
                      <AlertCircle size={24} color={VIEWER_INK} strokeWidth={1.5} />
                    </View>
                    <AccessibleStatus
                      // Reusing `common.loading` avoids a new catalog key; the
                      // change of message is what makes the return to
                      // `Image unavailable` a live announcement on Android and
                      // through `nextAnnouncement` on iOS.
                      message={
                        status === 'retrying' ? t('common.loading') : t('common.imageUnavailable')
                      }
                      className="max-w-sm text-center text-base text-neutral-300"
                    />
                    {isRetryableUri(uri) ? (
                      <StateAction
                        label={t('common.retry')}
                        accessibilityLabel={t('agentChat.filePart.imageUnavailableRetry')}
                        icon={RotateCcw}
                        onPress={retryImage}
                        loading={status === 'retrying'}
                        // The viewer paints one black surface in every scheme,
                        // so its action keeps the brand pair that surface was
                        // designed for.
                        surface="on-dark"
                      />
                    ) : null}
                  </View>
                </CenteredState>
              </View>
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
