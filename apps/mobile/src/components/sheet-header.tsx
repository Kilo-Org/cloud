import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StatusBar, View } from 'react-native';

import { Share } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { useScreenInsets } from '@/lib/screen-insets';

/**
 * How much top clearance the header reserves:
 *
 * - 'always': the surface owns the top of the window (full-screen modals), so
 *   the status-bar inset applies whenever it is non-zero.
 * - 'bottom-form-sheet': a bottom-anchored formSheet. On iOS the native sheet
 *   presents below the status bar, so the header reserves no top clearance
 *   there — the window inset would only be a dead band above the header.
 *   On Android `sheetShouldOverflowTopInset` (useFormSheetScreenOptions)
 *   lets the sheet surface reach the top of the window and only caps the
 *   full detent's measure, so the header must reserve the status-bar inset
 *   (and landscape cutout padding) itself.
 * - 'ios-page-sheet': the SessionPageSheet surface owns the top of the window
 *   on both platforms, so the header reserves no top clearance — the native
 *   iOS pageSheet presents below the status bar, and the Android full-window
 *   Modal pads its own top inset (session-page-sheet). `useSafeAreaInsets`
 *   still reports the window's inset inside either Modal, so reading it in the
 *   header would leave a dead band above the title.
 * - 'never': the surface can never reach the window top (half-detent-only
 *   sheets), so the header reserves no top clearance on either platform —
 *   the inset would only be a dead band above the title.
 */
export type SheetHeaderTopInset = 'always' | 'bottom-form-sheet' | 'ios-page-sheet' | 'never';

/**
 * Whether a measured window Y counts as the header sitting at the window top.
 * Only a surface that truly starts at y ≈ 0 needs its own status-bar
 * clearance; a sheet edge the detent cap placed below the status bar already
 * provides it, and reserving the inset again would be a dead band.
 */
export function isAtWindowTop(y: number | undefined): boolean {
  return y !== undefined && y <= 1;
}

