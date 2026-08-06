import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL } from '@/lib/config';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { persistSignInCredentialsAtEpoch } from '@/lib/auth/credentials';
import { parseTokenPair } from '@/lib/auth/native-auth-contract';
import { AUTH_TOKEN_KEY, LEGACY_EXCHANGE_DONE_KEY } from '@/lib/storage-keys';

export async function exchangeLegacyToken(): Promise<{
  token: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  try {
    // Capture the epoch before any asynchronous read: every later epoch check
    // fences against this moment, so an exchange that started before a
    // sign-out can never send the stale token or persist its result.
    const epoch = currentAuthEpoch();

    // Guard: run at most once. If the marker is already set the exchange succeeded
    // (or was deliberately skipped) in a past launch.
    const alreadyExchanged = await SecureStore.getItemAsync(LEGACY_EXCHANGE_DONE_KEY);
    if (alreadyExchanged) {
      return null;
    }

    // Pre-owner bootstrap read: this runs before the token owner can hold a
    // value (cold start with a legacy token), so it reads SecureStore directly.
    const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
    if (!token) {
      return null;
    }

    // The session moved while the marker and legacy token were read: the token
    // may belong to a signed-out account. Discard before sending it.
    if (!isCurrentAuthEpoch(epoch)) {
      return null;
    }

    const response = await fetch(`${API_BASE_URL}/api/auth/native/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      // One-time exchange failure: retain old token, do not set the done
      // marker. Retry on the next app launch.
      return null;
    }

    const body: unknown = await response.json();
    const parsed = parseTokenPair(body);

    // An exchange response must include a full token pair with expiry.
    if (!parsed?.refreshToken || !parsed.expiresIn) {
      return null;
    }

    if (!isCurrentAuthEpoch(epoch)) {
      // The session moved while the exchange was in flight: discard the
      // result so it can never land after a sign-out.
      return null;
    }

    // Route the success write through the fenced credential write queue and
    // update the in-memory token owner. The epoch captured at the start of
    // the exchange is the expected epoch, so the write is fenced against the
    // moment the exchange began — never against a re-capture at write time.
    const published = await persistSignInCredentialsAtEpoch(parsed.token, parsed.refreshToken, {
      expiresIn: parsed.expiresIn,
      expectedEpoch: epoch,
    });
    if (!published) {
      // The session moved while the exchange write was fenced: stop before
      // the completion marker and the success result.
      return null;
    }
    if (!isCurrentAuthEpoch(epoch)) {
      return null;
    }
    // Persist the marker so we never exchange again.
    await SecureStore.setItemAsync(LEGACY_EXCHANGE_DONE_KEY, '1');
    if (!isCurrentAuthEpoch(epoch)) {
      await SecureStore.deleteItemAsync(LEGACY_EXCHANGE_DONE_KEY);
      return null;
    }

    return { token: parsed.token, refreshToken: parsed.refreshToken, expiresIn: parsed.expiresIn };
  } catch {
    return null;
  }
}
