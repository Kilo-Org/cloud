import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

/** Says, everywhere the chat is shown, that the chat is not finished yet. */
export function BetaPill() {
  const { t } = useTranslation();
  return (
    <View className="rounded-full border border-border bg-secondary px-2 py-0.5">
      <Text className="font-mono-medium text-[10px] uppercase leading-4 tracking-[0.2px] text-muted-foreground">
        {t('modelChat.beta')}
      </Text>
    </View>
  );
}
