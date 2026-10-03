import { type StyleProp, TextInput, type TextInputProps, type TextStyle } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { withRtlInputAlignment } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

// The caller's classes come after the box's shape and before its line height:
// a caller's `px-4` beats the shared `px-3`, and every caller's own `text-*`
// size carries a line height of its own, so the one line box has to be
// re-asserted last (apps/mobile/AGENTS.md, Text inputs).
const INPUT_BOX_SHAPE_CLASS = 'min-h-[44px] px-3';
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

// Android TextInput ignores logical paddingInline; physical defaults remain
// overrideable by the caller's later px/py classes through tailwind-merge.
const INPUT_MULTILINE_INSET_CLASS = 'pl-3 pr-3 pt-2.5 pb-2.5';

/**
 * The one single-line box: `min-h-[44px] px-3 leading-[normal]`, no vertical
 * padding, Android's center gravity, one line box for the placeholder and the
 * value, and RTL content alignment. A call site keeps its own chrome, text size
 * and horizontal inset; a multiline caller keeps its own gravity and line break
 * mode, plus the shared inset unless its padding classes override it.
 */
function Input({
  className,
  style,
  textAlign,
  placeholderTextColor,
  multiline,
  textAlignVertical,
  lineBreakModeIOS,
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
