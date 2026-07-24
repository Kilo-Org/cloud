import { parseGitHubPrUrl } from '@/lib/github-pr-url';

type PrLinkPasteDecision =
  | { kind: 'valid-pr-url'; text: string }
  | { kind: 'non-url-text'; text: string }
  | { kind: 'empty' };

/**
 * Decide how a paste-button tap should treat clipboard contents.
 * Trims first; empty → no insertion; valid PR URL → replace + navigate;
 * anything else → replace + invalid helper.
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
