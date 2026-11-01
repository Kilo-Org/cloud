import { Keyboard } from 'react-native';

/**
 * The tap contract for a picker whose search field holds the software keyboard:
 * the first tap on a row always reaches that row.
 *
 * `keyboardShouldPersistTaps="handled"` does not deliver that tap. React Native
 * implements the prop in JS (`ScrollView._handleStartShouldSetResponder`): while
 * the keyboard is dismissible and the touched node is not the focused input, the
 * scroll view asks to become the responder itself, and when it wins the press is
 * swallowed — the row never fires and the keyboard stays up, so a second tap is
 * lost the same way. `"always"` never makes that claim, so the row's own press
 * handler runs; the keyboard then closes through `dismissSearchPickerKeyboard`
 * because the pick was applied, not on the way to it.
 *
 * Every list that holds searchable rows carries these, whether it is a
 * `FlashList` body or a `ScrollView` of mapped rows.
 */
export const SEARCHABLE_PICKER_LIST_PROPS = {
  keyboardShouldPersistTaps: 'always',
  keyboardDismissMode: 'on-drag',
} as const;

/**
 * Closes the search keyboard when a pick is applied, so a pick looks the same as
 * one taken with the keyboard already dismissed: the chosen row's check mark and
 * whatever the choice reveals below it sit where the keyboard was.
 */
export function dismissSearchPickerKeyboard(): void {
  Keyboard.dismiss();
}
