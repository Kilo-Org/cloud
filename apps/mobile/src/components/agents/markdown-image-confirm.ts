/**
 * Per-auth-session memory of confirmed markdown image URIs. Keyed by the
 * source URI so a FlashList recycle never re-shows the Load affordance for a
 * URI the user already confirmed in this session. Cleared on sign-in and
 * sign-out so one account's confirmations never auto-load for another.
 */
const confirmedUris = new Set<string>();
const listeners = new Set<() => void>();

export function subscribeMarkdownImageConfirmMemory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isMarkdownImageConfirmed(uri: string): boolean {
  return confirmedUris.has(uri);
}

export function confirmMarkdownImage(uri: string): void {
  if (!confirmedUris.has(uri)) {
    confirmedUris.add(uri);
    for (const listener of listeners) {
      listener();
    }
  }
}

export function clearMarkdownImageConfirmMemory(): void {
  if (confirmedUris.size === 0) {
    return;
  }
  confirmedUris.clear();
  for (const listener of listeners) {
    listener();
  }
}
