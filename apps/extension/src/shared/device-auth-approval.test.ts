import { describe, expect, it } from 'vitest';
import { persistApprovedDeviceAuth } from './device-auth-approval';
import type { AuthStorageArea, StoredAuth } from './auth';

const auth: StoredAuth = {
  token: 'token-1',
  userEmail: 'user@kilo.ai',
};

const createStorage = ({
  failSet = false,
}: {
  readonly failSet?: boolean;
} = {}): AuthStorageArea & { readonly saved: StoredAuth | undefined } => {
  let saved: StoredAuth | undefined = undefined;

  return {
    getItem: () => saved,
    removeItem: () => {
      saved = undefined;
    },
    get saved() {
      return saved;
    },
    setItem: (_key, value) => {
      if (failSet) {
        throw new Error('Storage unavailable.');
      }

      saved = value;
    },
  };
};

describe('approved device auth persistence', () => {
  it('returns signed-in auth after the approved token is stored', async () => {
    const storage = createStorage();

    await expect(persistApprovedDeviceAuth(storage, auth)).resolves.toStrictEqual({
      auth,
      status: 'signedIn',
    });
    expect(storage.saved).toStrictEqual(auth);
  });

  it('returns a sign-in failure when approved token storage fails', async () => {
    await expect(
      persistApprovedDeviceAuth(createStorage({ failSet: true }), auth)
    ).resolves.toStrictEqual({
      message: 'Sign in failed. Try again.',
      status: 'failed',
    });
  });
});
