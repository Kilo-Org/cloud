/**
 * The two shapes the trigger form is built from beside its text fields: a
 * field-shaped picker that opens a sheet with the value it currently holds, and
 * a row that carries a switch.
 *
 * Both are the shared primitives rather than a local anatomy, so the form's
 * labels start on the field-label column and its switches keep the row height
 * of every other settings row in the app.
 */

import { FieldSelect } from '@/components/ui/field-select';
import { PreferenceRow } from '@/components/ui/preference-row';

type TriggerSelectRowProps = Readonly<{
  label: string;
  value: string;
  onPress: () => void;
  disabled?: boolean;
  /** Overrides the composed accessible name when the value alone is not the whole story. */
  accessibilityLabel?: string;
  /** A message the row could not apply the choice, shown under it. */
  error?: string;
}>;

export function TriggerSelectRow({
  label,
  value,
  onPress,
  disabled = false,
  accessibilityLabel,
  error,
}: TriggerSelectRowProps) {
  // The picker keeps the form's one field shape: the label above a 48pt select
  // box, on the field-label column the text fields use. Drawn as an inline
  // "Label … value" row it started its label about 12pt inside that column and
  // read as a navigation row rather than a field (design review, 2026-11-18).
  return (
    <FieldSelect
      label={label}
      value={value}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      error={error}
    />
  );
}

type TriggerSwitchRowProps = Readonly<{
  title: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}>;

export function TriggerSwitchRow({
  title,
  description,
  value,
  onValueChange,
  disabled = false,
}: TriggerSwitchRowProps) {
  return (
    <PreferenceRow
      title={title}
      subtitle={description}
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
    />
  );
}
