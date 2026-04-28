import { useRouter } from 'expo-router';
import { ChevronDown, ChevronLeft } from 'lucide-react-native';
import { Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type ScreenHeaderProps = {
  /** Omit to render a bare back-button bar (e.g. when the screen body provides its own title). */
  title?: string;
  /** Optional mono-uppercase line above the title. */
  eyebrow?: string;
  /** Use Focus's large 30px H1 style (list roots). Default 18px (detail). */
  size?: 'default' | 'large';
  headerRight?: React.ReactNode;
  modal?: boolean;
  showBackButton?: boolean;
  onBack?: () => void;
  onTitlePress?: () => void;
  backIcon?: 'back' | 'close';
  /** Extra classes on the outer header container. Overrides the default `px-4` for screens that need a different horizontal inset. */
  className?: string;
};

export function ScreenHeader({
  title,
  eyebrow,
  size = 'default',
  headerRight,
  modal,
  showBackButton,
  onBack,
  onTitlePress,
  backIcon,
  className,
}: Readonly<ScreenHeaderProps>) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const colors = useThemeColors();
  const canGoBack = showBackButton ?? router.canGoBack();

  // iOS modals are presented as cards already inset from the status bar
  const paddingTop = modal && Platform.OS === 'ios' ? 32 : insets.top + 8;

  // When `backIcon` isn't specified, fall back to the historical behaviour
  // where iOS modals get a ChevronDown and everything else gets a ChevronLeft.
  const resolvedBackIcon = backIcon ?? (modal && Platform.OS === 'ios' ? 'close' : 'back');

  const titleClass =
    size === 'large'
      ? 'shrink text-[30px] font-bold tracking-tight text-foreground'
      : 'shrink text-lg font-semibold text-foreground';

  let titleNode: React.ReactNode = null;
  if (title != null) {
    const titleText = (
      <Text className={titleClass} numberOfLines={1}>
        {title}
      </Text>
    );
    titleNode = onTitlePress ? (
      <Pressable
        onPress={onTitlePress}
        hitSlop={8}
        className="flex-row items-center gap-1 active:opacity-70"
      >
        {titleText}
        <ChevronDown size={16} color={colors.mutedForeground} />
      </Pressable>
    ) : (
      titleText
    );
  }

  return (
    <View className={cn('bg-background px-4 pb-3', className)} style={{ paddingTop }}>
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
              {resolvedBackIcon === 'close' ? (
                <ChevronDown size={24} color={colors.foreground} />
              ) : (
                <ChevronLeft size={24} color={colors.foreground} />
              )}
            </Pressable>
          )}
          <View className="flex-1">
            {eyebrow ? <Eyebrow className="mb-0.5">{eyebrow}</Eyebrow> : null}
            {titleNode}
          </View>
        </View>
        {headerRight ? <View className="ml-3 shrink-0">{headerRight}</View> : null}
      </View>
    </View>
  );
}
