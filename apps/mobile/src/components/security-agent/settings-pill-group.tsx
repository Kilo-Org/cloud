import { selectionHaptic } from '@/lib/haptics';
import { Check } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * Labeled single-select picker for a fixed set of enum options — shared by
 * the Automation screen's severity/confidence pickers and the Notification
 * screen's severity pickers. Renders a vertical row list (like the dismiss
 * reason and finding-filter pickers) so long labels stay fully readable
 * instead of being squeezed into a horizontal pill row.
 *
 * A read-only group dims once, by token, never by row opacity: every option
 * label — the selected one included — sits on `text-muted-foreground`, and the
 * check leaves the palette's accent for that same muted ink, so the whole list
 * reads as unavailable. The selected row still stands apart by its weight and
 * its check, which is what a disabled single-select looks like: a control whose
 * choice is dimmed with everything else. Halving the row on top of that muted
 * ink lands the label near 2:1 on the row's `secondary` surface in both schemes
 * — under the 4.5:1 text floor, so a member who cannot manage the settings
 * could not read which options exist. The muted token keeps 4.5:1.
 *
 * An editable group keeps the selected label at full `foreground` ink and the
 * accent check, so the two states differ by more than the row's tap response.
 */
export function PillGroup<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  options: readonly { value: T; label: string }[];
  /** `null` when nothing is selected yet, e.g. an unset dismissal reason. */
  value: T | null;
  disabled: boolean;
  onChange: (value: T) => void;
}>) {
  const colors = useThemeColors();
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-muted-foreground">{label}</Text>
      <RadioGroup label={label} className="overflow-hidden rounded-lg bg-secondary">
        {options.map((option, index) => {
          const active = value === option.value;
          return (
            <Pressable
              key={option.value}
              disabled={disabled}
              className={cn(
                // A row sized by its one label line sat at 38.5 dp under the
                // design target; the floor has to be the row's own class,
                // because `hitSlop` does not move the rect an audit reads.
                ROW_TARGET_CLASS,
                'flex-row items-center justify-between px-4 py-3 active:opacity-70',
                index < options.length - 1 && 'border-b-[0.5px] border-hair-soft'
              )}
              onPress={() => {
                selectionHaptic();
                onChange(option.value);
              }}
              {...radioItemA11y({ label: option.label, checked: active, disabled })}
            >
              <Text
                className={cn(
                  'flex-1 text-sm',
                  active && 'font-medium',
                  // A read-only group dims every label, the selected one
                  // included, to the muted token; the selected row still stands
                  // apart by its weight and its check. An editable group keeps
                  // the selected label on the full `foreground` ink.
                  active && !disabled ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {option.label}
              </Text>
              {active && (
                <Check size={16} color={disabled ? colors.mutedForeground : colors.primary} />
              )}
            </Pressable>
          );
        })}
      </RadioGroup>
    </View>
  );
}
