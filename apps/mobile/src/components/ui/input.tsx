import { TextInput, type TextInputProps } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { withRtlInputAlignment } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

// The box's floor and horizontal padding come before the caller's classes, so
// a caller's `px-4` overrides the shared `px-3` through tailwind-merge. Its
// line height comes after them: tailwind-merge drops `leading-*` when a later
// `text-*` sets a line height of its own, and every caller keeps its own text
// size (`text-sm` here), so the box has to re-assert the one line box both the
// placeholder and the value are drawn in.
const INPUT_BOX_SHAPE_CLASS = 'min-h-[44px] px-3';
const INPUT_BOX_LINE_HEIGHT_CLASS = 'leading-[normal]';

/** The one single-line box. Every single-line field renders this. */
export const INPUT_BOX_CLASS = `${INPUT_BOX_SHAPE_CLASS} ${INPUT_BOX_LINE_HEIGHT_CLASS}`;

/**
 * The shared single-line box: `min-h-[44px] px-3 leading-[normal]`.
 *
 * This is the only place the single-line box lives. A call site keeps its own
 * chrome (border, fill, text size) and its own horizontal padding — a caller's
 * `px-4` overrides the shared `px-3` through tailwind-merge, because the
 * caller's className comes after the box's shape in `cn` — but it must not add
 * vertical padding or a fixed height: the box already brings `min-h-[44px]`
 * (the touch floor, and a floor rather than a height so Dynamic Type still
 * grows the field) and `leading-[normal]` (one line box for the placeholder
 * and the value, which the same TextInput draws).
 *
 * The request's "explicit vertical padding" is delivered as this explicit
 * vertical box instead: `apps/mobile/AGENTS.md` (Text inputs) forbids `py-*`
 * on a single-line input, because iOS insets the already-centered text rect by
 * the padding and draws the text and the placeholder low. Vertical padding
 * would move both below the middle, which the "focused and unfocused put the
 * text in the same place" requirement and the 44pt floor cannot accept.
 * `textAlignVertical: 'center'` is the Android half of the same fix: the
 * platform's default gravity is top in a taller box while the placeholder is
 * drawn by a different path, which is the baseline split the sign-in email
 * field showed.
 *
 * `withRtlInputAlignment` stays on every single-line input: RN 0.86 does not
 * resolve `textAlign: 'auto'` from the native direction, so a Latin address
 * stays left-aligned under a right-aligned label in an RTL catalog
 * (`rtl-text.ts`).
 *
 * A `multiline` caller is a different control: it keeps its own box (an
 * explicit `leading-*`) and its own `textAlignVertical`, so neither the shared
 * box nor the forced vertical alignment applies.
 */
function Input({
  className,
  style,
  placeholderTextColor,
  multiline,
  textAlignVertical,
  ...props
}: Readonly<TextInputProps & React.RefAttributes<TextInput>>) {
  const colors = useThemeColors();
  return (
    <TextInput
      {...props}
      multiline={multiline}
      className={cn(
        multiline ? undefined : INPUT_BOX_SHAPE_CLASS,
        className,
        multiline ? undefined : INPUT_BOX_LINE_HEIGHT_CLASS
      )}
      style={withRtlInputAlignment(style)}
      textAlignVertical={multiline ? textAlignVertical : 'center'}
      placeholderTextColor={placeholderTextColor ?? colors.mutedForeground}
    />
  );
}

export { Input };
