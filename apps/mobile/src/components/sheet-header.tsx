import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Share } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { type SheetHeaderTopInset, useSheetHeaderTopClearance } from '@/lib/form-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { useScreenInsets } from '@/lib/screen-insets';

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
  surfaceClassName = 'bg-background',
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
  /**
   * The surface the sheet paints behind the header. A sheet that sits on the
   * raised dark surface passes `bg-card` so its top edge separates from the
   * near-black window behind it; the app canvas colour is the default.
   */
  surfaceClassName?: string;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useScreenInsets();
  const resolvedDoneLabel = doneLabel ?? t('common.done');
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  const doneUnavailable = disabled || doneDisabled;
  // The top clearance comes from the same rule (and the same inputs) as the
  // detent cap, so the header and the sheet edge cannot disagree about who
  // clears the status bar. It is known before the first frame, so the header
  // paints once, already settled, instead of moving by the inset.
  const topInsetHeight = useSheetHeaderTopClearance(topInset);
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
    <View
      collapsable={false}
      className={cn('border-b border-border px-4 pb-3 pt-4', surfaceClassName)}
    >
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
            disabled={doneUnavailable}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={resolvedDoneLabel}
            className="ms-auto min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-md px-2 py-2 active:opacity-70 disabled:opacity-50 will-change-pressable"
          >
            {/* The muted ink alone is a mid gray; the control's disabled
                opacity is what makes it read as unavailable. The enabled label
                keeps the accent at full strength, so the accent is the only
                state that reads ready. */}
            <Text
              className={cn(
                'text-center text-base font-semibold',
                doneUnavailable ? 'text-muted-foreground' : 'text-primary'
              )}
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
