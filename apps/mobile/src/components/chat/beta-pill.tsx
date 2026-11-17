import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

/** Says, everywhere the chat is shown, that the chat is not finished yet. */
export function BetaPill() {
  const { t } = useTranslation();
  return (
    <View className="rounded-full border border-border bg-secondary px-2 py-0.5">
      <Text variant="eyebrow">
        {t('modelChat.beta')}
      </Text>
    </View>
  );
}
