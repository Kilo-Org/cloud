export type PrLinkHelperMessage = 'invalid' | 'clipboard-empty';

type PrLinkHelperSlotState = 'invalid' | 'clipboard-empty' | 'none';

type PrLinkHelperSlotInput = {
  /**
   * Active transient message. `invalid` and `clipboard-empty` are mutually
   * exclusive at the call site (last-set wins); `null` means no message.
   */
  readonly message: PrLinkHelperMessage | null;
};

/**
 * Select the helper-message content for the PR-link entry field.
 *
 * Priority: active message (invalid / clipboard-empty) wins over none.
 * No active message selects none — the input placeholder already shows the
 * example URL. The UI mounts helper text only when this is not `none`
 * (conditional mount; layout may shift when a message appears or clears).
 */
export function selectPrLinkHelperSlotState(input: PrLinkHelperSlotInput): PrLinkHelperSlotState {
  if (input.message === 'invalid') {
    return 'invalid';
  }
  if (input.message === 'clipboard-empty') {
    return 'clipboard-empty';
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
export const PR_LINK_HELPER_CLIPBOARD_EMPTY_COPY = 'Clipboard is empty';
