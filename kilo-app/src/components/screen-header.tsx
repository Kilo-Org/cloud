import { useRouter } from 'expo-router';
import { ChevronDown, ChevronLeft } from 'lucide-react-native';
import { Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ScreenHeaderProps = {
  title: string;
  headerRight?: React.ReactNode;
  modal?: boolean;
};

export function ScreenHeader({ title, headerRight, modal }: Readonly<ScreenHeaderProps>) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const colors = useThemeColors();
  const canGoBack = router.canGoBack();

  // iOS modals are presented as cards already inset from the status bar
  const paddingTop = modal && Platform.OS === 'ios' ? 32 : insets.top + 8;

  return (
    <View className="bg-background px-4 pb-3" style={{ paddingTop }}>
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
              {modal && Platform.OS === 'ios' ? (
                <ChevronDown size={24} color={colors.foreground} />
              ) : (
                <ChevronLeft size={24} color={colors.foreground} />
              )}
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
