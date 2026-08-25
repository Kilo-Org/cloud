/**
 * Tiny pub/sub so every in-app Modal can close itself the instant the privacy
 * cover fires (an app background on a covered route). A native Modal renders
 * above the JS root, so the cover overlay cannot paint over it — the Modal
 * must close itself instead.
 */

type PrivacyCoverListener = () => void;

const listeners = new Set<PrivacyCoverListener>();

export function emitPrivacyCover(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePrivacyCover(listener: PrivacyCoverListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
