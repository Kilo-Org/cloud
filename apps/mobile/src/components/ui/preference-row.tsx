import { type LucideIcon } from '@/components/ui/icons';
import { Switch, View } from 'react-native';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type PreferenceRowProps = Readonly<{
  icon: LucideIcon;
  title: string;
  subtitle: string;
  value: boolean;
  disabled: boolean;
  busy?: boolean;
  onValueChange: (next: boolean) => void;
  /**
   * Accessibility label for the switch. Defaults to the row title; pass an
   * action label when the title names the setting and the action differs
   * (e.g. "Default profile" row whose switch says "Remove as default").
   */
  switchAccessibilityLabel?: string;
}>;

/** Switch row shaped like the Notifications category row. */
export function PreferenceRow({
  icon: Icon,
  title,
  subtitle,
  value,
  disabled,
  busy = false,
  onValueChange,
  switchAccessibilityLabel,
}: PreferenceRowProps) {
  const colors = useThemeColors();
  return (
    <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      {busy ? (
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      ) : (
        <Icon size={18} color={colors.secondaryForeground} />
      )}
      <View className="flex-1">
        {/* Disabled cue is the muted title, not row opacity — see the same
            pattern in notifications-screen's CategoryRow. */}
        <Text className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}>
          {title}
        </Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {subtitle}
        </Text>
      </View>
      <Switch
        value={value}
        disabled={disabled}
        accessibilityLabel={switchAccessibilityLabel ?? title}
        accessibilityState={{ disabled, busy }}
        onValueChange={onValueChange}
      />
    </View>
  );
}
