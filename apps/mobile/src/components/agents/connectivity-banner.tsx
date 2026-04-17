import { View } from 'react-native';
import { WifiOff } from 'lucide-react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function ConnectivityBanner() {
  const colors = useThemeColors();
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
      <View className="flex-row items-center justify-center gap-2 bg-yellow-50 px-4 py-2 dark:bg-yellow-950">
        <WifiOff size={14} color={colors.mutedForeground} />
        <Text className="text-sm text-muted-foreground">No internet connection</Text>
      </View>
    </Animated.View>
  );
}
