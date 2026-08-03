import { Activity } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function DiagnosticsIndicator() {
  const colors = useThemeColors();
  return (
    <View className="mx-[22px] mb-2 flex-row items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5">
      <Activity size={14} color={colors.mutedForeground} />
      <Text className="text-xs text-muted-foreground">
        Diagnostics on — support is collecting screen state
      </Text>
    </View>
  );
}
