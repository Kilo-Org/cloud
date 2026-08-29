import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

export function SettingsRecoveryStatus({
  message,
  isRetrying,
  onRetry,
}: Readonly<{
  message?: string;
  isRetrying: boolean;
  onRetry: () => void;
}>) {
  const { t } = useTranslation();

  return (
    <View className="flex-row items-center justify-end gap-2">
      <AccessibleStatus
        message={isRetrying ? null : (message ?? null)}
        className="flex-1 text-xs"
      />
      <Button
        variant="outline"
        className="min-w-11"
        onPress={onRetry}
        loading={isRetrying}
        accessibilityLabel={t('common.retry')}
      >
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}
