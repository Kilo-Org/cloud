import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ScreenHeaderProps = {
  title: string;
  headerRight?: React.ReactNode;
};

export function ScreenHeader({ title, headerRight }: Readonly<ScreenHeaderProps>) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const colors = useThemeColors();
  const canGoBack = router.canGoBack();

  return (
    <View className="bg-background px-4 pb-3" style={{ paddingTop: insets.top + 8 }}>
      <View className="flex-row items-center justify-between">
        <View className="flex-1 flex-row items-center gap-1">
          {canGoBack && (
            <Pressable
              onPress={() => {
                router.back();
              }}
              hitSlop={12}
              accessibilityLabel="Go back"
              className="-ml-1 mr-1 active:opacity-70"
            >
              <ChevronLeft size={24} color={colors.foreground} />
            </Pressable>
          )}
          <Text className="text-lg font-semibold" numberOfLines={1}>
            {title}
          </Text>
        </View>
        {headerRight}
      </View>
    </View>
  );
}
