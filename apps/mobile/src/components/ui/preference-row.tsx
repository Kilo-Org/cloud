import { type LucideIcon } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
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
   * The subtitle this row shows when its own state stops the preference from
   * applying, so the row can say why it is inert instead of leaving a greyed
   * switch unexplained. Only the visible subtitle is painted and announced; the
   * other one is laid out invisibly underneath it, so the row keeps the taller
   * of the two in every language and never resizes when the caller swaps them.
   */
  inactiveSubtitle?: string;
  /**
   * The value a press should flip. Defaults to the rendered `value`, which is
   * the last render, so two presses inside one frame both flip the same state
   * and the second one repeats the first. A store that lags its own writes
   * passes its newest requested value here, and every press then flips the
   * state the person last asked for.
   */
  resolveValue?: () => boolean;
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
  inactiveSubtitle,
  resolveValue,
}: PreferenceRowProps) {
  const colors = useThemeColors();
  // Both ways of moving the switch flip the same value: a tap on the row and a
  // tap on the thumb can arrive in either order, and a burst must not build one
  // flip from the rendered value and the next from the native thumb state.
  const flip = () => {
    onValueChange(!(resolveValue?.() ?? value));
  };
  return (
    <View
      className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 rounded-lg bg-secondary p-3')}
    >
      <Pressable
        className={cn(
          ROW_TARGET_CLASS,
          'min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70'
        )}
        disabled={disabled}
        onPress={flip}
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
          {/* Only the visible subtitle is painted and announced. When the
              caller passes both, full-width overlapping copies reserve the
              taller one in native layout — the idiom in form-field's reserved
              error area — so swapping them cannot change the row's height in
              any language, font scale or width, without measuring. */}
          {inactiveSubtitle === undefined ? (
            <Text
              accessible={false}
              importantForAccessibility="no"
              variant="muted"
              className="mt-0.5 text-xs"
            >
              {subtitle}
            </Text>
          ) : (
            <View className="mt-0.5">
              <View
                className="flex-row opacity-0"
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Text variant="muted" className="w-full shrink-0 text-xs">
                  {subtitle}
                </Text>
                <Text variant="muted" className="-ms-[100%] w-full shrink-0 text-xs">
                  {inactiveSubtitle}
                </Text>
              </View>
              <View className="absolute inset-x-0 top-0">
                <Text
                  accessible={false}
                  importantForAccessibility="no"
                  variant="muted"
                  className="text-xs"
                >
                  {subtitle}
                </Text>
              </View>
            </View>
          )}
        </View>
      </Pressable>
      <Switch
        value={value}
        disabled={disabled}
        accessibilityLabel={title}
        accessibilityHint={subtitle}
        accessibilityState={{ disabled, busy, checked: value }}
        onValueChange={flip}
      />
    </View>
  );
}
