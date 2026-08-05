import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL } from '@/lib/config';
import { parseTokenPair } from '@/lib/auth/native-auth-contract';
import {
  AUTH_TOKEN_KEY,
  LEGACY_EXCHANGE_DONE_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from '@/lib/storage-keys';

export async function exchangeLegacyToken(): Promise<{
  token: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  try {
    // Guard: run at most once. If the marker is already set the exchange succeeded
    // (or was deliberately skipped) in a past launch.
    const alreadyExchanged = await SecureStore.getItemAsync(LEGACY_EXCHANGE_DONE_KEY);
    if (alreadyExchanged) {
      return null;
    }

    const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
    if (!token) {
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

    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, parsed.token);
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, parsed.refreshToken);
    await SecureStore.setItemAsync(
      TOKEN_EXPIRES_AT_KEY,
      String(Date.now() + parsed.expiresIn * 1000)
    );
    // Persist the marker so we never exchange again.
    await SecureStore.setItemAsync(LEGACY_EXCHANGE_DONE_KEY, '1');

    return { token: parsed.token, refreshToken: parsed.refreshToken, expiresIn: parsed.expiresIn };
  } catch {
    return null;
  }
}
