import { type StyleProp, TextInput, type TextInputProps, type TextStyle } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { withRtlInputAlignment } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

// Callers override the box's physical horizontal inset and chrome; the single-
// line height comes last because text-* sizes carry their own line height.
const INPUT_BOX_SHAPE_CLASS = 'min-h-[44px] pl-3 pr-3';
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
  ...props
}: Readonly<TextInputProps & React.RefAttributes<TextInput>>) {
  const colors = useThemeColors();
  // Fold the explicit `textAlign` prop into the style after the caller's own
  // style, so it lands after the RTL default too: RN flattens `style` after the
  // prop, so the prop alone would lose to `withRtlInputAlignment` in RTL.
  const contentStyle: StyleProp<TextStyle> | undefined = textAlign ? [style, { textAlign }] : style;
  const inputStyle: StyleProp<TextStyle> = multiline
    ? contentStyle
    : [contentStyle, INPUT_BOX_VERTICAL_STYLE];
  return (
    <TextInput
      {...props}
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
    />
  );
}

export { Input };
