import { type UtsScopeEntry, utsScopeEntry } from '@kilocode/uts-contracts';
import type { ScopeRegistry } from './policy';

/**
 * Fixture scopes for the local end-to-end runs (`scripts/oauth-e2e.ts`): the third-party steps of
 * that run use a scope of their own audience, so they depend on no product scope. Only the
 * development entry (`src/dev.ts`, served by `src/dev-index.ts` under `wrangler dev -c
 * wrangler.dev.jsonc`) adds them on top of the registry. `test/repo` checks that no module the
 * deployed entry (`src/index.ts`) imports reaches this one, that every fixture scope is named
 * `fixture:*` and follows the registry's rules, and that `UTS_SCOPE_REGISTRY` holds no
 * `fixture:*` scope.
 */
export const DEVELOPMENT_FIXTURE_SCOPES: Readonly<Record<string, UtsScopeEntry>> = {
  'fixture:read': {
    audience: 'fixture',
    maxLifetimeSeconds: 600,
    allowedClients: ['third_party'],
    subjects: { kind: 'any_user' },
    thirdPartySafe: true,
    stepUp: false,
    patEligible: false,
    privileged: false,
    requiresSession: false,
    requiresOrgClaim: false,
    delegable: false,
    issuance: 'grant',
    delegatesTo: [],
    consentText: 'Read the local test fixture',
  },
};

/** The scope registry plus the development fixture scopes. */
export const developmentScopes: ScopeRegistry = scope =>
  utsScopeEntry(scope) ??
  (Object.hasOwn(DEVELOPMENT_FIXTURE_SCOPES, scope)
    ? (DEVELOPMENT_FIXTURE_SCOPES[scope] ?? null)
    : null);
