import {
  type GatedReadStore,
  readGatedValueForUpdate,
  widgetSecureStore,
} from '@/lib/auth/secure-store-gated';
import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

/**
 * Scope reads shared by the push handler (`@/lib/notifications`) and the
 * glanceable front-approval orchestrator: the selected organization id and the
 * active-user id, both from SecureStore, and the signed-in scope they form.
 *
 * The two hints are written with the widget store's class
 * (`lib/auth/account-metadata-write`), so they are read through the widget store
 * as well: a push or a background refresh must resolve the account it acts for
 * with the screen locked, which the default `WHEN_UNLOCKED` class refuses. Only
 * the read is shared — no token and no other account item is reachable here.
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
 */

/**
 * One identity hint. `null` covers an absent value and a keychain that could not
 * answer, which is the answer both push paths act on the same way.
 */
async function readHint(key: string): Promise<string | null> {
  const read = await readGatedValueForUpdate(readStore, key);
  return read.status === 'value' ? read.value : null;
}

// The store the hints are read through. A pure suite injects its own: the widget
// store loads the native module lazily, which those suites cannot import.
let storeForTests: GatedReadStore | null = null;

function readStore(): GatedReadStore {
  return storeForTests ?? widgetSecureStore();
}

export function _setScopeStoreForTests(next: GatedReadStore | null): void {
  storeForTests = next;
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
export type ScopeKeychain = GatedReadStore;

/**
 * The signed-in scope as the snapshot fence needs it. Three outcomes, not two:
 * `absent` is a device with no account signed in, `unavailable` is a read that
 * did not complete (a keychain that has not been unlocked since boot, a failed
 * read). Only `known` can confirm that a persisted record belongs to the
 * account holding the device, and an incomplete read is never a mismatch
 * either.
 */
export type SignedInScope =
  | { readonly status: 'known'; readonly userId: string; readonly organizationId: string | null }
  | { readonly status: 'absent' }
  | { readonly status: 'unavailable' };

/**
 * Read both identity hints and report which of the three outcomes they are.
 *
 * The user id decides which: a `null` it cannot vouch for — the keychain is
 * closed, or the read failed — is `unavailable`, never `absent`, so a locked
 * device is not read as a signed-out one. Once it answers with an id, an absent
 * organization id is the personal scope, which the read can then trust because
 * the item that proves the device is readable already answered.
 */
export async function readSignedInScope(keychain: ScopeKeychain): Promise<SignedInScope> {
  const userId = await readGatedValueForUpdate(() => keychain, ACTIVE_USER_ID_KEY);
  if (userId.status === 'unreadable') {
    return { status: 'unavailable' };
  }
  if (userId.value === null) {
    return { status: 'absent' };
  }
  try {
    const organizationId = await keychain.getItemAsync(ORGANIZATION_STORAGE_KEY);
    return { status: 'known', userId: userId.value, organizationId };
  } catch (error) {
    reportSecureStoreFailure('read', error);
    return { status: 'unavailable' };
  }
}
