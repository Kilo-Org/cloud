import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { isolateLtrBidiText } from '@/lib/bidi';
import { getNextCreditExpiry } from '@/lib/credits/credit-expiry';
import { keepZoneWithDate } from '@/lib/credits/expiry-zone';
import { formatDate, formatPrefixedMoney } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

type CreditExpiryNoteProps = {
  creditBlocks: Parameters<typeof getNextCreditExpiry>[0];
  hiddenAmount?: string;
  emptyMessage?: string;
};

export function CreditExpiryNote({
  creditBlocks,
  hiddenAmount,
  emptyMessage,
}: Readonly<CreditExpiryNoteProps>) {
  const { t, i18n } = useTranslation();
  const nextExpiry = getNextCreditExpiry(creditBlocks);
  if (!nextExpiry) {
    return emptyMessage ? <Text variant="caption">{emptyMessage}</Text> : null;
  }

  return (
    <Text variant="caption">
      {keepZoneWithDate(
        t('credits.nextExpiry', {
          amount:
            hiddenAmount ??
            isolateLtrBidiText(
              formatPrefixedMoney(fromMicrodollars(nextExpiry.balanceMicrodollars), i18n.language)
            ),
          date: formatDate(parseTimestamp(nextExpiry.expiryDate), i18n.language, {
            timeZone: 'UTC',
          }),
        })
      )}
    </Text>
  );
}
