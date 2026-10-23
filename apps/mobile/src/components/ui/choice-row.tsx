import * as Haptics from 'expo-haptics';
import { Check } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatList } from '@/lib/format';
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
  className,
  children,
}: Readonly<ChoiceRowProps>) {
  const colors = useThemeColors();
  // A busy row needs an explicit accessible name: React Native replaces the
  // name derived from the child `Text` nodes with its own content description
  // (label + busy state) as soon as a state has no node setter, and it does
  // not restore the derived name once the state clears.
  const namedParts =
    children == null ? [label, description].flatMap(part => (part ? [part] : [])) : [];

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
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityLabel={namedParts.length > 0 ? formatList(namedParts, i18n.language) : undefined}
      accessibilityState={{ checked: selected, disabled: Boolean(disabled), busy }}
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
