import { selectionHaptic } from '@/lib/haptics';
import { Pressable } from 'react-native';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
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
 * fire their own `selectionHaptic()` on press. The haptic only fires
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
              selectionHaptic();
              onChange(option.value);
            }}
            className={cn(
              // No `items-center` here: a centred Text child is sized to its
              // content, so a label wider than its segment overflows and gets
              // clipped instead of wrapping. Stretching the child to the segment
              // width is what lets the label wrap inside the pill.
              //
              // A one-line segment now fills the shared row floor. A
              // wrapped label grows past it and keeps its vertical insets
              // instead of touching the edges.
              ROW_TARGET_CLASS,
              'flex-1 justify-center rounded-md px-2 py-2 active:opacity-70',
              selected && 'bg-background'
            )}
          >
            {/* Every option shows its full label: no line cap, no font shrink
                and no ellipsis. A label longer than its equal-width segment
                wraps onto as many lines as it needs, and the row's default
                `alignItems: stretch` keeps every segment the same height, so a
                wrapped choice never looks uneven next to a short one. The
                radio's accessibilityLabel carries the same full text. */}
            <Text
              className={cn(
                'text-center text-sm',
                selected ? 'font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </RadioGroup>
  );
}
