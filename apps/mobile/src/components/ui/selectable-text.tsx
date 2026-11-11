import { type LayoutChangeEvent, type StyleProp, TextInput, type TextStyle } from 'react-native';
import { useContext } from 'react';

import { TextClassContext } from '@/components/ui/text';
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
 * Read-only multiline text that keeps the platform's native selection on iOS.
 *
 * `Text selectable` cannot deliver it in React Native 0.86:
 * `RCTParagraphComponentView.handleLongPress:` presents a `UIEditMenuInteraction`
 * without ever calling `becomeFirstResponder`, so the first long press shows an
 * empty menu (`RCTParagraphComponentView.mm:311`), and `canPerformAction:`
 * validates only `copy:` (`:336`), so selection handles and Share never appear.
 * A read-only multiline `TextInput` is a real `UITextView`, which owns its
 * responder state and gives the platform's own callout on the first press.
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
  return (
    <TextInput
      // Mirrors the base string of `textVariants` in ui/text.tsx, so the
      // shared weight and size do not silently drop on a raw TextInput.
      className={cn('text-foreground text-base font-medium', textClass, 'p-0', className)}
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
