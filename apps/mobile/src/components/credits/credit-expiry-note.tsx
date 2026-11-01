import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { isolateBidiText } from '@/lib/bidi';
import { getNextCreditExpiry } from '@/lib/credits/credit-expiry';
import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

type CreditExpiryNoteProps = {
  creditBlocks: Parameters<typeof getNextCreditExpiry>[0];
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

export function CreditExpiryNote({ creditBlocks, emptyMessage }: Readonly<CreditExpiryNoteProps>) {
  const { t, i18n } = useTranslation();
  const nextExpiry = getNextCreditExpiry(creditBlocks);
  if (!nextExpiry) {
    return emptyMessage ? (
      <Text className="text-xs text-muted-foreground">{emptyMessage}</Text>
    ) : null;
  }

  return (
    <Text className="text-xs text-muted-foreground">
      {bindUtcMarker(
        t('credits.nextExpiry', {
          date: formatDate(parseTimestamp(nextExpiry.expiryDate), i18n.language, {
            timeZone: 'UTC',
          }),
        })
      )}
    </Text>
  );
}
