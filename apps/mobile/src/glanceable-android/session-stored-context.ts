import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

/**
 * The account and scope the Android follow lifecycle reads from the keychain
 * (`session-follow.ts`), split out so a locked keychain reads as unavailable and
 * never as a sign-out.
 */

/** One followed session's scope. */
type StoredSessionScope = { userId: string; organizationId: string | null };

/** The one read this module needs from the keychain module. */
type SecureStoreModule = { getItemAsync: (key: string) => Promise<string | null> };

/**
 * The stored scope: the account and organization, `null` when no account is
 * signed in, or `'unavailable'` when the keychain could not be read (a locked
 * device, a headless start before unlock). Only a signed-out read may end the
 * follows: an unreadable keychain is not a sign-out.
 */
export type StoredContext = StoredSessionScope | null | 'unavailable';

/** The stored-context reader a suite injects, so no keychain loads under test. */
type StoredContextReader = () => StoredContext;

let storedContextReader: StoredContextReader | null = null;

/** Test-only: replace the keychain read that supplies the stored scope. */
export function _setStoredContextReaderForTests(reader: StoredContextReader | null): void {
  storedContextReader = reader;
}

/**
 * The stored account and scope, as the iOS adoption reads them. The keychain
 * module loads lazily: this module's file is imported by the Home widget
 * register, whose suites never load a native store.
 */
export async function readStoredContext(): Promise<StoredContext> {
  if (storedContextReader !== null) {
    return storedContextReader();
  }
  try {
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
    const { getItemAsync } = require('@/lib/auth/secure-store') as SecureStoreModule;
    const userId = await getItemAsync(ACTIVE_USER_ID_KEY);
    if (userId === null) {
      return null;
    }
    return { userId, organizationId: await getItemAsync(ORGANIZATION_STORAGE_KEY) };
  } catch {
    // The next foreground or push reads it again.
    return 'unavailable';
  }
}
