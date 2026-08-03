/**
 * Whether the "Run on" selector (new-agent screen) and the share gate's
 * connected-CLI instances query should show.
 *
 * Org contexts support CLI instances: org attribution travels with the
 * create (`orgId` on `create_session`), so a remote spawn from an org
 * flow is owner-scoped and visible on that org's routes. Personal and
 * org flows both show the selector.
 *
 * Accepts both absent forms so one predicate covers both call sites:
 * - new-session route param: `string | undefined` (`undefined` = personal)
 * - share gate `useOrganization()`: `string | null` (`null` = personal)
 *
 * The `organizationId` argument is retained for call-site compatibility;
 * it no longer gates visibility.
 */
export function shouldShowRunOnSelector(_organizationId: string | null | undefined): boolean {
  return true;
}