export function SheetHeader({
  title,
  titleEllipsis = 'tail',
  onDone,
  onCancel,
  doneLabel,
  cancelLabel,
  onShare,
  sharing = false,
  disabled = false,
  topInset = 'always',
}: {
  title: string;
  /**
   * 'middle' keeps a filename's extension visible. Android ignores middle
   * truncation past the first line and falls back to tail.
   */
  titleEllipsis?: 'tail' | 'middle';
  onDone: () => void;
  onCancel?: () => void;
  doneLabel?: string;
  /**
   * Overrides the leading control's visible text and accessibility label, so
   * an in-sheet Back is announced as Back, not Cancel.
   */
  cancelLabel?: string;
  onShare?: () => void;
  sharing?: boolean;
  disabled?: boolean;
  topInset?: SheetHeaderTopInset;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useScreenInsets();
  const resolvedDoneLabel = doneLabel ?? t('common.done');
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  // Reserve top clearance as well as landscape cutout clearance inside the
  // gutters. Keeping the inset on an inner wrapper preserves the header's own
  // padding. Android can report top: 0 for the frame a freshly presented
  // sheet first lays out (before the insets propagate); fall back to the
  // synchronous status-bar height the same way the form-sheet detents do.
  // `StatusBar.currentHeight` is an Android-only API and `undefined` on iOS,
  // so the nullish fallback yields the status-bar height on both platforms
  // without branching on Platform.OS.
  const statusBarHeight = StatusBar.currentHeight ?? 0;
  const resolvedTopInset = insets.top > 0 ? insets.top : statusBarHeight;
  // On Android a bottom formSheet surface reaches the window top only in the
  // degenerate frame where the detent cap reports no inset
  // (`useFormSheetDetents`); at every settled detent the cap already places
  // the sheet edge below the status bar, so reserving the inset there would
  // only double the clearance. The header therefore reserves the inset only
  // while it measures at the window top itself (y ≈ 0) and re-measures when
  // the sheet settles at another detent — the native detent index is not
  // otherwise observable from JS on Android.
  const [reachesWindowTop, setReachesWindowTop] = useState(true);
  // On iOS the native sheet presents below the status bar, so the header
  // reserves no top clearance there — the window inset would only be a dead
  // band. SessionPageSheet presents below the status bar on iOS too, and the
  // Android full-window Modal pads its own top inset — either way its header
  // reserves nothing. 'never' marks half-detent-only sheets that can never
  // reach the window top.
  const dropsTopInset =
    topInset === 'ios-page-sheet' ||
    topInset === 'never' ||
    (topInset === 'bottom-form-sheet' && (Platform.OS !== 'android' || !reachesWindowTop));
  const topInsetHeight = dropsTopInset ? 0 : resolvedTopInset;
  const safeAreaStyle =
    topInsetHeight > 0 || insets.left > 0 || insets.right > 0
      ? {
          ...(topInsetHeight > 0 ? { paddingTop: topInsetHeight } : undefined),
          ...(insets.left > 0 ? { paddingLeft: insets.left } : undefined),
          ...(insets.right > 0 ? { paddingRight: insets.right } : undefined),
        }
      : undefined;
  const containerRef = useRef<View | null>(null);
  const remeasureWindowTop = useCallback(() => {
    containerRef.current?.measureInWindow((_x, y) => {
      setReachesWindowTop(isAtWindowTop(y));
    });
  }, []);
  const setContainerRef = useCallback((view: View | null) => {
    containerRef.current = view;
    view?.measureInWindow((_x, y) => {
      setReachesWindowTop(isAtWindowTop(y));
    });
  }, []);
  // `onLayout` cannot track a native detent change: the header keeps the same
  // frame inside the sheet content while the sheet itself moves. Follow the
  // NativeStateSurface pattern and re-measure when the sheet settles. The
  // native-stack events are not on the untyped navigation's event map, so the
  // listener registration is structurally typed here.
  const navigation = useNavigation();
  useEffect(() => {
    const addListener = navigation.addListener as
      | ((event: string, callback: () => void) => (() => void) | undefined)
      | undefined;
    const removeTransition = addListener?.('transitionEnd', remeasureWindowTop);
    const removeDetent = addListener?.('sheetDetentChange', remeasureWindowTop);
    return () => {
      removeTransition?.();
      removeDetent?.();
    };
  }, [navigation, remeasureWindowTop]);
  // Native row direction and logical margin keep Cancel/Share leading and Done
  // trailing. Do not derive sides from i18n.dir() or the stale I18nManager.isRTL.
  return (
    // collapsable={false}: react-native-screens lays out a formSheet's scroll
    // view by finding the header at the screen content's subview index 0 — a
    // flattened header breaks that native pass and the list paints over it.
    <View
      ref={setContainerRef}
      collapsable={false}
      className="border-b border-border bg-background px-4 pb-3 pt-4"
      onLayout={remeasureWindowTop}
    >
      <View style={safeAreaStyle}>
        <View className="min-h-11 flex-row items-center gap-x-3">
          {onShare !== undefined ? (
            <Pressable
              onPress={onShare}
              disabled={sharing || disabled}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common.share', { title })}
              accessibilityState={{ disabled: sharing || disabled, busy: sharing }}
              className="min-h-11 min-w-11 shrink-0 items-center justify-center px-2 py-2 active:opacity-70 disabled:opacity-50"
            >
              <Share size={20} color={colors.foreground} />
            </Pressable>
          ) : null}
          {onCancel ? (
            <Pressable
              onPress={onCancel}
              disabled={disabled}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={resolvedCancelLabel}
              className="min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 py-2 active:opacity-70 disabled:opacity-50"
            >
              <Text
                className="text-center text-base font-medium text-foreground"
                numberOfLines={1}
                ellipsizeMode="clip"
              >
                {resolvedCancelLabel}
              </Text>
            </Pressable>
          ) : null}
          {/* min-w-0 lets the title shrink below its content width so it truncates
            instead of pushing the trailing action out of the row. Cancel and
            Done bracket the title, so center it between them; without Cancel the
            title stays leading against the sheet edge. */}
          <View className="min-w-0 shrink grow">
            <Text
              className={cn('text-lg font-semibold text-foreground', onCancel && 'text-center')}
              numberOfLines={2}
              ellipsizeMode={titleEllipsis}
              accessibilityRole="header"
              accessibilityLabel={title}
            >
              {title}
            </Text>
          </View>
          <Pressable
            onPress={onDone}
            disabled={disabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={resolvedDoneLabel}
            className="ms-auto min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 py-2 active:opacity-70 disabled:opacity-50 will-change-pressable"
          >
            <Text
              className="text-center text-base font-medium text-foreground"
              numberOfLines={1}
              ellipsizeMode="clip"
            >
              {resolvedDoneLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
