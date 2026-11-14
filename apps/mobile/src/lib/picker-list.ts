import { Keyboard } from 'react-native';

/**
 * The tap contract for a picker whose search field holds the software keyboard:
 * the first tap on a row always reaches that row.
 *
 * React Native implements the prop in JS, and the phase that loses the tap is
 * the capture one: `ScrollView._handleStartShouldSetResponderCapture` claims the
 * touch start before any row sees it, and it does that for `"never"`, the
 * platform default, only. `"handled"` claims in the bubble phase instead
 * (`_handleStartShouldSetResponder`), after a nested pressable had its chance,
 * so a row tap already reaches the row there.
 *
 * These pickers ask for `"always"` because the keyboard must close on the pick,
 * not on the way to it, and `"always"` is the only value that never lets the
 * scroll view unfocus the search field: `_handleResponderRelease` skips that
 * blur for `"always"`, so a touch on the sheet background or a drag keeps the
 * keyboard up. `dismissSearchPickerKeyboard` then closes it exactly once, when a
 * pick is applied.
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
