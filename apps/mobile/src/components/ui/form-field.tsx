import { useRef, useState } from 'react';
import { TextInput, type TextInputProps, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { formFieldA11y } from '@/components/ui/form-field-a11y';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { withRtlInputAlignment } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

type FormFieldProps = Omit<TextInputProps, 'value'> &
  React.RefAttributes<TextInput> & {
    label: string;
    error?: string;
    /** Reserve the tallest localized message, including wrapping and font scaling. */
    reserveErrorMessages?: readonly string[];
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
  reserveErrorMessages,
  disabled,
  required,
  className,
  ref,
  validate,
  defaultValue,
  style,
  onChangeText,
  onBlur,
  ...props
}: Readonly<FormFieldProps>) {
  const colors = useThemeColors();
  const [validationError, setValidationError] = useState<string | null>(null);
  const valueRef = useRef(defaultValue ?? '');
  const displayedError = validate ? validationError : error;

  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <TextInput
        ref={ref}
        {...props}
        defaultValue={defaultValue}
        editable={!disabled}
        // A field's content follows the interface direction, not the script of
        // its own value, so an email address stays on the same side as its
        // label in an RTL catalog (`textAlign: 'auto'` aligns to the value's
        // first strong character instead).
        style={withRtlInputAlignment(style)}
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
      {reserveErrorMessages?.length ? (
        <View>
          {/* Full-width overlapping copies reserve the maximum height in native layout,
              before validation, without measuring or clipping larger text/RTL copy. */}
          <View
            className="flex-row opacity-0"
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {reserveErrorMessages.map((message, index) => (
              <Text
                key={message}
                className={cn('w-full shrink-0 text-sm', index > 0 && '-ms-[100%]')}
              >
                {message}
              </Text>
            ))}
          </View>
          <View className="absolute inset-x-0 top-0">
            <AccessibleStatus message={displayedError ?? null} className="text-sm" />
          </View>
        </View>
      ) : (
        <AccessibleStatus message={displayedError ?? null} className="text-sm" />
      )}
    </View>
  );
}

export { FormField };
