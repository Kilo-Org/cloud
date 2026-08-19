import * as SecureStore from 'expo-secure-store';

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
  const raw = await SecureStore.getItemAsync(keyFor(userId));
  if (raw === 'granted' || raw === 'declined') {
    return raw;
  }
  // Absent or corrupt — treat as unset.
  return 'unset';
}

export async function writeVoiceNetworkConsent(
  userId: string,
  value: 'granted' | 'declined'
): Promise<void> {
  await chainSave(keyFor(userId), async () => {
    await SecureStore.setItemAsync(keyFor(userId), value);
  });
  notifyVoiceNetworkConsent(userId, value);
}
