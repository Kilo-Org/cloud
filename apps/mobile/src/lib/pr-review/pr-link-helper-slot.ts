export type PrLinkHelperMessage = 'invalid' | 'clipboard-empty';

type PrLinkHelperSlotState = 'invalid' | 'clipboard-empty' | 'hint' | 'none';

type PrLinkHelperSlotInput = {
  /** Whether the PR-link field currently has any text. */
  readonly hasInput: boolean;
  /**
   * Active transient message. `invalid` and `clipboard-empty` are mutually
   * exclusive at the call site (last-set wins); `null` means no message.
   */
  readonly message: PrLinkHelperMessage | null;
};

/**
 * Select the reserved-height helper-slot content for the PR-link entry field.
 *
 * Priority: active message (invalid / clipboard-empty) wins over hint/none.
 * Hint only when the field is empty and no message is active; none when the
 * field has text and no message is active. The slot always keeps fixed height
 * in the UI regardless of which state is selected.
 */
export function selectPrLinkHelperSlotState(input: PrLinkHelperSlotInput): PrLinkHelperSlotState {
  if (input.message === 'invalid') {
    return 'invalid';
  }
  if (input.message === 'clipboard-empty') {
    return 'clipboard-empty';
  }
  if (!input.hasInput) {
    return 'hint';
  }
  return 'none';
}

export const PR_LINK_HELPER_INVALID_COPY = 'Not a GitHub pull request link';
export const PR_LINK_HELPER_CLIPBOARD_EMPTY_COPY = 'Clipboard is empty';
