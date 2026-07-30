export type PrLinkHelperMessage = 'invalid';

type PrLinkHelperSlotState = 'invalid' | 'none';

type PrLinkHelperSlotInput = {
  /**
   * Active transient message. `null` means no message. Clipboard-empty
   * surfaces as a toast at the paste call site, not via this slot.
   */
  readonly message: PrLinkHelperMessage | null;
};

/**
 * Select the helper-message content for the PR-link entry field.
 *
 * Priority: active `invalid` message wins over none. No active message
 * selects none — the input placeholder already shows the example URL.
 * Clipboard-empty is a toast (see paste handler), not a slot state.
 * The UI keeps one always-mounted Text in a reserved slot and only
 * swaps the string (active copy or a non-breaking-space placeholder)
 * and color token, so appear/clear never shifts the input row or Open
 * button. The reservation is for `invalid`; placeholder stays mounted
 * when none.
 */
export function selectPrLinkHelperSlotState(input: PrLinkHelperSlotInput): PrLinkHelperSlotState {
  if (input.message === 'invalid') {
    return 'invalid';
  }
  return 'none';
}

type PrLinkClearButtonInput = {
  /** Whether the uncontrolled PR-link field currently has any text. */
  readonly hasInput: boolean;
};

/**
 * Whether the in-field clear control should render.
 * Present only when the field has content; absent when empty.
 */
export function selectPrLinkClearButtonVisible(input: PrLinkClearButtonInput): boolean {
  return input.hasInput;
}

export const PR_LINK_HELPER_INVALID_COPY = 'Not a GitHub pull request link';
/** Toast copy when paste finds an empty clipboard (not an inline helper). */
export const PR_LINK_HELPER_CLIPBOARD_EMPTY_COPY = 'Clipboard is empty';
