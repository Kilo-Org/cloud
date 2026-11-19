import { Platform } from 'react-native';

/**
 * The `autoCorrect` value for TextInputs whose text the app rewrites
 * programmatically while the field can be focused (share prefill, voice
 * transcript, paste, clear-on-send, controlled value writes).
 *
 * On Android a tap on a word carrying an easy-correction `SuggestionSpan`
 * schedules the framework's suggestion popup about a double-tap timeout
 * later (`Editor$SuggestionsPopupWindow`, `Editor.replace`). If the app
 * replaces the field's text inside that window
 * (`ReactEditText.maybeSetText` swaps the whole editable in place), the
 * popup re-applies span bounds that no longer fit the shorter text and
 * `SpannableStringBuilder.setSpan` throws
 * `IndexOutOfBoundsException: setSpan (N ... N) ends beyond length N` on
 * the main thread. Android has no app-level API to cancel that pending
 * popup, and React Native maps `autoCorrect` to the
 * `TYPE_TEXT_FLAG_AUTO_CORRECT`/`TYPE_TEXT_FLAG_NO_SUGGESTIONS` input-type
 * flags, so keeping autocorrect off on the rewritten fields is the only
 * lever that removes the crash class. The cost is that the field stops
 * offering its own corrections on Android: `NO_SUGGESTIONS` is set and
 * `AUTO_CORRECT` is not, so the framework adds no correction offer to the
 * text. The keyboard app's own prediction bar is drawn from the IME and
 * stays as it is; a device measurement on Android 16 with Gboard showed
 * the bar still visible and no autocorrection applied to the field on
 * either the flag or the platform default. Typing, capitalization, and
 * the keyboard itself work as before.
 *
 * iOS keeps autocorrect on: the crash is Android-only and iOS behavior
 * must not change.
 */
export const REWRITTEN_INPUT_AUTO_CORRECT = Platform.OS !== 'android';
