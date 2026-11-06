import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { performRefresh, REFRESH_MARGIN_MS } from '@/lib/auth/credentials';
import {
  getActiveTokenSnapshot,
  getAuthTokenForRequest,
  isSignOutTeardownActive,
} from '@/lib/auth/token-owner';

/** A connection may renew credentials only for the account that opened it. */
export async function nativeRemoteCredential(epoch: number): Promise<string> {
  const assertOwner = () => {
    if (!isCurrentAuthEpoch(epoch) || isSignOutTeardownActive()) {
      throw new Error('Native remote account changed');
    }
  };
  assertOwner();
  let token = await getAuthTokenForRequest();
  assertOwner();
  const active = getActiveTokenSnapshot();
  if (
    active?.expiresAtMs !== null &&
    active?.expiresAtMs !== undefined &&
    active.expiresAtMs <= Date.now() + REFRESH_MARGIN_MS
  ) {
    await performRefresh();
    assertOwner();
    token = await getAuthTokenForRequest();
    assertOwner();
  }
  if (!token) {
    throw new Error('Native remote requires sign-in');
  }
  return token;
}
