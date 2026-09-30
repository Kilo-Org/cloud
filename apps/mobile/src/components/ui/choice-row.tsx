import * as Haptics from 'expo-haptics';
import { Check } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type ChoiceRowProps = {
  /** Ignored when `children` is given. */
  label?: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** Marks the row as busy for a11y, e.g. while its own save is in flight. */
  busy?: boolean;
  /** Renders `accessibilityRole="checkbox"` instead of `"radio"`. */
  multi?: boolean;
  /**
   * Overrides the announced role. Use `"button"` for a row that navigates
   * instead of selecting, so assistive tech does not announce an unselected
   * radio/checkbox that can never be selected. A button row reports no
   * `checked` state.
   */
  role?: 'radio' | 'checkbox' | 'button';
  /** Extra classes on the row container, e.g. a divider border. */
  className?: string;
  /** Custom row content instead of the default label/description text — e.g. an icon-prefixed row. */
  children?: ReactNode;
};

/**
 * Shared radio/checkbox-style selection row. Owns the selection haptic —
 * callers must NOT fire their own `Haptics.selectionAsync()` on press.
 */
export function ChoiceRow({
  label,
  description,
  selected,
  onPress,
  disabled,
  busy,
  multi,
  role,
  className,
  children,
}: Readonly<ChoiceRowProps>) {
  const colors = useThemeColors();

  const resolvedRole = role ?? (multi ? 'checkbox' : 'radio');

  return (
    <Pressable
      className={cn(
        'min-h-11 flex-row items-center justify-between py-3 active:opacity-70',
        disabled && 'opacity-50',
        className
      )}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole={resolvedRole}
      accessibilityState={
        resolvedRole === 'button'
          ? { disabled: Boolean(disabled), busy }
          : { checked: selected, disabled: Boolean(disabled), busy }
      }
    >
      {children ?? (
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium">{label}</Text>
          {description ? (
            <Text variant="muted" className="mt-0.5 text-xs">
              {description}
            </Text>
          ) : null}
        </View>
      )}
      <Check size={18} color={selected ? colors.foreground : 'transparent'} />
    </Pressable>
  );
}
