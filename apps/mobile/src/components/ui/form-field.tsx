import { useLayoutEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, type TextInput, type TextInputProps, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { formFieldA11y } from '@/components/ui/form-field-a11y';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type FormFieldProps = Omit<TextInputProps, 'value'> &
  React.RefAttributes<TextInput> & {
    label: string;
    error?: string;
    /**
     * Controls that belong to the field's own row, rendered at the end of the
     * label line: the reorder and delete controls of a list a field sits in.
     * The label keeps the line's remaining width and the row is as tall as the
     * accessory, so the controls take no separate band under the input.
     */
    labelAccessory?: React.ReactNode;
    /** Reserve the tallest localized message, including wrapping and font scaling. The
     * reservation exists only while the field is edited or showing an error: an idle
     * form keeps the section rhythm of the screen it sits on, and the slot appears
     * once on focus instead of growing the form on every keystroke. */
    reserveErrorMessages?: readonly string[];
    /**
     * Keep `reserveErrorMessages` mounted from the first render instead of
     * scoping it to the edited field. For a field whose error arrives without
     * focus (an async verification result) or that opens focused inside a sheet
     * (`autoFocus`), the late slot is the layout shift AGENTS.md forbids, so
     * those callers reserve permanently and pay the idle line.
     */
    alwaysReserve?: boolean;
    disabled?: boolean;
    /**
     * Mark the field as required: the composed accessibility label appends
     * `, required` so a screen reader announces it. Visual representation
     * stays unchanged (React Native has no required accessibility state).
     */
    required?: boolean;
    /**
     * Layout of the field's whole block: its label, input and message. A form
     * that scrolls a refused Save to the field at fault records this offset;
     * the input's own `onLayout` stays with the native text view.
     */
    containerOnLayout?: (event: LayoutChangeEvent) => void;
    /**
     * Owns blur-validation: runs on blur, and re-runs live once an error is
     * showing so it clears the moment the value becomes valid again. When
     * set, its message replaces `error` while it reports one; an `error`
     * passed alongside shows whenever the field's own rule has nothing to say,
     * which is how a rejected submit is reported without a blur.
     */
    validate?: (value: string) => string | null;
    /**
     * Show the field's own rule while the person types, not only after a blur.
     * Use it when this value gates a submit that is disabled live: a disabled
     * Save with no message leaves the person with nothing to fix. An empty value
     * still waits for the first blur, so a form that opens empty does not greet
     * the reader with a required error.
     */
    validateWhileTyping?: boolean;
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
  labelAccessory,
  error,
  reserveErrorMessages,
  alwaysReserve,
  disabled,
  required,
  containerOnLayout,
  className,
  ref,
  validate,
  validateWhileTyping,
  defaultValue,
  style,
  onChangeText,
  onFocus,
  onBlur,
  ...props
}: Readonly<FormFieldProps>) {
  const [validationError, setValidationError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const valueRef = useRef(defaultValue ?? '');
  const nativeInput = useRef<TextInput>(null);
  // `validate` owns what this field's own rule reports; `error` carries an
  // error known from elsewhere (a rejected submit). Either one marks the field
  // invalid; the field's own rule wins while it has something to say.
  const displayedError = (validate ? validationError : null) ?? error;

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
    <View className="gap-1.5" onLayout={containerOnLayout}>
      <FormFieldLabel label={label} labelAccessory={labelAccessory} />
      <Input
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
        // A field's content follows the interface direction, not the script of
        // its own value, so an email address stays on the same side as its
        // label in an RTL catalog. `Input` applies the alignment; the caller's
        // own style passes through untouched.
        style={style}
        accessibilityLabel={formFieldA11y({ label, required, error: displayedError })}
        accessibilityState={{ disabled }}
        onChangeText={value => {
          valueRef.current = value;
          onChangeText?.(value);
          if (validate && (validationError || (validateWhileTyping && value.trim() !== ''))) {
            setValidationError(validate(value));
          }
        }}
        onFocus={event => {
          onFocus?.(event);
          setEditing(true);
        }}
        onBlur={event => {
          onBlur?.(event);
          setEditing(false);
          if (validate) {
            setValidationError(validate(valueRef.current));
          }
        }}
        className={cn(
          // The box (min-h-[44px] pl-3 pr-3 leading-[normal]) lives in
          // `@/components/ui/input`, so every single-line field shares it and
          // the class cannot be copied back wrong. No vertical padding: iOS
          // insets the already-centered text rect by it, drawing the value and
          // the placeholder below the middle (apps/mobile/AGENTS.md).
          'rounded-md border border-input bg-background text-sm text-foreground',
          // DESIGN.md's input recipe fills the field with `border.inputBg` (4 %
          // white) over the canvas. `bg-background` is the canvas itself, so in
          // dark the field had no surface of its own and only the border color
          // separated it from the page. Light keeps the canvas fill, where the
          // 45 % ink `--input` border already carries the field.
          'dark:bg-[#FFFFFF0A]',
          'focus:border-ring',
          displayedError && 'border-destructive',
          disabled && 'opacity-50',
          className
        )}
      />
      {reserveErrorMessages?.length && (alwaysReserve || editing || displayedError) ? (
        <View>
          {/* Full-width overlapping copies reserve the maximum height in native layout,
              before validation, without measuring or clipping larger text/RTL copy. The
              slot exists only while the field is edited or in error: an idle form keeps
              the section rhythm a screen's own gap defines, and the slot appears once
              on focus instead of growing the form on every keystroke. */}
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
