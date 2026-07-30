import { parseGitHubPrUrl } from '@/lib/github-pr-url';

type PrLinkPasteDecision =
  | { kind: 'valid-pr-url'; text: string }
  | { kind: 'non-url-text'; text: string }
  | { kind: 'empty' };

/**
 * Decide how a paste-button tap should treat clipboard contents.
 * Trims first; empty → no insertion; valid PR URL → replace + navigate;
 * anything else → replace + invalid toast at the call site.
 */
export function decidePrLinkPaste(clipboard: string | null | undefined): PrLinkPasteDecision {
  const text = (clipboard ?? '').trim();
  if (text.length === 0) {
    return { kind: 'empty' };
  }
  if (parseGitHubPrUrl(text) !== null) {
    return { kind: 'valid-pr-url', text };
  }
  return { kind: 'non-url-text', text };
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

/** Toast copy when paste finds an empty clipboard. */
export const PR_LINK_TOAST_CLIPBOARD_EMPTY_COPY = 'Clipboard is empty';
/** Toast copy when paste or Open gets a non-PR link. */
export const PR_LINK_TOAST_INVALID_COPY = 'Not a GitHub pull request link';
