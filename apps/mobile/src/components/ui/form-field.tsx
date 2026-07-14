import { useRef, useState } from 'react';
import { TextInput, type TextInputProps, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type FormFieldProps = Omit<TextInputProps, 'value'> &
  React.RefAttributes<TextInput> & {
    label: string;
    error?: string;
    disabled?: boolean;
    /**
     * Owns blur-validation: runs on blur, and re-runs live once an error is
     * showing so it clears the moment the value becomes valid again. When
     * set, this replaces `error` as the source of the displayed message.
     */
    validate?: (value: string) => string | null;
  };

/**
 * Uncontrolled text field: visible label, destructive error text, disabled
 * styling, and a focus-visible border. Never pass a controlled `value` —
 * use `defaultValue` + `onChangeText` writing to a ref (see CLAUDE.md).
 */
function FormField({
  label,
  error,
  disabled,
  className,
  ref,
  validate,
  defaultValue,
  onChangeText,
  onBlur,
  ...props
}: Readonly<FormFieldProps>) {
  const colors = useThemeColors();
  const [validationError, setValidationError] = useState<string | null>(null);
  const valueRef = useRef(typeof defaultValue === 'string' ? defaultValue : '');
  const displayedError = validate ? validationError : error;

  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <TextInput
        ref={ref}
        {...props}
        defaultValue={defaultValue}
        editable={!disabled}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel={displayedError ? `${label}, error: ${displayedError}` : label}
        accessibilityState={{ disabled }}
        onChangeText={value => {
          valueRef.current = value;
          onChangeText?.(value);
          if (validate && validationError) {
            setValidationError(validate(value));
          }
        }}
        onBlur={event => {
          onBlur?.(event);
          if (validate) {
            setValidationError(validate(valueRef.current));
          }
        }}
        className={cn(
          'rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground',
          'focus:border-ring',
          displayedError && 'border-destructive',
          disabled && 'opacity-50',
          className
        )}
      />
      {displayedError ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-destructive">
          {displayedError}
        </Text>
      ) : null}
    </View>
  );
}

export { FormField };
export type { FormFieldProps };
