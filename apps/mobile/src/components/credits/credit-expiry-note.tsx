import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { getNextCreditExpiry } from '@/lib/credits/credit-expiry';
import { formatDate, formatMoney } from '@/lib/format';
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
    return emptyMessage ? (
      <Text className="text-xs text-muted-foreground">{emptyMessage}</Text>
    ) : null;
  }

  return (
    <Text className="text-xs text-muted-foreground">
      {t('credits.nextExpiry', {
        amount:
          hiddenAmount ??
          formatMoney(fromMicrodollars(nextExpiry.balanceMicrodollars), i18n.language),
        date: formatDate(parseTimestamp(nextExpiry.expiryDate), i18n.language, { timeZone: 'UTC' }),
      })}
    </Text>
  );
}
