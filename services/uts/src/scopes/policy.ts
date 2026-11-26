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
