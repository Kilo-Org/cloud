import { type ReactNode } from 'react';
import { View } from 'react-native';

import { RowChevron } from '@/components/ui/row-chevron';
import { RowFrame } from '@/components/ui/row-frame';
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import { SETTINGS_SWITCH_ROW_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * One titled block of an organization settings form: the title, its
 * description, and an optional master switch on the title row. The heading and
 * the fields below it are flat siblings at the page gutter, never a surface
 * inside another surface.
 *
 * The title and its description sit on the tight inner gap (`gap-1`, 3.5dp),
 * the gap the field groups below them and the card this header replaced use, so
 * a title is never further from its own description than a field group's label
 * is: both lines read as one pair.
 *
 * The title row of a section with a switch renders at the control-size floor
 * (28dp), not at one heading line: the row is the switch's parent, and React
 * Native delivers a touch only inside each ancestor's bounds, so a row shrunk to
 * the heading line clipped the switch's own box and the band a touch could land
 * in fell under the audit floor. The switch's centred box adds half a band over
 * the heading line above the row's centre, so the row's bottom margin cancels
 * exactly that half, and the title-to-description gap stays the tight inner gap
 * of a section without a switch.
 *
 * The section gap separates the header group — title, description, and the
 * `intro` copy that explains the fields — from each child group and each child
 * group from the next, so unrelated groups do not read as one block. The intro
 * keeps the header group's inner gap. The intro and the children render only
 * while the switch is on, which is how the web forms show a section's fields.
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
        <View className="gap-1">
          <View
            className={cn(
              'flex-row items-center justify-between gap-3',
              showsSwitch && SETTINGS_SWITCH_ROW_CLASS
            )}
          >
            <Text variant="heading" className="min-w-0 flex-1">
              {title}
            </Text>
            {showsSwitch &&
              renderRowTrailing({
                kind: 'switch',
                value: enabled,
                disabled: switchDisabled,
                onValueChange: onEnabledChange,
                accessibilityLabel: title,
              })}
          </View>
          <Text variant="caption">{description}</Text>
        </View>
        {showsFields ? intro : null}
      </View>
      {showsFields ? children : null}
    </View>
  );
}

/**
 * A row for a setting's current choice: its label and value, plus the
 * disclosure glyph when pressing it opens a picker. A row without `onPress`
 * states a value the reader cannot change yet, so it carries neither the glyph
 * nor a press target and reads as plain text in the same geometry.
 */
export function SettingsValueRow({
  label,
  value,
  onPress,
  disabled = false,
  className,
}: Readonly<{
  label: string;
  value: string;
  onPress?: () => void;
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
            {onPress === undefined ? null : <RowChevron />}
          </View>
        ),
      }}
    />
  );
}
