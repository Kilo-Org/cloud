import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/** The retained failure of an idle chat whose last question was answered, with its Retry. */
export function ChatFailureRow({
  failureKey,
  onRetry,
}: Readonly<{ failureKey: string; onRetry: () => void }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 px-4 py-2">
      <AccessibleStatus message={t(failureKey)} tone="error" className="flex-1 text-sm" />
      <Button variant="outline" size="sm" onPress={onRetry}>
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}
