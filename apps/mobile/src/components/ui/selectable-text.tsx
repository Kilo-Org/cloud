import {
  type LayoutChangeEvent,
  Platform,
  type StyleProp,
  TextInput,
  type TextStyle,
} from 'react-native';
import { useContext } from 'react';

import { Text, TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type SelectableTextProps = {
  children: string;
  className?: string;
  /**
   * The value's own text layout, such as its base direction and start
   * alignment (`ltrValueTextStyle`). Inline, not a class: NativeWind maps
   * `textAlign` to a native prop for `TextInput` and crashes on it in this
   * version.
   */
  style?: StyleProp<TextStyle>;
  /** The read-only value's accessible name, when its visible label names it. */
  accessibilityLabel?: string;
  /** Extra guidance for the value, as its editable counterpart carries. */
  accessibilityHint?: string;
  onLayout?: (event: LayoutChangeEvent) => void;
};

/**
 * Read-only text that keeps the platform's own selection.
 *
 * On iOS, `Text selectable` cannot deliver selection in React Native 0.86:
 * `RCTParagraphComponentView.handleLongPress:` presents a `UIEditMenuInteraction`
 * without ever calling `becomeFirstResponder`, so the first long press shows an
 * empty menu (`RCTParagraphComponentView.mm:311`), and `canPerformAction:`
 * validates only `copy:` (`:336`), so selection handles and Share never appear.
 * A read-only multiline `TextInput` is a real `UITextView`, which owns its
 * responder state and gives the platform's own callout on the first press.
 *
 * Android has neither defect: a plain `TextView` already runs the platform's
 * selection, so the value renders as the app's own `Text` with `selectable`.
 * A read-only `EditText` there would be announced to TalkBack as an editable
 * text field, which a value is not; the static branch therefore sets no role,
 * because a text node is already text to an assistive reader.
 *
 * The static branch names the value's own base direction (`direction="auto"`),
 * because a read-only value is copy the app did not write. A right-to-left
 * interface therefore adds no U+200F mark to the text a reader selects and
 * copies, and the copied string matches the iOS branch, which copies the raw
 * string. A caller that pins its own direction through `style`
 * (`codeFieldTextStyle`) still wins, because that style lands after the
 * computed direction in the array `Text` builds.
 *
 * The text flows through `value`, not `defaultValue`, because the sheet
 * re-resolves a streaming part from the live `messages` prop on every render.
 * The repo rule that bans `value` plus state for editable iOS inputs does not
 * apply: this input is read-only and has no state.
 *
 * While the text changes under an active selection, UIKit resets the selection;
 * that is the platform's own behavior. When the part vanishes, the parent swaps
 * to its "unavailable" line and this input unmounts, which also ends the
 * selection. Neither case needs code here.
 */
export function SelectableText({
  children,
  className,
  style,
  accessibilityLabel,
  accessibilityHint,
  onLayout,
}: Readonly<SelectableTextProps>) {
  const textClass = useContext(TextClassContext);
  // One class string for both branches. The base mirrors `textVariants` in
  // ui/text.tsx, so the shared weight and size never drop on the raw TextInput.
  // `Text` merges that variant and the `TextClassContext` again, and
  // `tailwind-merge` collapses the repeats, so the rendered classes match the
  // TextInput's exactly. `p-0` cancels the `EditText`'s native padding and is
  // inert on a text node.
  const classes = cn('text-foreground text-base font-medium', textClass, 'p-0', className);
  if (Platform.OS === 'ios') {
    return (
      <TextInput
        className={classes}
        style={style}
        editable={false}
        multiline
        scrollEnabled={false}
        value={children}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        onLayout={onLayout}
      />
    );
  }
  return (
    <Text
      className={classes}
      style={style}
      direction="auto"
      selectable
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onLayout={onLayout}
    >
      {children}
    </Text>
  );
}
