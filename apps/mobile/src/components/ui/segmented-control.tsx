import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { selectionHaptic } from '@/lib/haptics';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

type SegmentedControlOption<T extends string> = {
  value: T;
  label: string;
  /** A node after the label: a count, a status dot, a small mark the choice carries. */
  badge?: ReactNode;
  /** This one choice is fixed (a value the plan pins) while the others stay live. */
  disabled?: boolean;
  /** The segment's own handle for a test or a tour target. */
  testID?: string;
};

type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The visible group name — required so the radio group is never unnamed. */
  accessibilityLabel: string;
  /** The choice is fixed while a write that would replace it is in flight. */
  disabled?: boolean;
};

/**
 * The track: the control's outer frame. Exported so a skeleton reserves the
 * loaded frame instead of a hand-sized box, and so a screen can align to its
 * box without re-spelling the chrome.
 */
export const SEGMENTED_FRAME_CLASS = 'flex-row rounded-lg bg-secondary p-1';

/**
 * The loaded frame's height in pt: the 48pt segment floor plus the track's
 * 3.5pt inset above and below.
 */
export const SEGMENTED_FRAME_HEIGHT = 55;

/** The loaded frame's box as a class, for the skeleton that stands in for it. */
export const SEGMENTED_FRAME_HEIGHT_CLASS = 'min-h-[55px]';

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
  disabled = false,
}: Readonly<SegmentedControlProps<T>>) {
  return (
    <RadioGroup label={accessibilityLabel} className={SEGMENTED_FRAME_CLASS}>
      {options.map(option => {
        const selected = value === option.value;
        const optionDisabled = disabled || option.disabled === true;
        // Every option shows its full label: no line cap, no font shrink and
        // no ellipsis. A label longer than its equal-width segment wraps onto
        // as many lines as it needs, and the row's default `alignItems:
        // stretch` keeps every segment the same height. The radio's
        // accessibilityLabel carries the same full text.
        const label = (
          <Text
            className={cn(
              'text-center text-sm',
              // A badge takes width beside the label, so the label must be
              // free to shrink and wrap in what is left; without one it keeps
              // filling the segment (see the segment's own class comment).
              option.badge ? 'shrink' : undefined,
              selected ? 'font-medium text-foreground' : 'text-muted-foreground'
            )}
          >
            {option.label}
          </Text>
        );
        return (
          <Pressable
            key={option.value}
            testID={option.testID}
            {...radioItemA11y({
              label: option.label,
              checked: selected,
              disabled: optionDisabled,
            })}
            disabled={optionDisabled}
            onPress={() => {
              if (selected || optionDisabled) {
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
              selected && 'bg-background',
              optionDisabled && 'opacity-50'
            )}
          >
            {option.badge ? (
              // The badge sits on the label's line; the row is centred and the
              // label shrinks into the width the badge leaves, so a long label
              // still wraps instead of pushing the badge out of the segment.
              <View className="flex-row items-center justify-center gap-1">
                {label}
                {option.badge}
              </View>
            ) : (
              label
            )}
          </Pressable>
        );
      })}
    </RadioGroup>
  );
}
