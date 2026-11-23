import { useLayoutEffect, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  type TextInput,
  type TextInputProps,
  View,
} from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { formFieldA11y } from '@/components/ui/form-field-a11y';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Input } from '@/components/ui/input';
import { INPUT_BOX_LINE_HEIGHT_CLASS, INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input-box';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type FormFieldProps = Omit<TextInputProps, 'value'> &
  React.RefAttributes<TextInput> & {
    label: string;
    /**
     * How the visible label paints. `field` (default) is the form label;
     * `section` paints it as the section eyebrow, 10.5pt above the input, for
     * a field that sits among labelled sections (a pill group's `Section`) so
     * the labels beside each other share one style.
     */
    labelRole?: 'field' | 'section';
    error?: string;
    /**
     * The gap between the field's label row and its input. The default
     * `gap-1.5` keeps the ordinary compact block; a screen whose row controls
     * hover over the label line passes `COMMAND_ROW_FIELD_GAP_CLASS`. The
     * class lands on a wrapper around the label row and the input only — the
     * block root keeps `gap-1.5`, so a shown error or reserved message below
     * the input keeps the ordinary spacing.
     */
    gapClassName?: string;
    /** Reserve the tallest localized message, including wrapping and font scaling. The
     * reservation opens at the field's first focus and stays for the rest of the
     * screen's life: an untouched form keeps the section rhythm of the screen it
     * sits on, and a focus/blur cycle grows the form once instead of oscillating
     * around an error line that comes and goes. */
    reserveErrorMessages?: readonly string[];
    /**
     * Keep `reserveErrorMessages` mounted from the first render instead of at
     * the field's first focus. For a field whose error arrives without focus
     * (an async verification result) or that opens focused inside a sheet
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
  labelRole = 'field',
  gapClassName = labelRole === 'section' ? 'gap-3' : 'gap-1.5',
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
  // Latched at the first focus and never cleared: a slot that unmounts on blur
  // moves everything below the field on every focus/blur cycle.
  const [hasFocused, setHasFocused] = useState(false);
  // Whether the person pressed the resting preview: the real input takes over
  // until that input blurs.
  const [editing, setEditing] = useState(false);
  const valueRef = useRef(defaultValue ?? '');
  const nativeInput = useRef<TextInput>(null);
  // `validate` owns what this field's own rule reports; `error` carries an
  // error known from elsewhere (a rejected submit). Either one marks the field
  // invalid; the field's own rule wins while it has something to say.
  const displayedError = (validate ? validationError : null) ?? error;
  // `Input` reads the same prop for its box, so the two agree on the shape on
  // screen.
  const isMultiline = props.multiline === true;
  // The field whose real input is on screen: always for a multiline, masked or
  // empty field (its placeholder must show), when the caller opens it focused,
  // and once the person pressed the preview. Everything else is at rest.
  const isEditing =
    isMultiline || props.secureTextEntry === true || props.autoFocus === true || editing;
  // Android keeps a resting one-line EditText scrolled to its caret, so a value
  // longer than the box paints its tail with its first glyph cut; a
  // programmatic selection does not scroll it back (measured on the emulator).
  // While the field rests, a one-line `Text` preview paints that value from its
  // start and clips the end instead, and a press swaps the real input in — the
  // same shape `list-settings-name-field` uses for the same defect.
  const showsRestingPreview = !isEditing && valueRef.current.length > 0;
  // The field's own chrome, shared by the preview and the real input so the
  // swap changes nothing on screen but the text's scroll position.
  const controlClassName = cn(
    // The box (min-h-[44px] pl-3 pr-3 leading-[normal]) lives in
    // `@/components/ui/input`, so every single-line field shares it and the
    // class cannot be copied back wrong. No vertical padding: iOS insets the
    // already-centered text rect by it, drawing the value and the placeholder
    // below the middle (apps/mobile/AGENTS.md).
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
  );

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
      {/* The caller's gap lands only on the label-to-input pair, via a wrapper
          around those two siblings: the block root keeps its compact `gap-1.5`
          so a shown error or reserved message below the input keeps the
          ordinary spacing whatever the controls above the input need. */}
      <View className={gapClassName}>
        {labelRole === 'section' ? (
          <SectionHeader label={label} />
        ) : (
          <FormFieldLabel label={label} />
        )}
        {showsRestingPreview ? (
          <Pressable
            accessibilityLabel={formFieldA11y({ label, required, error: displayedError })}
            accessibilityRole="button"
            accessibilityValue={{ text: valueRef.current }}
            accessibilityState={{ disabled }}
            // The caller's test handle names the field's control, and while the
            // field rests that control is this preview: a harness that looks the
            // field up by its handle must find it in both states.
            testID={props.testID}
            // A disabled field has nothing to enter: the press must not open an
            // editor the field itself would not accept text into.
            disabled={disabled}
            onPress={() => {
              setEditing(true);
            }}
            className={cn(
              INPUT_BOX_SHAPE_CLASS,
              // The box's height is the native input's `min-h-[44px]`, so the
              // one painted line sits on the same middle the value would.
              'justify-center',
              controlClassName,
              // The line height lands last for the same reason `Input` puts it
              // after the caller's classes: `text-sm` carries a line height of
              // its own, and `cn` keeps the later of two conflicting classes.
              INPUT_BOX_LINE_HEIGHT_CLASS
            )}
          >
            <Text
              numberOfLines={1}
              className="text-sm font-normal text-foreground"
              // A `Text` resolves the interface direction itself (the shared
              // `Text` sets the paragraph's base direction), so the preview only
              // carries the caller's own style and an explicit `textAlign`, the
              // way the native box folds that prop after the style.
              style={props.textAlign ? [style, { textAlign: props.textAlign }] : style}
            >
              {valueRef.current}
            </Text>
          </Pressable>
        ) : (
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
            // A field that swaps the real input in keeps what the person typed:
            // the box mounts with the live value, not the value the screen
            // opened with.
            defaultValue={editing ? valueRef.current : defaultValue}
            editable={!disabled}
            // A field's content follows the interface direction, not the script of
            // its own value, so an email address stays on the same side as its
            // label in an RTL catalog. `Input` applies the alignment; the caller's
            // own style passes through untouched.
            style={style}
            accessibilityLabel={formFieldA11y({ label, required, error: displayedError })}
            accessibilityState={{ disabled }}
            // A press on the preview swaps this input in unfocused, so it asks
            // for focus itself and the keyboard opens with the swap.
            autoFocus={props.autoFocus === true || editing}
            onChangeText={value => {
              valueRef.current = value;
              // A value arriving through this input means the person is in it:
              // the preview must never swap in under a live edit.
              setEditing(true);
              onChangeText?.(value);
              if (validate && (validationError || (validateWhileTyping && value.trim() !== ''))) {
                setValidationError(validate(value));
              }
            }}
            onFocus={event => {
              onFocus?.(event);
              setHasFocused(true);
              // Focus can arrive without a press (autofill, an assistive
              // action, the return key of the field above), and a focused field
              // must keep its real input.
              setEditing(true);
            }}
            onBlur={event => {
              onBlur?.(event);
              if (validate) {
                setValidationError(validate(valueRef.current));
              }
              setEditing(false);
            }}
            className={controlClassName}
          />
        )}
      </View>
      {reserveErrorMessages?.length && (alwaysReserve || hasFocused || displayedError) ? (
        <View>
          {/* Full-width overlapping copies reserve the maximum height in native layout,
              before validation, without measuring or clipping larger text/RTL copy. The
              slot opens at the first focus and stays: an untouched form keeps the
              section rhythm a screen's own gap defines, and the focus/blur cycle grows
              the form once instead of reflowing it on every blur. */}
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
