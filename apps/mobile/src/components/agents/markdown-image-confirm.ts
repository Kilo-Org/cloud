/**
 * Per-auth-session memory of confirmed markdown image URIs. Keyed by the
 * source URI so a FlashList recycle never re-shows the Load affordance for a
 * URI the user already confirmed in this session. Cleared on sign-in and
 * sign-out so one account's confirmations never auto-load for another.
 */
const confirmedUris = new Set<string>();

export function isMarkdownImageConfirmed(uri: string): boolean {
  return confirmedUris.has(uri);
}

export function confirmMarkdownImage(uri: string): void {
  confirmedUris.add(uri);
}

export function clearMarkdownImageConfirmMemory(): void {
  confirmedUris.clear();
}
