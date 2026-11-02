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
 * → replace + inline validation at the call site.
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

type PrLinkPasteEmptyReason = 'denied' | 'empty';

/**
 * A read that trims to nothing is either a truly empty clipboard or a denied
 * iOS paste: iOS returns an empty string when the prompt was declined while
 * `hasStringAsync()` still sees the clipboard text.
 */
export function selectPrLinkPasteEmptyReason(
  clipboard: string | null | undefined,
  clipboardHasString: boolean
): PrLinkPasteEmptyReason {
  return (clipboard ?? '').length === 0 && clipboardHasString ? 'denied' : 'empty';
}

type PrLinkPasteClipboardReader = {
  getStringAsync: () => Promise<string | null | undefined>;
  hasStringAsync: () => Promise<boolean>;
};

/**
 * A paste tap's clipboard outcome. `empty` carries why the read produced
 * nothing, so the call site picks the toast that names it; every other kind
 * carries the text to write into the field.
 */
export type PrLinkPasteOutcome =
  | { kind: 'valid-pr-url'; text: string }
  | { kind: 'non-url-text'; text: string }
  | { kind: 'empty'; reason: PrLinkPasteEmptyReason };

/**
 * Read the clipboard for a paste tap without ever rejecting.
 *
 * The control runs this as a fire-and-forget press handler, so a rejected
 * read would leave the tap with no visible result at all: no text, no
 * validation, no toast. A read the platform refuses — the iOS paste prompt
 * declined, a service that is not available, a throw out of the native
 * module — is reported as `denied`, the state whose copy already tells the
 * reader that paste access was refused and asks them to try again. The
 * clipboard-empty answer keeps its own copy through
 * `selectPrLinkPasteEmptyReason`, so a resolver that throws on the second
 * probe cannot swallow the tap either.
 *
 * The attachment helpers (`readClipboardText`, `hasClipboardText`) also
 * swallow a failed read, but they collapse it into `''`/`false`, which this
 * control cannot use: it has to tell a refused read from a clipboard that is
 * genuinely empty to pick the copy that names the right cause.
 */
export async function readPrLinkPasteClipboard(
  reader: PrLinkPasteClipboardReader
): Promise<PrLinkPasteOutcome> {
  const textRead = await settleClipboardRead(() => reader.getStringAsync());
  if (!textRead.ok) {
    return { kind: 'empty', reason: 'denied' };
  }
  const clipboard = textRead.value ?? '';
  const decision = decidePrLinkPaste(clipboard);
  if (decision.kind !== 'empty') {
    return decision;
  }
  const probe = await settleClipboardRead(() => reader.hasStringAsync());
  if (!probe.ok) {
    return { kind: 'empty', reason: 'denied' };
  }
  return { kind: 'empty', reason: selectPrLinkPasteEmptyReason(clipboard, probe.value) };
}

/** One clipboard read, with a refusal reported as data instead of a rejection. */
async function settleClipboardRead<T>(
  read: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

/** Toast copy when paste finds an empty clipboard. */
export function prLinkToastClipboardEmptyCopy(): string {
  return i18n.t('prReview.linkPasteClipboardEmpty');
}
/** Toast copy when the reader denied the paste prompt. */
export function prLinkToastPasteDeniedCopy(): string {
  return i18n.t('prReview.linkPasteDenied');
}

export type PrLinkOpenState = 'empty' | 'invalid' | 'valid';

/**
 * Derived state of the entry field's Open affordance: 'empty' for a blank
 * field, 'invalid' for text no provider resolves, 'valid' otherwise. Used
 * both while typing and for the restored draft, so a cancelled open comes
 * back with Open already enabled.
 */
export function selectPrLinkOpenState(raw: string): PrLinkOpenState {
  if (raw.trim().length === 0) {
    return 'empty';
  }
  return decidePrLinkOpen(raw).kind === 'open' ? 'valid' : 'invalid';
}
