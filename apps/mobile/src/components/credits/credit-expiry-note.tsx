import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { isolateBidiText } from '@/lib/bidi';
import { getNextCreditExpiry } from '@/lib/credits/credit-expiry';
import { formatDate, formatMoney } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

type CreditExpiryNoteProps = {
  creditBlocks: Parameters<typeof getNextCreditExpiry>[0];
  hiddenAmount?: string;
  emptyMessage?: string;
};

/**
 * The zone the catalogs write right after `{{date}}`: ASCII parentheses in most
 * languages, full-width ones in Chinese. A catalog without a zone marker keeps
 * its sentence unchanged.
 */
const ZONE_MARKER = /(\s?)(\(UTC\)|（UTC）)/;

/**
 * Keep the zone on the date's line, in its own direction. A breakable space let
 * a wrapped marker start the next line, and a right-to-left sentence then reads
 * that marker after the following sentence, detached from the date. The
 * no-break space and the isolate leave the rest of the sentence free to wrap.
 * A catalog that writes the marker with no space, such as Chinese with its
 * full-width parentheses, keeps that spacing.
 */
function keepZoneWithDate(sentence: string): string {
  return sentence.replace(ZONE_MARKER, (_match, space: string, marker: string) => {
    const glue = space ? '\u00A0' : '';
    return `${glue}${isolateBidiText(marker)}`;
  });
}

export function CreditExpiryNote({
  creditBlocks,
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

  return (
    <Text className="text-xs text-muted-foreground">
      {keepZoneWithDate(
        t('credits.nextExpiry', {
          amount:
            hiddenAmount ??
            formatMoney(fromMicrodollars(nextExpiry.balanceMicrodollars), i18n.language),
          date: formatDate(parseTimestamp(nextExpiry.expiryDate), i18n.language, {
            timeZone: 'UTC',
          }),
        })
      )}
    </Text>
  );
}
