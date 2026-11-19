import { AlertTriangle } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { RefusalStatus } from '@/components/refusal-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type TrialRefusalAction } from '@/lib/trial-refusal';
import { cn } from '@/lib/utils';

/**
 * Durable failure card for a Security Agent command that failed before the
 * server accepted a command id (no command observer will reconcile it). Shows
 * the stored `lastError`; a retryable failure offers Retry and Discard, a
 * non-retryable one keeps the card but hides Retry (the draft stays so the
 * state survives restart).
 *
 * The copy renders through `RefusalStatus` so a stored trial refusal offers the
 * same under-copy step as every other refusal surface, for the reader who can
 * take it. Retry and Discard stay the card's own controls: the step ends the
 * refusal, it does not retry the command.
 */
type SecurityCommandRetryCardProps = {
  lastError: string;
  retryable: boolean;
  /** The step that ends a trial refusal, when this reader can take it. */
  action?: TrialRefusalAction;
  onRetry?: () => void;
  onDiscard?: () => void;
};

export function SecurityCommandRetryCard({
  lastError,
  retryable,
  action,
  onRetry,
  onDiscard,
}: Readonly<SecurityCommandRetryCardProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="gap-3 rounded-lg border border-destructive bg-red-50 p-3 dark:bg-red-950">
      <View className="flex-row items-start gap-2">
        <AlertTriangle size={16} color={colors.destructive} className="mt-0.5" />
        <View className="flex-1">
          <RefusalStatus message={lastError} action={action} className="text-sm" />
        </View>
      </View>
      {retryable ? (
        <View className="flex-row gap-2">
          <Button size="sm" className={cn(STATE_ACTION_CLASS, 'flex-1')} onPress={onRetry}>
            <Text>{t('common.retry')}</Text>
          </Button>
          {onDiscard ? (
            <Button size="sm" variant="ghost" onPress={onDiscard}>
              <Text>{t('common.discard')}</Text>
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
