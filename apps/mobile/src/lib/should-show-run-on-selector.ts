/**
 * Whether the new-agent screen should show the "Run on" instance selector.
 *
 * Org-scoped flows (where the route param `organizationId` is present) are
 * Cloud-Agent only by design: a remote `kilo remote` instance spawns a
 * personal CLI session that mobile's data model can only surface on
 * personal routes. Offering a personal-instance picker inside an org flow
 * would create sessions invisible in the org's context, so the row is
 * hidden entirely — this is not a feature state, it's an absent-by-design
 * UI branch.
 */
export function shouldShowRunOnSelector(organizationId: string | undefined): boolean {
  return organizationId === undefined;
}
