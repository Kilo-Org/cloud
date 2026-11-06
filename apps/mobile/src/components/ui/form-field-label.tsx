import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

type FormFieldLabelProps = Readonly<{
  /** The label, which is also the accessible name of the value it names. */
  label: string;
  /** Controls that belong to the field's own row, at the end of its label line. */
  labelAccessory?: ReactNode;
}>;

/**
 * A form field's visible label, with the caller's own row controls at the end
 * of its line. Shared so a read-only value keeps the label its editable
 * sibling has, and so those controls stay out of the value's accessible name.
 */
export function FormFieldLabel({ label, labelAccessory }: Readonly<FormFieldLabelProps>) {
  if (labelAccessory === undefined) {
    return <Text className="text-sm font-medium text-foreground">{label}</Text>;
  }
  return (
    <View className="flex-row items-center gap-2">
      <Text className="min-w-0 flex-1 text-sm font-medium text-foreground">{label}</Text>
      {labelAccessory}
    </View>
  );
}
