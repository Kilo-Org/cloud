import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

export function CompactionSeparator() {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 py-3">
      <View className="h-[0.5px] flex-1 bg-hair-soft" />
      <Text className="font-mono-medium text-[11px] uppercase tracking-[1px] text-muted-foreground">
        {t('agentChat.compaction.contextCompacted')}
      </Text>
      <View className="h-[0.5px] flex-1 bg-hair-soft" />
    </View>
  );
}
