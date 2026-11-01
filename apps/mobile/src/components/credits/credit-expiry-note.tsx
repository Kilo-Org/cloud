import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { isolateBidiText } from '@/lib/bidi';
import { getNextCreditExpiry } from '@/lib/credits/credit-expiry';
import { formatDate, formatMoney } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

type CreditExpiryNoteProps = {
  creditBlocks: Parameters<typeof getNextCreditExpiry>[0];
  /**
   * The balance the surface renders directly above the note, in dollars. When
   * the earliest-expiring credits add up to exactly that balance, naming the
   * amount again would only repeat the large number above it, so the note drops
   * it. When they do not, the amount is the only place that says how much of the
   * balance expires on this date, so the note keeps it.
   */
  shownBalanceDollars?: number;
  hiddenAmount?: string;
  emptyMessage?: string;
};

/**
 * The zone marker a catalog writes right after `{{date}}`. It is ASCII in every
 * catalog that has one, because Japanese and Korean localize the parentheses; a
 * miss leaves the sentence exactly as the catalog wrote it.
 */
const UTC_MARKER = ' (UTC)';

/**
 * Keep the marker on the date's line, in its own direction. A breakable space
 * let a wrapped marker start the next line, and in a right-to-left sentence bidi
 * ordering then places it at the end of the following sentence, where the zone no
 * longer reads as part of the date. The no-break space and the isolate leave the
 * sentence free to wrap anywhere else.
 */
function bindUtcMarker(sentence: string): string {
  return sentence.replace(UTC_MARKER, `\u00A0${isolateBidiText('(UTC)')}`);
}

export function CreditExpiryNote({
  creditBlocks,
  shownBalanceDollars,
  hiddenAmount,
  emptyMessage,
}: Readonly<CreditExpiryNoteProps>) {
  const { t, i18n } = useTranslation();
  const nextExpiry = getNextCreditExpiry(creditBlocks);
  if (!nextExpiry) {
    return emptyMessage ? (
      <Text className="text-xs text-muted-foreground">{emptyMessage}</Text>
    ) : null;
  }

  const date = formatDate(parseTimestamp(nextExpiry.expiryDate), i18n.language, {
    timeZone: 'UTC',
  });
  // Decide from what the reader sees: `formatMoney` pins two decimals, so a
  // sub-cent residual must not turn into "$0.00 in credits expires", and a
  // balance and an expiring sum that render the same must not be repeated.
  const expiringAmount = formatMoney(
    fromMicrodollars(nextExpiry.balanceMicrodollars),
    i18n.language
  );
  const showsAmount =
    expiringAmount !== formatMoney(0, i18n.language) &&
    (shownBalanceDollars === undefined ||
      expiringAmount !== formatMoney(shownBalanceDollars, i18n.language));
  const dateOnlySentence = bindUtcMarker(t('credits.nextExpiryDate', { date }));
  // The mask is for the reader's eyes only: a screen reader hears the date
  // sentence instead of the asterisks, matching the balance above it.
  const masked = showsAmount && hiddenAmount !== undefined;

  return (
    <Text
      className="text-xs text-muted-foreground"
      accessibilityLabel={masked ? t('credits.nextExpiryDate', { date }) : undefined}
    >
      {showsAmount
        ? bindUtcMarker(
            t('credits.nextExpiry', {
              amount: hiddenAmount ?? expiringAmount,
              date,
            })
          )
        : dateOnlySentence}
    </Text>
  );
}
