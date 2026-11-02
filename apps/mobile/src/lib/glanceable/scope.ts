import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';

/**
 * Scope reads shared by the push handler (`@/lib/notifications`) and the
 * glanceable front-approval orchestrator: the selected organization id and the
 * active-user id, both from SecureStore, and the signed-in scope they form.
 *
 * They read through `readStoredValueSafe` in `lib/auth/secure-store-value`, the
 * one SecureStore entry point: `expo-secure-store` is available on iOS and
 * Android alike, so neither platform lacks the capability and no per-platform
 * storage branch is kept — a single implementation serves both. A failed read
 * is reported and reads as an absent hint instead of rejecting into the
 * background push handler.
 *
 * They live here rather than beside either call site so both paths resolve the
 * same scope the glanceable snapshot is fenced on; a copy per caller would let
 * the approving surface and the sink disagree about which account is current.
 *
 * Two outcomes are available on purpose. The hint reads below fold "nothing
 * stored" and "could not read" into `null`, which is what their callers need: a
 * push handler that cannot read a hint drops the push either way.
 * {@link readSignedInScope} keeps them apart, because a snapshot fence must not
 * read a keychain that is merely locked as a different account.
 *
 * Nothing here loads a native module when the file is imported: the keychain
 * entry point is required inside the read. The glanceable mirror imports this
 * module from pure suites that inject their own store, and those suites must not
 * pull the `expo-secure-store` graph in behind it.
 */

async function readHint(key: string): Promise<string | null> {
  // Dynamic on purpose: a static import would pull `expo-secure-store` into every
  // suite that imports the glanceable mirror, and those run without a native
  // runtime. The specifier is fixed; only the load is deferred.
  const { readStoredValueSafe } = await import('@/lib/auth/secure-store-value');
  return readStoredValueSafe(key);
}

/**
 * Read the selected organization id for scope validation and token registration.
 * A missing hint only matches a personal scope; it cannot revive an org scope.
 */
export async function getSelectedOrganizationId(): Promise<string | null> {
  const organizationId = await readHint(ORGANIZATION_STORAGE_KEY);
  return organizationId;
}

/**
 * Read the active-user id for scope validation and logout reconciliation.
 * An unavailable hint drops the push rather than reviving a persisted scope.
 * The raw id never enters the snapshot.
 */
export async function getActiveUserId(): Promise<string | null> {
  const userId = await readHint(ACTIVE_USER_ID_KEY);
  return userId;
}

/**
 * The keychain entry point the scope read needs. A parameter so a caller that
 * already holds one — the glanceable mirror's injectable store — passes it in
 * instead of loading a second entry point beside it.
 */
export type ScopeKeychain = Readonly<{
  getItemAsync: (key: string) => Promise<string | null>;
}>;

/**
 * The signed-in scope as the snapshot fence needs it. Three outcomes, not two:
 * `absent` is a device with no account signed in, `unavailable` is a read that
 * did not complete (a locked keychain, a failed read). Only `known` can confirm
 * that a persisted record belongs to the account holding the device, and an
 * incomplete read is never a mismatch either.
 */
export type SignedInScope =
  | { readonly status: 'known'; readonly userId: string; readonly organizationId: string | null }
  | { readonly status: 'absent' }
  | { readonly status: 'unavailable' };

/**
 * Read both identity hints and report which of the three outcomes they are. A
 * failed read is reported at warning level and reads as `unavailable`, so a
 * caller fence never treats an unreadable keychain as a different account.
 */
export async function readSignedInScope(keychain: ScopeKeychain): Promise<SignedInScope> {
  try {
    const [userId, organizationId] = await Promise.all([
      keychain.getItemAsync(ACTIVE_USER_ID_KEY),
      keychain.getItemAsync(ORGANIZATION_STORAGE_KEY),
    ]);
    return userId === null ? { status: 'absent' } : { status: 'known', userId, organizationId };
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return { status: 'unavailable' };
  }
}
