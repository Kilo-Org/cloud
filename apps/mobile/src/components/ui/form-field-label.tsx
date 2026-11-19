import { Text } from '@/components/ui/text';

type FormFieldLabelProps = Readonly<{
  /** The label, which is also the accessible name of the value it names. */
  label: string;
}>;

/**
 * A form field's visible label. Shared so a read-only value keeps the label
 * its editable sibling has. A screen's own row controls do not render here:
 * React Native confines a control's touch area to its parent's bounds, so a
 * control on this one-text-line row cannot reach a taller touch target — such
 * controls get a row of their own under the field instead (see
 * `ReorderableItemActions`).
 */
export function FormFieldLabel({ label }: Readonly<FormFieldLabelProps>) {
  return <Text className="text-sm font-medium text-foreground">{label}</Text>;
}
