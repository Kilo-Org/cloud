import * as Haptics from 'expo-haptics';
import { Pressable } from 'react-native';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type SegmentedControlOption<T extends string> = { value: T; label: string };

type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The visible group name — required so the radio group is never unnamed. */
  accessibilityLabel: string;
};

/**
 * Horizontal segmented pill. Owns the selection haptic — callers must NOT
 * fire their own `Haptics.selectionAsync()` on press. The haptic only fires
 * on an actual change of selection, not when the current value is re-tapped.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: Readonly<SegmentedControlProps<T>>) {
  return (
    <RadioGroup label={accessibilityLabel} className="flex-row rounded-lg bg-secondary p-1">
      {options.map(option => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            {...radioItemA11y({ label: option.label, checked: selected })}
            onPress={() => {
              if (selected) {
                return;
              }
              void Haptics.selectionAsync();
              onChange(option.value);
            }}
            className={cn(
              // px-2 (not px-3): equal-width segments are narrow on a phone, and
              // the longest reference label ("Commit and push") otherwise wraps
              // to two lines while its sibling stays on one. The tighter inset
              // keeps every option label on a single line.
              'min-h-11 flex-1 items-center justify-center rounded-md px-2 active:opacity-70',
              selected && 'bg-background'
            )}
          >
            {/* `numberOfLines` + `adjustsFontSizeToFit` keeps a longer label
                ("Commit and push") on one line at every width and font scale:
                a wrapped label made the equal-width segments render at unequal
                height and weight. The platform shrinks the font to fit rather
                than truncating, so the label stays readable. A label still too
                wide to shrink ellipsizes instead of growing a second line; the
                radio's accessibilityLabel still carries the full text. */}
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              className={cn(
                'text-center text-sm',
                selected ? 'font-medium text-foreground' : 'text-muted-foreground'
              )}
              // One line per option: a wrapped label makes the two choices
              // uneven. Longer locales ellipsize instead of growing a second
              // line; the radio's accessibilityLabel still carries the full text.
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </RadioGroup>
  );
}
