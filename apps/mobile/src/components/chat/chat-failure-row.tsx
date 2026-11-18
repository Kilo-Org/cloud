import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AddCreditsRow } from '@/components/add-credits-row';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type AddCreditsDestination, addCreditsProps } from '@/lib/credits/add-credits-destination';

/**
 * The retained failure of an idle chat, in fixed copy.
 *
 * One action answers what failed: Retry when no question waits for an answer,
 * and Add credits when the account could not pay for the send. An unanswered
 * question carries its own Retry on the message, so this row then states why
 * and offers the action the message cannot: settling the bill.
 */
export function ChatFailureRow({
  failureKey,
  onRetry,
  addCredits,
}: Readonly<{
  failureKey: string;
  onRetry?: () => void;
  addCredits?: AddCreditsDestination;
}>) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 px-4 py-2">
      <AccessibleStatus message={t(failureKey)} tone="error" className="flex-1 text-sm" />
      {/* Add credits is the element that owns the platform's gate for the
          balance it settles, so an organization's page is offered only where
          that page may open, and the row then draws no control at all. */}
      {addCredits === undefined ? null : <AddCreditsRow inline {...addCreditsProps(addCredits)} />}
      {onRetry ? (
        <Button variant="outline" size="sm" className={STATE_ACTION_CLASS} onPress={onRetry}>
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
