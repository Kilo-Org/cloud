import { type ProviderPrRef } from '@kilocode/app-shared/provider-review';

import { i18n } from '@/i18n';
import { parseProviderPrUrl } from '@/lib/pr-review/provider-pr-url';

type PrLinkPasteDecision =
  | { kind: 'valid-pr-url'; text: string }
  | { kind: 'non-url-text'; text: string }
  | { kind: 'empty' };

/**
 * Decide how a paste-button tap should treat clipboard contents.
 * Trims first; empty → no insertion; a GitHub, GitLab (any host, including
 * self-managed) or Bitbucket review URL → replace + navigate; anything else
 * → replace + invalid toast at the call site.
 */
export function decidePrLinkPaste(clipboard: string | null | undefined): PrLinkPasteDecision {
  const text = (clipboard ?? '').trim();
  if (text.length === 0) {
    return { kind: 'empty' };
  }
  if (parseProviderPrUrl(text) !== null) {
    return { kind: 'valid-pr-url', text };
  }
  return { kind: 'non-url-text', text };
}

type PrLinkOpenDecision = { kind: 'open'; ref: ProviderPrRef } | { kind: 'invalid' };

/**
 * Decide what the entry screen's Open action does with the field text: parse
 * it through the one provider URL resolver and hand back the review identity
 * it names, or the invalid-link state. Self-managed GitLab hosts parse here
 * too — the server re-derives the authoritative instance (s2), so a
 * mismatched host lands on the clear not-authorized state downstream, never
 * a redirect.
 */
export function decidePrLinkOpen(raw: string): PrLinkOpenDecision {
  const ref = parseProviderPrUrl(raw.trim());
  return ref ? { kind: 'open', ref } : { kind: 'invalid' };
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
export function prLinkToastClipboardEmptyCopy(): string {
  return i18n.t('prReview.linkPasteClipboardEmpty');
}
/** Toast copy when paste or Open gets a link no provider serves. */
export function prLinkToastInvalidCopy(): string {
  // Reuses the pre-s7 key: it exists in all 86 catalogs, and renaming it in
  // en.json alone would make every catalog an "extra key" failure. s9
  // retranslates the changed English value.
  return i18n.t('prReview.linkPasteNotAPullRequest');
}
