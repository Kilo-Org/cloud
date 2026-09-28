import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  }),
}));

/* eslint-disable import/first */
import * as SecureStore from 'expo-secure-store';
import { CONSENT_USER_KEY_PREFIX, VOICE_NETWORK_CONSENT_KEY_PREFIX } from '@/lib/storage-keys';
import {
  readVoiceNetworkConsent,
  subscribeToVoiceNetworkConsent,
  type VoiceNetworkConsent,
  writeVoiceNetworkConsent,
} from './voice-network-consent';
/* eslint-enable import/first */

// Hex-encoded "user-1" is "757365722d31".
const USER_1_HEX = '757365722d31';

describe('voice network consent', () => {
  beforeEach(() => {
    store.clear();
  });

  it('round-trips a decision per user', async () => {
    await writeVoiceNetworkConsent('user-1', 'granted');
    expect(await readVoiceNetworkConsent('user-1')).toBe('granted');

    await writeVoiceNetworkConsent('user-2', 'declined');
    expect(await readVoiceNetworkConsent('user-1')).toBe('granted');
    expect(await readVoiceNetworkConsent('user-2')).toBe('declined');
  });

  it('reads an absent record as unset', async () => {
    expect(await readVoiceNetworkConsent('user-1')).toBe('unset');
  });

  it('reads a corrupt record as unset', async () => {
    store.set(`${VOICE_NETWORK_CONSENT_KEY_PREFIX}${USER_1_HEX}`, 'garbage');
    expect(await readVoiceNetworkConsent('user-1')).toBe('unset');
  });

  it('lets a later granted overwrite a declined record (re-askable)', async () => {
    await writeVoiceNetworkConsent('user-1', 'declined');
    expect(await readVoiceNetworkConsent('user-1')).toBe('declined');

    await writeVoiceNetworkConsent('user-1', 'granted');
    expect(await readVoiceNetworkConsent('user-1')).toBe('granted');
  });

  it('uses a key prefix distinct from the DEC-02 analytics consent record', () => {
    expect(VOICE_NETWORK_CONSENT_KEY_PREFIX).not.toBe(CONSENT_USER_KEY_PREFIX);
  });

  it('reports a failed write to the caller instead of rejecting', async () => {
    const listener = vi.fn<(userId: string, value: VoiceNetworkConsent) => void>();
    const unsubscribe = subscribeToVoiceNetworkConsent(listener);
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain locked'));

    // Total: the settings row branches on `false`, and the voice flow's
    // fire-and-forget callers stay rejection-free.
    await expect(writeVoiceNetworkConsent('user-1', 'granted')).resolves.toBe(false);

    // Nothing was stored, so no subscriber is told the choice was kept.
    expect(listener).not.toHaveBeenCalled();
    expect(await readVoiceNetworkConsent('user-1')).toBe('unset');
    unsubscribe();
  });

  it('notifies subscribers with the decision once the write succeeds', async () => {
    const listener = vi.fn<(userId: string, value: VoiceNetworkConsent) => void>();
    const unsubscribe = subscribeToVoiceNetworkConsent(listener);

    await expect(writeVoiceNetworkConsent('user-1', 'declined')).resolves.toBe(true);

    expect(listener).toHaveBeenCalledWith('user-1', 'declined');
    unsubscribe();
  });

  it('never writes the DEC-02 analytics consent record', async () => {
    await writeVoiceNetworkConsent('user-1', 'granted');

    expect(store.has(`${CONSENT_USER_KEY_PREFIX}${USER_1_HEX}`)).toBe(false);
    expect(store.get(`${VOICE_NETWORK_CONSENT_KEY_PREFIX}${USER_1_HEX}`)).toBe('granted');
  });
});
