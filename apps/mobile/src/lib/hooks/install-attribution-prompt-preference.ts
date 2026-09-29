import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { INSTALL_ATTRIBUTION_PROMPT_SEEN_KEY } from '@/lib/storage-keys';

/**
 * Device-level record that the install-attribution explainer has been answered.
 *
 * iOS keeps the tracking authorization `undetermined` until the system prompt
 * is requested, so a soft "Not now" leaves no native trace. Persisting the
 * answer here is what stops the explainer from reappearing on the next cold
 * launch.
 */
const promptSeenStore = createSecureStorePreference<boolean>({
  key: INSTALL_ATTRIBUTION_PROMPT_SEEN_KEY,
  defaultValue: false,
  parse: raw => raw === 'true',
  serialize: value => (value ? 'true' : 'false'),
});

// Warm the disk read at module scope so the first launch after an answer does
// not briefly consider the explainer unseen.
promptSeenStore.preload();

export function readInstallAttributionPromptSeen(): boolean {
  return promptSeenStore.get();
}

export function markInstallAttributionPromptSeen(): void {
  promptSeenStore.set(true);
}

/** Await the persisted read before deciding whether to show the explainer. */
export async function whenInstallAttributionPromptSeenLoaded(): Promise<void> {
  await promptSeenStore.whenLoaded();
}
