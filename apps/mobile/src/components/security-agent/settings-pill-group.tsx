import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';

/**
 * Labeled single-select picker for a fixed set of enum options — shared by
 * the Automation screen's severity/confidence pickers and the Notification
 * and dismiss screens' pickers. Renders a vertical row list (like the dismiss
 * reason and finding-filter pickers) so long labels stay fully readable
 * instead of being squeezed into a horizontal pill row.
 *
 * The group is the contract's section shape: the 10pt mono eyebrow names it,
 * one `RowGroup` holds the choice rows, and `ChoiceRow` owns the row anatomy,
 * the selection mark and its haptic. A read-only group is the rows' own
 * disabled cue — every label mutes, the selected one still stands apart by its
 * weight and its check — never a row opacity, so a member who cannot manage
 * the settings can still read which options exist.
 */
export function PillGroup<T extends string>({
  label,
  accessibilityLabel,
  options,
  value,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  /**
   * Names the group when pickers on one screen share a visible label. The
   * visible `label` stays unchanged. Defaults to `label`.
   */
  accessibilityLabel?: string;
  options: readonly { value: T; label: string }[];
  /** `null` when nothing is selected yet, e.g. an unset dismissal reason. */
  value: T | null;
  disabled: boolean;
  onChange: (value: T) => void;
}>) {
  return (
    <Section label={label}>
      <RadioGroup label={accessibilityLabel ?? label}>
        <RowGroup>
          {options.map(option => (
            <ChoiceRow
              key={option.value}
              label={option.label}
              selected={value === option.value}
              disabled={disabled}
              onPress={() => {
                onChange(option.value);
              }}
            />
          ))}
        </RowGroup>
      </RadioGroup>
    </Section>
  );
}
