import { useRef, useState } from 'react';
import { type StyleProp, TextInput, type TextInputProps, type TextStyle, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useSystemFontScale } from '@/lib/font-scale/system-font-scale-context';
import { resolveFontScaleCap } from '@/lib/font-scale/text-scale-cap';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { withRtlInputAlignment } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

/**
 * The single-line box's own shape: the 44pt floor and the 10.5pt physical
 * horizontal inset, without the caller's chrome or text size. Exported so a
 * read-only or preview box that stands in for a single-line `Input` (a value
 * that swaps into an editable field) carries the same box instead of a second,
 * drifting height.
 */
export const INPUT_BOX_SHAPE_CLASS = 'min-h-[44px] pl-3 pr-3';
// The single-line box's line height; kept private because a preview box paints
// its own text line, and the text size arrives last on the real field.
const INPUT_BOX_LINE_HEIGHT_CLASS = 'leading-[normal]';

/**
 * The box's own vertical geometry, folded into the flattened style behind the
 * caller's own style so a caller's class or style cannot move the value and the
 * placeholder off the middle: no vertical padding (iOS insets the centered text
 * rect by it) and Android's center gravity. Multiline callers are untouched.
 */
const INPUT_BOX_VERTICAL_STYLE: TextStyle = {
  paddingTop: 0,
  paddingBottom: 0,
  textAlignVertical: 'center',
};

// Android TextInput ignores logical paddingInline: defaults and caller overrides
// must use physical pl/pr classes, not px classes.
const INPUT_MULTILINE_INSET_CLASS = 'pl-3 pr-3 pt-2.5 pb-2.5';

/**
 * The one single-line box: `min-h-[44px] pl-3 pr-3 leading-[normal]`, no vertical
 * padding, Android's center gravity, one line box for the placeholder and the
 * value, `numberOfLines={1}`, and RTL content alignment. A call site keeps its
 * own chrome, text size and horizontal inset; a multiline caller keeps its own
 * gravity, line break mode and `numberOfLines`, plus the shared inset unless its
 * padding classes override it.
 */
function Input({
  className,
  style,
  textAlign,
  placeholderTextColor,
  multiline,
  textAlignVertical,
  lineBreakModeIOS,
  numberOfLines,
  maxFontSizeMultiplier,
  // The value a single-line field shows while it is not focused. A resting
  // single-line field keeps the native EditText's scroll offset at its caret
  // (measured on Android), so a value longer than the box paints its tail with
  // its first glyph cut at the leading inset; while unfocused the preview paints
  // that value from its start and clips the end, which is what a field at rest
  // must show.
  restingText,
  onChangeText,
  onFocus,
  onBlur,
  ...props
}: Readonly<TextInputProps & React.RefAttributes<TextInput> & { restingText?: string }>) {
  const colors = useThemeColors();
  const fontScaleCap = resolveFontScaleCap(useSystemFontScale(), maxFontSizeMultiplier);
  // The live value stays in a ref: this field is uncontrolled, so a keystroke
  // must not re-render the box. Only focus, and the value the preview returns
  // with on blur, re-render it.
  const valueRef = useRef(restingText ?? '');
  const [focused, setFocused] = useState(false);
  const [resting, setResting] = useState(restingText ?? '');
  // Fold the explicit `textAlign` prop into the style after the caller's own
  // style, so it lands after the RTL default too: RN flattens `style` after the
  // prop, so the prop alone would lose to `withRtlInputAlignment` in RTL.
  const contentStyle: StyleProp<TextStyle> | undefined = textAlign ? [style, { textAlign }] : style;
  const inputStyle: StyleProp<TextStyle> = multiline
    ? contentStyle
    : [contentStyle, INPUT_BOX_VERTICAL_STYLE];
  // Only a single-line field can rest: a multiline field's own box already
  // starts at its top left, and a masked field must never paint its value in a
  // `Text`. An empty field keeps its placeholder visible through the real input.
  const hostsPreview = restingText !== undefined && multiline !== true;
  const showsPreview =
    hostsPreview && props.secureTextEntry !== true && !focused && resting.length > 0;

  const input = (
    <TextInput
      {...props}
      maxFontSizeMultiplier={fontScaleCap ?? maxFontSizeMultiplier}
      multiline={multiline}
      numberOfLines={multiline ? numberOfLines : 1}
      className={cn(
        multiline ? INPUT_MULTILINE_INSET_CLASS : INPUT_BOX_SHAPE_CLASS,
        className,
        multiline ? undefined : INPUT_BOX_LINE_HEIGHT_CLASS
      )}
      style={withRtlInputAlignment(inputStyle)}
      textAlignVertical={multiline ? textAlignVertical : 'center'}
      // An explicit `textAlign` attaches a paragraph style whose default line
      // break mode wraps an overlong value onto a second line; a single-line
      // field draws one. A caller's own mode still wins.
      lineBreakModeIOS={multiline ? lineBreakModeIOS : (lineBreakModeIOS ?? 'clip')}
      placeholderTextColor={placeholderTextColor ?? colors.mutedForeground}
      onChangeText={
        hostsPreview
          ? value => {
              valueRef.current = value;
              onChangeText?.(value);
            }
          : onChangeText
      }
      onFocus={
        hostsPreview
          ? event => {
              setFocused(true);
              onFocus?.(event);
            }
          : onFocus
      }
      onBlur={
        hostsPreview
          ? event => {
              setFocused(false);
              setResting(valueRef.current);
              onBlur?.(event);
            }
          : onBlur
      }
    />
  );
  if (!hostsPreview) {
    return input;
  }
  // One wrapper in both states: gaining or losing focus must not remount the
  // native input, because a remount drops the text of an uncontrolled field.
  return (
    <View className="relative">
      {input}
      {showsPreview && (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className={cn(
            'absolute inset-px justify-center rounded-md bg-background pl-3 pr-3 dark:bg-[#FFFFFF0A]',
            // The preview paints over the input, so it carries the disabled
            // dimming the caller put on the input itself; otherwise a disabled
            // field would look enabled while it rests.
            props.editable === false && 'opacity-50'
          )}
        >
          <Text
            numberOfLines={1}
            className="text-sm font-normal text-foreground"
            style={withRtlInputAlignment(contentStyle)}
            maxFontSizeMultiplier={fontScaleCap ?? maxFontSizeMultiplier}
          >
            {resting}
          </Text>
        </View>
      )}
    </View>
  );
}

export { Input };
