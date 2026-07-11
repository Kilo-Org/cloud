import { TextInput, type TextInputProps, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type FormFieldProps = Omit<TextInputProps, 'value'> &
  React.RefAttributes<TextInput> & {
    label: string;
    error?: string;
    disabled?: boolean;
  };

/**
 * Uncontrolled text field: visible label, destructive error text, disabled
 * styling, and a focus-visible border. Never pass a controlled `value` —
 * use `defaultValue` + `onChangeText` writing to a ref (see CLAUDE.md).
 */
function FormField({ label, error, disabled, className, ref, ...props }: Readonly<FormFieldProps>) {
  const colors = useThemeColors();

  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <TextInput
        ref={ref}
        editable={!disabled}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel={label}
        accessibilityHint={error}
        accessibilityState={{ disabled }}
        className={cn(
          'rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground',
          'focus:border-ring',
          error && 'border-destructive',
          disabled && 'opacity-50',
          className
        )}
        {...props}
      />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
    </View>
  );
}

export { FormField };
export type { FormFieldProps };
