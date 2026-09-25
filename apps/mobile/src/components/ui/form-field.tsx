import { useLayoutEffect, useRef, useState } from 'react';
import { TextInput, type TextInputProps, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { formFieldA11y } from '@/components/ui/form-field-a11y';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type FormFieldProps = Omit<TextInputProps, 'value'> &
  React.RefAttributes<TextInput> & {
    label: string;
    error?: string;
    disabled?: boolean;
    /**
     * Mark the field as required: the composed accessibility label appends
     * `, required` so a screen reader announces it. Visual representation
     * stays unchanged (React Native has no required accessibility state).
     */
    required?: boolean;
    /**
     * Owns blur-validation: runs on blur, and re-runs live once an error is
     * showing so it clears the moment the value becomes valid again. When
     * set, this replaces `error` as the source of the displayed message.
     */
    validate?: (value: string) => string | null;
  };

/**
 * Uncontrolled text field: visible label, destructive error text announced
 * through `AccessibleStatus`, disabled styling, and a focus-visible border.
 * Never pass a controlled `value` — use `defaultValue` + `onChangeText`
 * writing to a ref (see CLAUDE.md). All other `TextInputProps` pass through
 * to the native input, including `autoComplete`/`textContentType` — set
 * them at call sites to expose system autofill metadata.
 */
function FormField({
  label,
  error,
  disabled,
  required,
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
  const valueRef = useRef(defaultValue ?? '');
  const nativeInput = useRef<TextInput>(null);
  const displayedError = validate ? validationError : error;

  // Write the default only on attach; later prop changes must not move the caret
  // while the person edits an uncontrolled field.
  useLayoutEffect(() => {
    const next = defaultValue ?? '';
    valueRef.current = next;
    nativeInput.current?.setNativeProps({ text: next });
    // defaultValue is initial content, not a controlled value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <TextInput
        ref={instance => {
          nativeInput.current = instance;
          if (ref == null) {
            return;
          }
          if ('current' in ref) {
            ref.current = instance;
          } else {
            ref(instance);
          }
        }}
        {...props}
        defaultValue={defaultValue}
        editable={!disabled}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel={formFieldA11y({ label, required, error: displayedError })}
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
          // min-h-[44px] with no vertical padding: the 44pt height meets the
          // Apple HIG touch floor and centers the text, while the padding
          // draws the single-line text below the middle. min-h (not h) still
          // lets Dynamic Type grow the field past the floor.
          'min-h-[44px] rounded-md border border-input bg-background px-3 text-sm leading-[normal] text-foreground',
          'focus:border-ring',
          displayedError && 'border-destructive',
          disabled && 'opacity-50',
          className
        )}
      />
      <AccessibleStatus message={displayedError ?? null} className="text-sm" />
    </View>
  );
}

export { FormField };
