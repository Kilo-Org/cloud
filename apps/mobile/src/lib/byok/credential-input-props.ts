import { type TextInputProps } from 'react-native';

/**
 * What every credential input asks of the keyboard: no autocorrection, no
 * spell checking, and no autofill or learning, so a pasted key never reaches
 * the device's personal dictionary or a suggestion bar. `textContentType`
 * stays `none` for the same reason: offering to save a provider secret in
 * iCloud Keychain is not a favour to the reader.
 *
 * A single-line credential is also masked with `secureTextEntry`. Android
 * ignores that on a multiline input and iOS has no masked text view at all, so
 * the multiline value — the Vertex private key — takes no soft-keyboard input
 * instead: it is pasted, and an input method that never opens cannot suggest or
 * learn it.
 */
export const CREDENTIAL_INPUT_PROPS = {
  autoCapitalize: 'none',
  autoCorrect: false,
  autoComplete: 'off',
  spellCheck: false,
  importantForAutofill: 'no',
  textContentType: 'none',
} satisfies TextInputProps;
