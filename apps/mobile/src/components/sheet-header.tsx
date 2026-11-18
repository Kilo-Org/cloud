import { type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, type TextInstance, View } from 'react-native';

import { Share, X } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { type SheetHeaderTopInset, useSheetHeaderTopClearance } from '@/lib/form-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { useScreenInsets } from '@/lib/screen-insets';

export function SheetHeader({
  title,
  eyebrow,
  titleRef,
  titleEllipsis = 'tail',
  onDone,
  onCancel,
  doneLabel,
  cancelLabel,
  onShare,
  sharing = false,
  disabled = false,
  doneDisabled = false,
  doneBusy = false,
  variant = 'default',
  topInset = 'always',
  surfaceClassName = 'bg-background',
}: {
  title: string;
  /**
   * One line of context under the title, in the caption role — the reference a
   * form sheet edits, e.g. `owner/repo#128`. It stays on one line with a tail
   * ellipsis, so a long reference cannot grow the header.
   */
  eyebrow?: string;
  /**
   * The title Text itself, for a caller that has to drive TalkBack's reading
   * order from it (an imperative `Sheet` that moves focus to the heading on
   * open). It is the same node the title paints in; a `titleContent` replacement
   * has its own ref.
   */
  titleRef?: Ref<TextInstance>;
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
  /**
   * The commit is in flight: Done dims, stops responding, draws a spinner in
   * its own frame and announces `busy`, so the write reads as pending instead
   * of the sheet looking stuck. Cancel keeps working (see `doneDisabled`).
   */
  doneBusy?: boolean;
  /**
   * `close` draws the single control as an X icon button that closes the sheet:
   * the header a surface with nothing to commit uses (a share gate), instead of
   * a Done label that reads as a commit. There is no leading Cancel and no
   * Share in this variant; the X calls `onDone` and is named by `doneLabel`,
   * which defaults to `common.close`.
   */
  variant?: 'default' | 'close';
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
  const closeOnly = variant === 'close';
  const resolvedDoneLabel = doneLabel ?? (closeOnly ? t('common.close') : t('common.done'));
  const resolvedCancelLabel = cancelLabel ?? t('common.cancel');
  const doneUnavailable = disabled || doneDisabled || doneBusy;
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
  // The busy mark takes the accent the label it replaces carried, so the frame
  // reads as the same control still working. It is the platform indicator rather
  // than the animated wrapper: the wrapper loads Reanimated and the motion
  // policy, and every sheet that paints a header would pay for that import to
  // show a mark. The control announces `busy` itself, so the reduced-motion
  // reading does not depend on the spinner.
  let doneMark: ReactNode = null;
  if (doneBusy) {
    doneMark = <ActivityIndicator size="small" color={colors.primary} />;
  } else if (closeOnly) {
    doneMark = <X size={20} color={doneUnavailable ? colors.mutedForeground : colors.foreground} />;
  } else {
    // The muted ink alone is a mid gray; the control's disabled opacity is what
    // makes it read as unavailable. The enabled label keeps the accent at full
    // strength, so the accent is the only state that reads ready.
    doneMark = (
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
    );
  }
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
          {onShare !== undefined && !closeOnly ? (
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
          {onCancel && !closeOnly ? (
            <Pressable
              onPress={onCancel}
              disabled={disabled}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={resolvedCancelLabel}
              className="min-h-[48px] min-w-[48px] shrink-0 items-start justify-center rounded-md pe-2 py-2 active:opacity-70 disabled:opacity-50"
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
              ref={titleRef}
              className={cn(
                'text-lg font-semibold text-foreground',
                onCancel && !closeOnly && 'text-center'
              )}
              numberOfLines={2}
              ellipsizeMode={titleEllipsis}
              accessibilityRole="header"
              accessibilityLabel={title}
            >
              {title}
            </Text>
            {eyebrow === undefined ? null : (
              <Text
                variant="caption"
                className={cn('mt-0.5', onCancel && !closeOnly && 'text-center')}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {eyebrow}
              </Text>
            )}
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
            accessibilityState={{ disabled: doneUnavailable, busy: doneBusy }}
            className="ms-auto min-h-[48px] min-w-[48px] shrink-0 items-end justify-center rounded-md ps-2 py-2 active:opacity-70 disabled:opacity-50 will-change-pressable"
          >
            {doneMark}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
