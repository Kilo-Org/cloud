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
  showBackButton?: boolean;
  onBack?: () => void;
  onTitlePress?: () => void;
};

export function ScreenHeader({
  title,
  headerRight,
  modal,
  showBackButton,
  onBack,
  onTitlePress,
}: Readonly<ScreenHeaderProps>) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const colors = useThemeColors();
  const canGoBack = showBackButton ?? router.canGoBack();

  // iOS modals are presented as cards already inset from the status bar
  const paddingTop = modal && Platform.OS === 'ios' ? 32 : insets.top + 8;

  return (
    <View className="bg-background px-4 pb-3" style={{ paddingTop }}>
      <View className="flex-row items-center">
        <View className="flex-1 flex-row items-center gap-1">
          {canGoBack && (
            <Pressable
              onPress={() => {
                if (onBack) {
                  onBack();
                } else {
                  router.back();
                }
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
          {onTitlePress ? (
            <Pressable
              onPress={onTitlePress}
              hitSlop={8}
              className="flex-row items-center gap-1 active:opacity-70"
            >
              <Text className="shrink text-lg font-semibold" numberOfLines={1}>
                {title}
              </Text>
              <ChevronDown size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : (
            <Text className="shrink text-lg font-semibold" numberOfLines={1}>
              {title}
            </Text>
          )}
        </View>
        {headerRight ? <View className="ml-3 shrink-0">{headerRight}</View> : null}
      </View>
    </View>
  );
}
