import { type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { CreditExpiryNote } from '@/components/credits/credit-expiry-note';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/** One `caption` line at scale 1, the height the design gate measured in dp. */
const CAPTION_LINE_DP = 14.1;
/** Lines a funded expiry sentence takes at this card's width and scale 1. */
const FUNDED_NOTE_LINES = 2;

type CreditsNoteSlotProps = Readonly<{
  /** The member amount's scope caption; null when the amount is the organization's own. */
  readonly scope: ReactNode;
  /** The credits read failed, so no expiry can be named. */
  readonly failed: boolean;
  /**
   * The identity read failed while the organization's amount still paints from
   * its membership row, so this slot carries the way back to the credits.
   */
  readonly retryable: boolean;
  /** The credits read has not answered yet. */
  readonly pending: boolean;
  /** Absent while the credits read is pending or failed, so no expiry is named. */
  readonly creditBlocks?: ComponentProps<typeof CreditExpiryNote>['creditBlocks'];
  readonly hiddenAmount: string | undefined;
  readonly emptyMessage: string;
  readonly onRetry: () => void;
  readonly fontScale: number;
}>;

/**
 * The note under the credits amount: the member's scope caption, then the
 * expiry note or the exit that replaces it. No entrance fade — the caption
 * holds a row of this block, so a fade that paints it late leaves it empty.
 *
 * The expiry slot is a fixed box in every state: a funded account's sentence
 * ("… in credits expires … Credits with the earliest expiry are used first.")
 * wraps to two `caption` lines at this card's width and scale 1, the empty
 * message is one line and the loading bar is one. A one-line slot grew the
 * card by about 14 dp when funded credits landed and moved every row below it
 * (Profile held-loading gate target, 2026-11-20).
 *
 * Both the line's height and the sentence's line count grow with the font
 * scale, and the count grows faster than the scale: the column keeps its width
 * in dp while every glyph widens, so a sentence that takes two lines at scale 1
 * takes about four at Android's largest scale. Reserving only `2 × scale` lines
 * left the box one line short from about scale 1.5 and grew the card when a
 * funded note landed — the shift this slot exists to prevent.
 */
export function CreditsNoteSlot({
  scope,
  failed,
  retryable,
  pending,
  creditBlocks,
  hiddenAmount,
  emptyMessage,
  onRetry,
  fontScale,
}: CreditsNoteSlotProps) {
  const { t } = useTranslation();
  const noteLines = Math.ceil(FUNDED_NOTE_LINES * fontScale);

  let failure: ReactNode = (
    <Text className="text-xs text-muted-foreground">{t('credits.expiryUnavailable')}</Text>
  );
  if (retryable) {
    failure = (
      <View>
        <AccessibleStatus message={t('credits.expiryUnavailable')} className="text-sm" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
          accessibilityHint={t('credits.expiryUnavailable')}
          onPress={onRetry}
          className={cn(STATE_ACTION_CLASS, 'flex-row items-center gap-2 active:opacity-70')}
        >
          <Text className="text-sm text-primary">{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      {scope}
      <View
        testID="credits-expiry-slot"
        style={{ minHeight: CAPTION_LINE_DP * fontScale * noteLines }}
      >
        {failed && failure}
        {!failed && pending && (
          // The bar stands in for one `caption` line (14.1pt tall), so it takes
          // that line's height: a shorter bar lifted the value column, and the
          // row's centering moved the amount itself when the note landed.
          <Skeleton className="h-4 w-40 max-w-full rounded bg-muted-soft" />
        )}
        {!failed && !pending && creditBlocks !== undefined && (
          <CreditExpiryNote
            creditBlocks={creditBlocks}
            hiddenAmount={hiddenAmount}
            emptyMessage={emptyMessage}
          />
        )}
      </View>
    </>
  );
}
