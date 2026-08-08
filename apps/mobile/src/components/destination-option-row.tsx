import { type LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type DestinationOptionRowProps = {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  /** Renders a trailing spinner while this row's action runs. */
  busy?: boolean;
};

/**
 * One destination row shared by the share gate's connected-CLI list and the
 * "Continue in a new session" picker: round icon tile, bold title, muted
 * subtitle. Keep the markup in this one component.
 */
export function DestinationOptionRow({
  icon: Icon,
  title,
  subtitle,
  accessibilityLabel,
  onPress,
  disabled = false,
  busy = false,
}: Readonly<DestinationOptionRowProps>) {
  const colors = useThemeColors();

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      className={`flex-row items-center gap-3 border-b border-border px-4 py-3.5 ${
        disabled ? 'opacity-50' : 'active:opacity-70'
      }`}
    >
      <View className="h-9 w-9 items-center justify-center rounded-full bg-secondary">
        <Icon size={18} color={colors.foreground} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text className="text-sm text-muted-foreground" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      {busy ? <ActivityIndicator size="small" color={colors.foreground} /> : null}
    </Pressable>
  );
}
