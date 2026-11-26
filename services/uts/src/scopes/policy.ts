import { utsScopeEntry } from '@kilocode/uts-contracts';

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
 * The first of `scopes` whose registry entry needs the `org` claim (`requiresOrgClaim`) when no
 * organization is bound (`orgId` null), or null when every scope can be minted. The authorization
 * endpoint refuses such a request, and the mint refuses to sign such a token, so a token for an
 * organization-member scope always names its organization. The membership role a scope lists
 * (`subjects.roles`) is not checked here: the mint statements do not read the role.
 */
export function scopeMissingOrg(scopes: readonly string[], orgId: string | null): string | null {
  if (orgId !== null) return null;
  return scopes.find(scope => utsScopeEntry(scope)?.requiresOrgClaim === true) ?? null;
}
