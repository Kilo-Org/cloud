/**
 * How a route hands the trigger scope to a screen.
 *
 * One query parameter decides every trigger call: no `org` is the caller's own
 * triggers, and an organization id switches the list, the detail and every
 * write to that organization's. The spend alerts screens read the same
 * parameter, so a link between them keeps its scope.
 */

/** The `org` parameter a trigger route was opened with, or `undefined` for personal. */
export function triggerScopeFromParam(org: string | string[] | undefined): string | undefined {
  if (org === undefined) {
    return undefined;
  }
  const value = Array.isArray(org) ? org[0] : org;
  return value === undefined || value.length === 0 ? undefined : value;
}

/** The `?org=` fragment an href appends for a scope, empty for the personal one. */
export function triggerScopeQuery(organizationId: string | undefined): string {
  return organizationId === undefined ? '' : `?org=${encodeURIComponent(organizationId)}`;
}
