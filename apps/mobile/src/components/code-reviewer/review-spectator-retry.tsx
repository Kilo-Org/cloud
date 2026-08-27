import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

export function CompactRetry({ onPress }: Readonly<{ onPress: () => void }>) {
  const { t } = useTranslation();
  return (
    <View className="items-center px-4 pt-2">
      <Button variant="outline" size="sm" onPress={onPress}>
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}
