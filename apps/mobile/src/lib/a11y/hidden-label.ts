import { type AccessibilityProps } from 'react-native';

/**
 * Props that keep a visible label out of the accessibility tree while it stays
 * painted.
 *
 * Use them on the label of a row whose own control already carries that label —
 * a switch named after the tool, skill or server beside it — so the row reaches
 * a screen reader as one named control instead of a text stop followed by the
 * control that repeats it.
 *
 * Both platforms need a prop: `accessible={false}` is what removes the
 * paragraph's elements on iOS, and Android's text managers map `accessible`
 * onto focusability alone, so `importantForAccessibility="no"` is what takes
 * the text out of TalkBack.
 */
export const HIDDEN_LABEL_PROPS = {
  accessible: false,
  importantForAccessibility: 'no',
} as const satisfies AccessibilityProps;
