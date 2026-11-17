import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { RowChevron } from '@/components/ui/row-chevron';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * One titled block of an organization settings form: the title, its
 * description, and an optional master switch on the title row. Children render
 * only while the switch is on, which is how the web forms show a section's
 * fields.
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
    <Card>
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text variant="heading">{title}</Text>
          <Text variant="caption">{description}</Text>
        </View>
        {showsSwitch ? (
          <Switch
            value={enabled}
            disabled={switchDisabled}
            onValueChange={onEnabledChange}
            accessibilityLabel={title}
          />
        ) : null}
      </View>
      {!showsSwitch || enabled ? children : null}
    </Card>
  );
}

/** A one-line switch inside a settings section: the label, its note, and the control. */
export function SettingsSwitchRow({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
}: Readonly<{
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}>) {
  // One switch per row: the tap target around the copy is hidden from
  // accessibility, and the native control carries the switch role, label, and
  // state, so a tap runs one handler and a screen reader sees one target.
  return (
    <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center justify-between gap-3')}>
      <Pressable
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className={cn(ROW_TARGET_CLASS, 'min-w-0 flex-1 justify-center active:opacity-70')}
        disabled={disabled}
        onPress={() => {
          onValueChange(!value);
        }}
      >
        <View className="gap-0.5">
          <Text
            className={cn(
              'text-sm font-medium',
              disabled ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {label}
          </Text>
          {description ? <Text variant="caption">{description}</Text> : null}
        </View>
      </Pressable>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        accessibilityLabel={label}
        accessibilityHint={description}
        accessibilityState={{ checked: value, disabled }}
      />
    </View>
  );
}

/** A row that opens a picker: its label, the current choice, and the disclosure glyph. */
export function SettingsValueRow({
  label,
  value,
  onPress,
  disabled = false,
}: Readonly<{
  label: string;
  value: string;
  onPress: () => void;
  disabled?: boolean;
}>) {
  return (
    <Pressable
      className={cn(
        ROW_TARGET_CLASS,
        'flex-row items-center justify-between gap-3 px-4 py-3 active:opacity-70'
      )}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={[label, value].join(', ')}
      accessibilityState={{ disabled }}
      onPress={onPress}
    >
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <View className="min-w-0 shrink flex-row items-center gap-2">
        <Text variant="caption" className="shrink" numberOfLines={1}>
          {value}
        </Text>
        <RowChevron />
      </View>
    </Pressable>
  );
}
