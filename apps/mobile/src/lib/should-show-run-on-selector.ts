/**
 * Whether personal-only remote CLI surfaces should show (the new-agent
 * "Run on" selector, and the share gate's connected-CLI spawn rows).
 *
 * Org-scoped flows are Cloud-Agent only by design: a remote `kilo remote`
 * instance spawns a personal CLI session that mobile's data model can only
 * surface on personal routes. Offering a personal-instance picker inside an
 * org flow would create sessions invisible in the org's context, so the
 * affordance is hidden entirely — this is not a feature state, it's an
 * absent-by-design UI branch.
 *
 * Accepts both absent forms so one predicate covers both call sites:
 * - new-session route param: `string | undefined` (`undefined` = personal)
 * - share gate `useOrganization()`: `string | null` (`null` = personal)
 */
export function shouldShowRunOnSelector(organizationId: string | null | undefined): boolean {
  return organizationId == null;
}
