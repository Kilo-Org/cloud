import { type ReactNode } from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { RowChevron } from '@/components/ui/row-chevron';
import { RowFrame } from '@/components/ui/row-frame';
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';

/**
 * One titled block of an organization settings form: the title, its
 * description, and an optional master switch on the title row. The heading is a
 * card of its own and the fields below it are siblings, so a row keeps the
 * page's row inset instead of nesting inside the card's padding. Children
 * render only while the switch is on, which is how the web forms show a
 * section's fields.
 */
export function SettingsSection({
  title,
  description,
  enabled,
  onEnabledChange,
  switchDisabled = false,
  children,
}: Readonly<{
  title: string;
  description: string;
  enabled?: boolean;
  onEnabledChange?: (next: boolean) => void;
  switchDisabled?: boolean;
  children?: ReactNode;
}>) {
  const showsSwitch = enabled !== undefined && onEnabledChange !== undefined;
  return (
    <View className="gap-3">
      <Card>
        <View className="flex-row items-start justify-between gap-3">
          <View className="min-w-0 flex-1 gap-1">
            <Text variant="heading">{title}</Text>
            <Text variant="caption">{description}</Text>
          </View>
          {showsSwitch &&
            renderRowTrailing({
              kind: 'switch',
              value: enabled,
              disabled: switchDisabled,
              onValueChange: onEnabledChange,
              accessibilityLabel: title,
            })}
        </View>
      </Card>
      {!showsSwitch || enabled ? children : null}
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
