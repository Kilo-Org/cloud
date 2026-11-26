import {
  THIRD_PARTY_CLIENTS,
  type UtsOrgRole,
  type UtsScopeEntry,
  utsScopeEntry,
} from '@kilocode/uts-contracts';

/**
 * Looks a scope up in the scope registry. The OAuth endpoints take it as a dependency: the
 * deployed Worker passes `utsScopeEntry` (`UTS_SCOPE_REGISTRY`); the runtime tests add fixture
 * scopes for their own flows.
 */
export type ScopeRegistry = (scope: string) => UtsScopeEntry | null;

/** The client of an OAuth request, as the registry's `allowedClients` names it. */
export type MintClient = {
  kind: 'first_party' | 'confidential_web' | 'third_party';
  clientId: string;
};

/**
 * The first of `scopes` that `client` may not hold, or null when it may hold every one (design
 * 5.3, 5.9): a scope the registry does not list; for a first-party client, a scope whose
 * `allowedClients` does not name it; for a third-party client, a scope that is not third-party-safe
 * or does not allow `third_party`. The authorization endpoint answers `invalid_scope` before the
 * hand-off, so a code or grant only ever holds scopes its client may hold; the token endpoint
 * checks the requested scopes before its statement and the minted scopes before signing.
 */
export function clientScopeRefusal(
  scopes: readonly string[],
  client: MintClient,
  registry: ScopeRegistry
): string | null {
  for (const scope of scopes) {
    const entry = registry(scope);
    if (entry === null) return scope;
    const allowed =
      client.kind === 'third_party'
        ? entry.thirdPartySafe && entry.allowedClients.includes(THIRD_PARTY_CLIENTS)
        : entry.allowedClients.includes(client.clientId);
    if (!allowed) return scope;
  }
  return null;
}

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
 * them. The statements of migration 0005 refuse a role outside the list themselves, before they
 * write anything (`uts.scope_org_roles` mirrors the registry); the authorization endpoint checks
 * the organization before it stores a code, and the token endpoint checks both again before it
 * signs, so a token for an organization scope always names an organization in which its subject
 * holds an allowed role.
 */
export function orgScopeRefusal(
  scopes: readonly string[],
  orgId: string | null,
  orgRole: UtsOrgRole | null,
  registry: ScopeRegistry
): string | null {
  for (const scope of scopes) {
    const entry = registry(scope);
    if (entry === null) return scope;
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
