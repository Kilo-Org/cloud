import { useTranslation } from 'react-i18next';
import { Platform, Pressable, StatusBar, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Share } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * How much top clearance the header reserves:
 *
 * - 'always': the surface owns the top of the window (full-screen modals,
 *   pageSheets), so the status-bar inset applies whenever it is non-zero.
 * - 'bottom-form-sheet': a bottom-anchored formSheet never draws under the
 *   status bar. The detent heights are capped just below the top inset
 *   (useFormSheetDetents) and the keyboard expansion reuses that same capped
 *   full detent, so the constant window inset would only be a dead band
 *   above the header (p7) — Android gets no top clearance. iOS insets are
 *   sheet-relative and rise exactly when the sheet reaches the status bar,
 *   so iOS keeps them.
 */
export type SheetHeaderTopInset = 'always' | 'bottom-form-sheet';

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
  const insets = useSafeAreaInsets();
  const resolvedDoneLabel = doneLabel ?? t('common.done');
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  // Reserve top clearance as well as landscape cutout clearance inside the
  // gutters. Keeping the inset on an inner wrapper preserves the header's own
  // padding. Android can report top: 0 for the frame a freshly presented
  // sheet first lays out (before the insets propagate); fall back to the
  // synchronous status-bar height the same way the form-sheet detents do.
  const androidStatusBarHeight = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0;
  const resolvedTopInset = insets.top > 0 ? insets.top : androidStatusBarHeight;
  const topInsetHeight =
    topInset === 'bottom-form-sheet' && Platform.OS === 'android' ? 0 : resolvedTopInset;
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
              className="min-h-11 min-w-11 shrink-0 items-center justify-center px-2 py-2 active:opacity-70 disabled:opacity-50"
            >
              <Text className="text-center text-base font-medium text-foreground">
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
            className="ms-auto min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-secondary px-4 py-2 active:opacity-70 disabled:opacity-50 will-change-pressable"
          >
            <Text className="text-center text-base font-medium text-foreground">
              {resolvedDoneLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
