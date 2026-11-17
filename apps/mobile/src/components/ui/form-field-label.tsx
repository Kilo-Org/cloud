import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { LABELLED_LINE_MIN_HEIGHT_CLASS } from '@/lib/a11y/tap-target';

type FormFieldLabelProps = Readonly<{
  /** The label, which is also the accessible name of the value it names. */
  label: string;
  /** Controls that belong to the field's own row, at the end of its label line. */
  labelAccessory?: ReactNode;
  /**
   * The accessory is a full touch target, so the line lays out one target tall
   * and the copy sits at its top. The extra height then falls between the label
   * and the field instead of above the label, where it would read as a hole
   * under the card's edge.
   */
  accessoryIsTarget?: boolean;
}>;

/**
 * A form field's visible label, with the caller's own row controls at the end
 * of its line. Shared so a read-only value keeps the label its editable
 * sibling has, and so those controls stay out of the value's accessible name.
 *
 * A caller whose accessory is a full touch target passes
 * `accessoryIsTarget`, because React Native clips a touch area to its parent's
 * bounds: the accessory can only be as tall as the row it sits in.
 */
export function FormFieldLabel({
  label,
  labelAccessory,
  accessoryIsTarget = false,
}: Readonly<FormFieldLabelProps>) {
  if (labelAccessory === undefined) {
    return <Text className="text-sm font-medium text-foreground">{label}</Text>;
  }
  return (
    <View
      className={cn(
        // A target-sized accessory makes the row taller than the copy, so the
        // copy aligns to the top: centring it would put half of the added
        // height above the label, where it reads as a hole under the card's
        // edge instead of the gap the accessory needs.
        accessoryIsTarget
          ? cn('flex-row items-start gap-2', LABELLED_LINE_MIN_HEIGHT_CLASS)
          : 'flex-row items-center gap-2'
      )}
    >
      <Text className="min-w-0 flex-1 text-sm font-medium text-foreground">{label}</Text>
      {labelAccessory}
    </View>
  );
}
