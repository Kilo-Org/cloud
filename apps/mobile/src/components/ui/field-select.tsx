import { Pressable, View } from 'react-native';

import { FormFieldLabel } from '@/components/ui/form-field-label';
import { ChevronDown } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { FIELD_TRIGGER_BODY_CLASS, FIELD_TRIGGER_FRAME_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type FieldSelectProps = Readonly<{
  /** The field's visible label, on the field-label column above the box. */
  label: string;
  /** The value the picker currently holds. */
  value: string;
  onPress: () => void;
  /** The value is a placeholder (nothing picked yet), so it paints muted. */
  placeholder?: boolean;
  disabled?: boolean;
  /** Overrides the spoken name when the label alone does not name the field. */
  accessibilityLabel?: string;
  /** A hint line under the box, e.g. why the value is fixed. */
  caption?: string;
  /** A validation message under the box; it replaces the caption's slot. */
  error?: string;
}>;

/**
 * A form picker in the one field shape: its label above the 48pt select box,
 * the way `FormField` puts a text field's label above its input.
 *
 * A trigger form and the New session form once drew the same pick in three
 * ways — an inline "Label … value" row, a label above a filled box, and a pill
 * chip — so the label column moved from form to form and a picker read as a
 * navigation row in one screen. Every picker that opens a sheet now renders
 * this box, so their labels start at the page gutter and their values in the
 * same frame, beside the text fields above them.
 */
export function FieldSelect({
  label,
  value,
  onPress,
  placeholder = false,
  disabled = false,
  accessibilityLabel,
  caption,
  error,
}: FieldSelectProps) {
  const colors = useThemeColors();
  return (
    <View className="gap-2">
      <FormFieldLabel label={label} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityValue={{ text: value }}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        className={cn(FIELD_TRIGGER_FRAME_CLASS, !disabled && 'active:opacity-70')}
      >
        <View className={cn(FIELD_TRIGGER_BODY_CLASS, 'justify-between')}>
          <Text
            numberOfLines={1}
            className={cn(
              'min-w-0 flex-1 text-base',
              placeholder || disabled ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {value}
          </Text>
          <ChevronDown size={16} color={colors.mutedForeground} />
        </View>
      </Pressable>
      {error === undefined ? null : <Text className="text-xs text-destructive">{error}</Text>}
      {caption === undefined ? null : <Text variant="caption">{caption}</Text>}
    </View>
  );
}
