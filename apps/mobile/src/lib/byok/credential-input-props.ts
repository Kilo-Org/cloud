import { type TextInputProps } from 'react-native';

/**
 * What every credential input asks of the keyboard: no autocorrection, no
 * spell checking, and no autofill or learning, so a pasted key never reaches
 * the device's personal dictionary or a suggestion bar. `textContentType`
 * stays `none` for the same reason: offering to save a provider secret in
 * iCloud Keychain is not a favour to the reader.
 *
 * Every credential input is single-line, so `secureTextEntry` masks it on both
 * platforms: React Native obscures a single-line input and cannot obscure a
 * multiline one (its own prop documentation says so, and iOS backs a multiline
 * input with a text view that has no masking at all). A multiline secret would
 * therefore show its value on screen and read it out to assistive technology,
 * which is why no credential field asks for one.
 */
export const CREDENTIAL_INPUT_PROPS = {
  autoCapitalize: 'none',
  autoCorrect: false,
  autoComplete: 'off',
  spellCheck: false,
  importantForAutofill: 'no',
  textContentType: 'none',
} satisfies TextInputProps;
