import { useEffect, useRef } from 'react';

import { type OrgDeepLinkResolution, reconcileOrgDeepLink } from '@/lib/org-deep-link';
import { useOrganization } from '@/lib/organization-context';

/**
 * Reconcile an organization route's `?org=` scope against the membership list
 * and write the validated organization as the selection.
 *
 * A route that names its own organization (the deep-linked hub, credit activity,
 * usage, the integrations screen) is a scope the reader asked for, so it selects
 * that organization itself instead of reading the persisted one. A param that
 * resolves to no membership writes nothing and leaves the screen on its denied
 * or failed state; a route without a param never touches the selection.
 */
export function useOrgDeepLinkSelection<T extends { organizationId: string }>({
  orgParam,
  contextOrganizationId,
  orgs,
  isOrgListLoading,
}: Readonly<{
  /** Normalized `?org=` value; absent leaves the persisted selection alone. */
  orgParam: string | undefined;
  contextOrganizationId: string | null;
  /** The membership list; `undefined` while it has not loaded. */
  orgs: readonly T[] | undefined;
  /** Whether that list has not settled yet. */
  isOrgListLoading: boolean;
}>): OrgDeepLinkResolution<T> {
  const { isLoaded, setOrganizationId } = useOrganization();

  // While the list is loading, pass `undefined` so reconcile marks `isResolving`.
  // Once settled (success or error), pass the array (or empty) so a foreign param
  // cannot fall through to the context organization's data.
  const reconcile = reconcileOrgDeepLink({
    orgParam,
    contextOrganizationId,
    orgs: isOrgListLoading ? undefined : (orgs ?? []),
  });

  // The linked organization becomes the selection once per mounted screen, the
  // same way the organization hub applies a deep-linked id. The selection's
  // writer is memoized on the current selection, so an effect keyed on it would
  // otherwise re-write the param after the reader switches accounts on another
  // screen, silently reverting that switch.
  const appliedOverrideRef = useRef<string | null>(null);
  useEffect(() => {
    // Wait for SecureStore hydration so the deep-link selection always wins over stored org.
    const target = reconcile.shouldPersistOverride ? reconcile.effectiveOrganizationId : null;
    if (!isLoaded || target == null || appliedOverrideRef.current === target) {
      return;
    }
    appliedOverrideRef.current = target;
    setOrganizationId(target);
  }, [
    isLoaded,
    reconcile.shouldPersistOverride,
    reconcile.effectiveOrganizationId,
    setOrganizationId,
  ]);

  return reconcile;
}
