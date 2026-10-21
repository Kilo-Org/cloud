import { type LucideIcon } from '@/components/ui/icons';
import { Pressable, Switch, View } from 'react-native';

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
}: PreferenceRowProps) {
  const colors = useThemeColors();
  return (
    <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
      <Pressable
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70"
        disabled={disabled}
        onPress={() => {
          onValueChange(!value);
        }}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : (
          <Icon size={18} color={colors.secondaryForeground} />
        )}
        <View accessible={false} importantForAccessibility="no" className="min-w-0 flex-1">
          {/* Disabled cue is the muted title, not row opacity — see the same
              pattern in notifications-screen's CategoryRow. */}
          <Text
            accessible={false}
            importantForAccessibility="no"
            className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}
          >
            {title}
          </Text>
          <Text
            accessible={false}
            importantForAccessibility="no"
            variant="muted"
            className="mt-0.5 text-xs"
          >
            {subtitle}
          </Text>
        </View>
      </Pressable>
      <Switch
        value={value}
        disabled={disabled}
        accessibilityLabel={title}
        accessibilityHint={subtitle}
        accessibilityState={{ disabled, busy, checked: value }}
        onValueChange={onValueChange}
      />
    </View>
  );
}
