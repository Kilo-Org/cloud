import { UTS_ACCESS_TOKEN_LIFETIME_SECONDS, audienceOfScope } from './token';

/**
 * The UTS scope registry (design 5.3): every scope a UTS token, a PAT or an org bot key can carry.
 * A scope names one permission on one service, `<audience>:<permission>`. Verifiers read this
 * table to check that a UTS token's scope exists and belongs to their audience (design 7), and UTS
 * checks it before it creates a PAT or an org bot key. `test/repo/scope-registry.test.ts` in
 * `services/uts` checks every entry against the rules below.
 */

/** The audience of the UTS account API and the PAT probe route, both on the issuer origin. */
export const UTS_ACCOUNT_AUDIENCE = 'uts';

/** The marker in `allowedClients` for clients that register by a Client ID Metadata Document. */
export const THIRD_PARTY_CLIENTS = 'third_party';

/**
 * Who can hold a scope: any user; only a member of the organization the token is bound to; or the
 * people on a named staff list (for the development-read and database-lease scopes, the STS person
 * policy, design 4.3).
 */
export type ScopeSubjects =
  | { kind: 'any_user' }
  | { kind: 'org_member' }
  | { kind: 'staff'; list: string };

export type UtsScopeEntry = {
  /** The one service that accepts the scope; always the part of the scope before the colon. */
  audience: string;
  /** Caps the lifetime of an access token for this scope, in seconds. */
  maxLifetimeSeconds: number;
  /** First-party client ids, and `third_party` when any third-party client may ask for it. */
  allowedClients: readonly string[];
  subjects: ScopeSubjects;
  /** Whether a third-party client can request it; true exactly when `allowedClients` says so. */
  thirdPartySafe: boolean;
  /** Whether the mint needs a passkey step-up. */
  stepUp: boolean;
  /** Whether a PAT or an org bot key can carry it. */
  patEligible: boolean;
  /** Whether the mint raises a high-severity audit event. */
  privileged: boolean;
};

/** The scope the account API needs to create, list and revoke the caller's own PATs. */
export const UTS_PATS_MANAGE_SCOPE = 'uts:pats.manage';
/** The scope the account API needs to manage an organization's bot keys. */
export const UTS_BOT_KEYS_MANAGE_SCOPE = 'uts:bot-keys.manage';
/** The scope of the PAT probe route, which answers who a PAT belongs to and nothing else. */
export const UTS_PROBE_READ_SCOPE = 'uts:probe.read';

/** Scopes that change credentials. No PAT or bot key may carry one, so a PAT never makes a PAT. */
export const UTS_CREDENTIAL_SCOPES: readonly string[] = [
  UTS_PATS_MANAGE_SCOPE,
  UTS_BOT_KEYS_MANAGE_SCOPE,
];

const ACCOUNT_API = {
  audience: UTS_ACCOUNT_AUDIENCE,
  maxLifetimeSeconds: UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
  allowedClients: ['kilo-cli'],
  subjects: { kind: 'any_user' },
  thirdPartySafe: false,
  stepUp: false,
  patEligible: false,
  privileged: false,
} as const satisfies UtsScopeEntry;

export const UTS_SCOPE_REGISTRY: Readonly<Record<string, UtsScopeEntry>> = {
  [UTS_PATS_MANAGE_SCOPE]: ACCOUNT_API,
  // The routes check that the caller is an owner or admin of the organization in the path.
  [UTS_BOT_KEYS_MANAGE_SCOPE]: ACCOUNT_API,
  [UTS_PROBE_READ_SCOPE]: { ...ACCOUNT_API, patEligible: true },
};

/** The registry entry of `scope`, or null when the registry does not list it. */
export function utsScopeEntry(scope: string): UtsScopeEntry | null {
  const entry = Object.hasOwn(UTS_SCOPE_REGISTRY, scope) ? UTS_SCOPE_REGISTRY[scope] : undefined;
  return entry !== undefined && entry.audience === audienceOfScope(scope) ? entry : null;
}
