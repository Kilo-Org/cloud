import * as SecureStore from 'expo-secure-store';

import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';

/**
 * Scope reads shared by the push handler (`@/lib/notifications`) and the
 * glanceable front-approval orchestrator: the selected organization id and the
 * active-user id, both from SecureStore.
 *
 * They live here rather than beside either call site so both paths resolve the
 * same scope the glanceable snapshot is fenced on; a copy per caller would let
 * the approving surface and the sink disagree about which account is current.
 */

/**
 * Read the selected organization id for scope validation and token registration.
 * A missing hint only matches a personal scope; it cannot revive an org scope.
 */
export async function getSelectedOrganizationId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Read the active-user id for scope validation and logout reconciliation.
 * An unavailable hint drops the push rather than reviving a persisted scope.
 * The raw id never enters the snapshot.
 */
export async function getActiveUserId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ACTIVE_USER_ID_KEY);
  } catch {
    return null;
  }
}
