/**
 * Pure reconcile for organization deep-links (e.g. low-balance push →
 * credit-activity with `?org=`). When an explicit org param is present it is
 * the only source of the effective organization for that visit — the
 * pre-tap context selection must not key data queries or be shown.
 */
export function reconcileOrgDeepLink<T extends { organizationId: string }>(args: {
  orgParam: string | undefined;
  contextOrganizationId: string | null;
  /** `undefined` while the organizations.list query is still unsettled. */
  orgs: readonly T[] | undefined;
}): {
  effectiveOrganizationId: string | null;
  validatedOrg: T | undefined;
  /** Key for data queries; `null` disables them. */
  queryOrganizationId: string | null;
  /** Param present and resolves to a membership — caller should persist. */
  shouldPersistOverride: boolean;
  /** Param present and the org list has not settled yet. */
  isResolving: boolean;
} {
  const { orgParam, contextOrganizationId, orgs } = args;

  if (orgParam == null || orgParam === '') {
    return {
      effectiveOrganizationId: contextOrganizationId,
      validatedOrg: undefined,
      queryOrganizationId: contextOrganizationId,
      shouldPersistOverride: false,
      isResolving: false,
    };
  }

  if (orgs === undefined) {
    return {
      effectiveOrganizationId: orgParam,
      validatedOrg: undefined,
      queryOrganizationId: null,
      shouldPersistOverride: false,
      isResolving: true,
    };
  }

  const validatedOrg = orgs.find(entry => entry.organizationId === orgParam);
  if (validatedOrg != null) {
    return {
      effectiveOrganizationId: orgParam,
      validatedOrg,
      queryOrganizationId: orgParam,
      shouldPersistOverride: true,
      isResolving: false,
    };
  }

  return {
    effectiveOrganizationId: orgParam,
    validatedOrg: undefined,
    queryOrganizationId: null,
    shouldPersistOverride: false,
    isResolving: false,
  };
}
