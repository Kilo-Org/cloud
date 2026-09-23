import { readStoredValueSafe, writeStoredValueSafe } from '@/lib/auth/secure-store-value';
import { chainSave } from '@/lib/hooks/save-chain';
import { encodeStorageKey, VOICE_NETWORK_CONSENT_KEY_PREFIX } from '@/lib/storage-keys';

/**
 * Per-user network-fallback consent for voice transcription (P1-I-68a). A
 * SEPARATE record from the DEC-02 analytics consent in `src/lib/consent.ts`:
 * no speech path may read or write that record.
 */
export type VoiceNetworkConsent = 'granted' | 'declined' | 'unset';

type VoiceNetworkConsentListener = (userId: string, value: VoiceNetworkConsent) => void;

const listeners = new Set<VoiceNetworkConsentListener>();

function keyFor(userId: string): string {
  return encodeStorageKey(VOICE_NETWORK_CONSENT_KEY_PREFIX, userId);
}

function notifyVoiceNetworkConsent(userId: string, value: VoiceNetworkConsent): void {
  for (const listener of listeners) {
    listener(userId, value);
  }
}

export function subscribeToVoiceNetworkConsent(listener: VoiceNetworkConsentListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export async function readVoiceNetworkConsent(userId: string): Promise<VoiceNetworkConsent> {
  // A failed read is reported and treated as unset, so the consent gate asks
  // again instead of the read rejecting into the voice flow.
  const raw = await readStoredValueSafe(keyFor(userId));
  if (raw === 'granted' || raw === 'declined') {
    return raw;
  }
  // Absent or corrupt — treat as unset.
  return 'unset';
}

/**
 * Stores one decision and reports whether it reached the device. A failed write
 * is reported at warning level and returned as `false` rather than rejecting:
 * the settings switch rolls back and toasts on `false`, while the voice flow's
 * fire-and-forget callers stay rejection-free. Subscribers hear only about a
 * stored decision, so the in-memory state never claims a choice the device did
 * not keep — a relaunch asks again.
 */
export async function writeVoiceNetworkConsent(
  userId: string,
  value: 'granted' | 'declined'
): Promise<boolean> {
  const stored = await chainSave(keyFor(userId), async () => {
    const result = await writeStoredValueSafe(keyFor(userId), value);
    return result;
  });
  if (stored) {
    notifyVoiceNetworkConsent(userId, value);
  }
  return stored;
}
