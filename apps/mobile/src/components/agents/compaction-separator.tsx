import { View } from 'react-native';
import { Scissors } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function CompactionSeparator() {
  const colors = useThemeColors();

  return (
    <View className="flex-row items-center gap-2 py-2">
      <View className="h-px flex-1 bg-border" />
      <Scissors size={12} color={colors.mutedForeground} />
      <Text className="text-xs text-muted-foreground">Context compacted</Text>
      <View className="h-px flex-1 bg-border" />
    </View>
  );
}
