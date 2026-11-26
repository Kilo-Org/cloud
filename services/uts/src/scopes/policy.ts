import { type UtsOrgRole, utsScopeEntry } from '@kilocode/uts-contracts';

/**
 * What the scope registry (`UTS_SCOPE_REGISTRY` in `@kilocode/uts-contracts`, design 5.3) allows
 * for a long-lived credential: a PAT or an org bot key carries one registered, PAT-eligible scope.
 * A scope that only members of one organization can hold needs the credential bound to an
 * organization. `test/repo/scope-registry.test.ts` keeps staff, step-up and privileged scopes out
 * of PATs, so no such scope reaches this check as eligible.
 */
export type CredentialScopeCheck =
  | { status: 'allowed' }
  | { status: 'unknown_scope' }
  | { status: 'not_pat_eligible' }
  | { status: 'org_required' };

export function credentialScopeCheck(scope: string, orgId: string | null): CredentialScopeCheck {
  const entry = utsScopeEntry(scope);
  if (entry === null) return { status: 'unknown_scope' };
  if (!entry.patEligible) return { status: 'not_pat_eligible' };
  if (entry.subjects.kind === 'org_member' && orgId === null) return { status: 'org_required' };
  return { status: 'allowed' };
}

/**
 * The first of `scopes` that cannot be minted for the bound organization, or null when every scope
 * can: a scope whose registry entry needs the `org` claim (`requiresOrgClaim`) when no organization
 * is bound (`orgId` null), or a scope limited to listed membership roles (`subjects.roles`) when
 * the subject's role in that organization (`orgRole`, read by the mint statement) is not one of
 * them. The authorization endpoint answers `invalid_scope` and the token endpoint `invalid_grant`,
 * and neither signs, so a token for an organization scope always names an organization in which
 * its subject holds an allowed role.
 */
export function orgScopeRefusal(
  scopes: readonly string[],
  orgId: string | null,
  orgRole: UtsOrgRole | null
): string | null {
  for (const scope of scopes) {
    const entry = utsScopeEntry(scope);
    if (entry === null) continue;
    if (entry.requiresOrgClaim && orgId === null) return scope;
    const { subjects } = entry;
    if (
      subjects.kind === 'org_member' &&
      subjects.roles !== 'any' &&
      (orgRole === null || !subjects.roles.includes(orgRole))
    ) {
      return scope;
    }
  }
  return null;
}
