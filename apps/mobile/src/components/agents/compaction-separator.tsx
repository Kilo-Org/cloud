import { View } from 'react-native';

import { Text } from '@/components/ui/text';

export function CompactionSeparator() {
  return (
    <View className="flex-row items-center gap-3 py-3">
      <View className="h-[0.5px] flex-1 bg-hair-soft" />
      <Text className="font-mono-medium text-[11px] uppercase tracking-[1px] text-muted-soft">
        Context compacted
      </Text>
      <View className="h-[0.5px] flex-1 bg-hair-soft" />
    </View>
  );
}
