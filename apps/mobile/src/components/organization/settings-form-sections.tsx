import { type ReactNode } from 'react';
import { View } from 'react-native';

import { RowChevron } from '@/components/ui/row-chevron';
import { RowFrame } from '@/components/ui/row-frame';
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import { SETTINGS_SWITCH_HOST_CLASS } from '@/lib/a11y/tap-target';

/**
 * One titled block of an organization settings form: the title, its
 * description, and an optional master switch on the title row. The heading and
 * the fields below it are flat siblings at the page gutter, never a surface
 * inside another surface, and the title row stays one heading line tall.
 *
 * The switch keeps its 44dp box — its own node is the control-size target — and
 * the host around it cancels that box down to the heading's own line, so the
 * row cannot be sized by the switch. That cancellation is what keeps the
 * title-to-description gap of a section with a switch equal to the gap of a
 * section without one: both are the header group's inner gap.
 *
 * The section gap separates the header group — title, description, and the
 * `intro` copy that explains the fields — from each child group and each child
 * group from the next, so unrelated groups do not read as one block. The
 * header's own parts, and the parts of each child group, keep the inner gap.
 * The intro and the children render only while the switch is on, which is how
 * the web forms show a section's fields.
 */
export function SettingsSection({
  title,
  description,
  intro,
  enabled,
  onEnabledChange,
  switchDisabled = false,
  children,
}: Readonly<{
  title: string;
  description: string;
  intro?: ReactNode;
  enabled?: boolean;
  onEnabledChange?: (next: boolean) => void;
  switchDisabled?: boolean;
  children?: ReactNode;
}>) {
  const showsSwitch = enabled !== undefined && onEnabledChange !== undefined;
  const showsFields = !showsSwitch || enabled;
  return (
    <View className="gap-6">
      <View className="gap-3">
        <View className="flex-row items-center justify-between gap-3">
          <Text variant="heading" className="min-w-0 flex-1">
            {title}
          </Text>
          {showsSwitch && (
            <View className={SETTINGS_SWITCH_HOST_CLASS}>
              {renderRowTrailing({
                kind: 'switch',
                value: enabled,
                disabled: switchDisabled,
                onValueChange: onEnabledChange,
                accessibilityLabel: title,
              })}
            </View>
          )}
        </View>
        <Text variant="caption">{description}</Text>
        {showsFields ? intro : null}
      </View>
      {showsFields ? children : null}
    </View>
  );
}

/** A row that opens a picker: its label, the current choice, and the disclosure glyph. */
export function SettingsValueRow({
  label,
  value,
  onPress,
  disabled = false,
  className,
}: Readonly<{
  label: string;
  value: string;
  onPress: () => void;
  disabled?: boolean;
  /** Overrides for a row inside a padded block, e.g. `px-0`. */
  className?: string;
}>) {
  return (
    <RowFrame
      title={label}
      onPress={onPress}
      disabled={disabled}
      className={className}
      accessibilityLabel={[label, value].join(', ')}
      trailing={{
        kind: 'node',
        node: (
          <View className="min-w-0 shrink flex-row items-center gap-2">
            <Text variant="caption" className="shrink" numberOfLines={1}>
              {value}
            </Text>
            <RowChevron />
          </View>
        ),
      }}
    />
  );
}
