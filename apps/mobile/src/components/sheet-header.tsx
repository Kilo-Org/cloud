import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StatusBar, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
 *   lets the sheet surface reach the top of the window, and the detent cap
 *   keeps a sheet with a window top inset below the status bar. So the header
 *   reserves the inset (and its landscape cutout padding) only while the
 *   window has no top inset of its own — the sheet edge is then at the window
 *   top and the status bar sits over it.
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
  doneDisabled = false,
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
  /** Disables both controls. Use `doneDisabled` when only the commit waits. */
  disabled?: boolean;
  /**
   * Disables the Done control alone, so Cancel still closes a sheet that is
   * saving. A full-window sheet has no drag dismissal left, so Cancel is the
   * only way out while a write is in flight.
   */
  doneDisabled?: boolean;
  topInset?: SheetHeaderTopInset;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useScreenInsets();
  const windowTopInset = useSafeAreaInsets().top;
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
  // On Android a bottom formSheet surface reaches the window top only when the
  // window has no top inset of its own; every detent the cap
  // (`useFormSheetDetents`) allows otherwise already places the sheet edge
  // below the status bar, so reserving the inset there would only put a dead
  // band above the title. The window inset answers that before the sheet
  // mounts, which is what keeps the first painted frame right: a measurement
  // taken at mount reports the frame before the sheet presents, so acting on
  // it would reserve the inset and then drop it once the detent lands.
  // Read the window's own inset rather than `useScreenInsets`, which floors a
  // side status area to 24.
  const dropsTopInset =
    topInset === 'ios-page-sheet' ||
    topInset === 'never' ||
    (topInset === 'bottom-form-sheet' && (Platform.OS !== 'android' || windowTopInset > 0));
  const topInsetHeight = dropsTopInset ? 0 : resolvedTopInset;
  const safeAreaStyle =
    topInsetHeight > 0 || insets.left > 0 || insets.right > 0
      ? {
          ...(topInsetHeight > 0 ? { paddingTop: topInsetHeight } : undefined),
          ...(insets.left > 0 ? { paddingLeft: insets.left } : undefined),
          ...(insets.right > 0 ? { paddingRight: insets.right } : undefined),
        }
      : undefined;
  // Native row direction and logical margin keep Cancel/Share leading and Done
  // trailing. Do not derive sides from i18n.dir() or the stale I18nManager.isRTL.
  return (
    // collapsable={false}: react-native-screens lays out a formSheet's scroll
    // view by finding the header at the screen content's subview index 0 — a
    // flattened header breaks that native pass and the list paints over it.
    <View collapsable={false} className="border-b border-border bg-background px-4 pb-3 pt-4">
      <View style={safeAreaStyle}>
        <View className="min-h-[48px] flex-row items-center gap-x-3">
          {onShare !== undefined ? (
            <Pressable
              onPress={onShare}
              disabled={sharing || disabled}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common.share', { title })}
              accessibilityState={{ disabled: sharing || disabled, busy: sharing }}
              className="min-h-[48px] min-w-[48px] shrink-0 items-center justify-center px-2 py-2 active:opacity-70 disabled:opacity-50"
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
              className="min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-md px-2 py-2 active:opacity-70 disabled:opacity-50"
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
          {/* The trailing control commits what the sheet holds, so it carries
              the accent weight and colour while the leading Cancel stays a
              neutral label. Both keep the same hit box. */}
          <Pressable
            onPress={onDone}
            disabled={disabled || doneDisabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={resolvedDoneLabel}
            className="ms-auto min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-md px-2 py-2 active:opacity-70 disabled:opacity-50 will-change-pressable"
          >
            <Text
              className="text-center text-base font-semibold text-primary"
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
