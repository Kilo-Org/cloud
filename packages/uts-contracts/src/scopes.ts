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

/** The audience of the Kilo API, the web app's own routes. The STS service audience is `web`. */
export const KILO_API_AUDIENCE = 'kilo-api';

/** The marker in `allowedClients` for clients that register by a Client ID Metadata Document. */
export const THIRD_PARTY_CLIENTS = 'third_party';

/** The roles of an organization membership (`uts.org_role`). */
export const UTS_ORG_ROLES = ['owner', 'admin', 'member', 'billing_manager'] as const;
export type UtsOrgRole = (typeof UTS_ORG_ROLES)[number];

/**
 * Who can hold a scope: any user; only a member of the organization the token is bound to, in any
 * role or in one of the listed roles at mint; or the people on a named staff list (for the
 * development-read and database-lease scopes, the STS person policy, design 4.3).
 */
export type ScopeSubjects =
  | { kind: 'any_user' }
  | { kind: 'org_member'; roles: 'any' | readonly UtsOrgRole[] }
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
  /**
   * Whether a token for it must name a session-bound grant in `sid`. A PAT or an org bot key never
   * satisfies it, so no scope is both session-bound and PAT-eligible. Verifiers map this through
   * their scope registry port; a route can also require a session itself.
   */
  requiresSession: boolean;
  /**
   * Whether a token for it must carry the `org` claim, the organization the subject acts in; true
   * exactly when the eligible subjects are the members of that organization. Verifiers map this
   * through their scope registry port and compare the claim with the request (design 5.8, 7).
   */
  requiresOrgClaim: boolean;
  /**
   * Whether a delegated token (RFC 8693, with an `act` actor chain, design 5.10) can carry it. A
   * token minted from a grant is never delegated; the sandbox broker's mint names only scopes
   * that allow it.
   */
  delegable: boolean;
  /**
   * How a token for it is minted. `grant`: from an authorization code, a refresh or a device
   * grant. `token_exchange`: only by the RFC 8693 broker exchange at `/token`, as a delegated token
   * whose `act` names the calling workload (design 5.9); `/authorize` and every grant mint refuse
   * such a scope.
   */
  issuance: 'grant' | 'token_exchange';
  /**
   * The `token_exchange` scopes that a token for this scope may be exchanged for. A consent to this
   * scope covers them: the consent row stores only this scope, and the exchange derives the
   * delegation from this field when it runs, so a withdrawn consent ends both.
   */
  delegatesTo: readonly string[];
  /**
   * The one consent line a third-party client's consent screen shows for this scope (design 5.9),
   * exactly when a third-party client can ask for it at `/authorize`; otherwise null. A new line
   * needs a new consent from each client.
   */
  consentText: string | null;
};

/** The web BFF, the CLI and the mobile app; `clients.ts` registers all three. */
const BFF = 'kilo-web';
const CLI = 'kilo-cli';
const MOBILE = 'kilo-mobile';

/** Scopes that hand out a one-shot capability (an export, a disconnect) live 5 minutes. */
const SHORT_LIFETIME_SECONDS = 300;

/** The scope the account API needs to create, list and revoke the caller's own PATs. */
export const UTS_PATS_MANAGE_SCOPE = 'uts:pats.manage';
/** The scope the account API needs to manage an organization's bot keys. */
export const UTS_BOT_KEYS_MANAGE_SCOPE = 'uts:bot-keys.manage';
/** The scope of the PAT probe route, which answers who a PAT belongs to and nothing else. */
export const UTS_PROBE_READ_SCOPE = 'uts:probe.read';
/**
 * Read the caller's own profile, balance and usage on the Kilo API (`GET /api/profile`,
 * `/api/profile/balance`, `/api/profile/usage`, and the `user.getMe` and `user.getBalance` tRPC
 * reads). It does not cover `/api/user`, which stays on the legacy credential.
 */
export const KILO_API_PROFILE_READ_SCOPE = 'kilo-api:profile.read';
/** The user's security view on the web app: sessions, devices, sign-in methods, audit events. */
export const UTS_SECURITY_READ_SCOPE = 'uts:security.read';
/**
 * The web BFF's bootstrap scope at its code exchange: reads the caller's own browser session
 * (status, sign-in time and methods, expiry), with no account change.
 */
export const UTS_BROWSER_SESSION_READ_SCOPE = 'uts:browser-session.read';

/** The audience of Kilo MCP (`services/kilo-mcp`), the resource server of MCP clients. */
export const KILO_MCP_AUDIENCE = 'kilo-mcp';
/** Read the Kilo tool catalog through Kilo MCP; the one scope an MCP client asks for. */
export const KILO_MCP_CATALOG_READ_SCOPE = 'kilo-mcp:catalog.read';
/**
 * The Kilo API reads that Kilo MCP makes for its subject (design 5.9): the tool catalog and the
 * global `models.preferred` and `models.providerNames` queries, with no user, organization, usage
 * or billing data. Minted only by the broker exchange, with `act` naming Kilo MCP.
 */
export const KILO_API_MCP_READ_SCOPE = 'kilo-api:mcp.read';
/** Use the tools of the `pages-dev` deployment, the first-party Pages service. */
export const PAGES_DEV_TOOLS_USE_SCOPE = 'pages-dev:tools.use';
/**
 * The consent line of `kilo-mcp:catalog.read`. It covers exactly what `kilo-api:mcp.read`, the
 * scope it delegates to, reads; a later permission needs a new line and a new consent.
 */
export const KILO_MCP_CATALOG_CONSENT_TEXT =
  "Read your Kilo tool catalog and Kilo's global preferred models and model provider names through Kilo MCP";

/** The audience of the AI gateway (`apps/ai-gateway`), the one gateway user resource. */
export const KILO_GATEWAY_AUDIENCE = 'kilo-gateway';
/**
 * Use the AI gateway as the token's subject: inference and the authenticated model catalog and
 * model validation reads. It adds no organization: the gateway checks the organization a request
 * names against the subject's membership itself, and no actor (`act`) or legacy org-model
 * expansion is carried.
 */
export const KILO_GATEWAY_INFERENCE_SCOPE = 'kilo-gateway:inference';

/** Scopes that change credentials. No PAT or bot key may carry one, so a PAT never makes a PAT. */
export const UTS_CREDENTIAL_SCOPES: readonly string[] = [
  UTS_PATS_MANAGE_SCOPE,
  UTS_BOT_KEYS_MANAGE_SCOPE,
];

/** The account API acts on the caller's session: every action reads the grant its `sid` names. */
const ACCOUNT_API = {
  audience: UTS_ACCOUNT_AUDIENCE,
  maxLifetimeSeconds: UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
  allowedClients: [CLI],
  subjects: { kind: 'any_user' },
  thirdPartySafe: false,
  stepUp: false,
  patEligible: false,
  privileged: false,
  requiresSession: true,
  requiresOrgClaim: false,
  delegable: false,
  issuance: 'grant',
  delegatesTo: [],
  consentText: null,
} as const satisfies UtsScopeEntry;

/**
 * A first-party scope of a Kilo service that no PAT carries and no delegated token carries: any
 * user unless `orgRoles` limits it to the members of the bound organization, no step-up, not
 * privileged, 10 minutes unless `lifetimeSeconds` says less.
 */
function firstPartyScope(
  audience: string,
  allowedClients: readonly string[],
  options: {
    requiresSession: boolean;
    lifetimeSeconds?: number;
    orgRoles?: 'any' | readonly UtsOrgRole[];
  }
): UtsScopeEntry {
  return {
    audience,
    maxLifetimeSeconds: options.lifetimeSeconds ?? UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
    allowedClients,
    subjects:
      options.orgRoles === undefined
        ? { kind: 'any_user' }
        : { kind: 'org_member', roles: options.orgRoles },
    thirdPartySafe: false,
    stepUp: false,
    patEligible: false,
    privileged: false,
    requiresSession: options.requiresSession,
    requiresOrgClaim: options.orgRoles !== undefined,
    delegable: false,
    issuance: 'grant',
    delegatesTo: [],
    consentText: null,
  };
}

export const UTS_SCOPE_REGISTRY: Readonly<Record<string, UtsScopeEntry>> = {
  [UTS_PATS_MANAGE_SCOPE]: ACCOUNT_API,
  // The routes check that the caller is an owner or admin of the organization in the path.
  [UTS_BOT_KEYS_MANAGE_SCOPE]: ACCOUNT_API,
  [UTS_PROBE_READ_SCOPE]: { ...ACCOUNT_API, patEligible: true, requiresSession: false },
  [UTS_SECURITY_READ_SCOPE]: firstPartyScope(UTS_ACCOUNT_AUDIENCE, [BFF], {
    requiresSession: true,
  }),
  [UTS_BROWSER_SESSION_READ_SCOPE]: firstPartyScope(UTS_ACCOUNT_AUDIENCE, [BFF], {
    requiresSession: true,
  }),
  [KILO_API_PROFILE_READ_SCOPE]: {
    audience: KILO_API_AUDIENCE,
    maxLifetimeSeconds: UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
    allowedClients: [CLI],
    subjects: { kind: 'any_user' },
    thirdPartySafe: false,
    stepUp: false,
    patEligible: true,
    privileged: false,
    requiresSession: false,
    requiresOrgClaim: false,
    delegable: false,
    issuance: 'grant',
    delegatesTo: [],
    consentText: null,
  },
  // The CLI's Kilo API routes (phase 4 caller map). Each route keeps its own authorization and
  // resource checks; there is no generic write scope.
  'kilo-api:notifications.read': firstPartyScope(KILO_API_AUDIENCE, [CLI], {
    requiresSession: false,
  }),
  'kilo-api:organizations.read': firstPartyScope(KILO_API_AUDIENCE, [CLI], {
    requiresSession: false,
  }),
  'kilo-api:auto-routing.read': firstPartyScope(KILO_API_AUDIENCE, [CLI], {
    requiresSession: false,
  }),
  'kilo-api:organizations.write': firstPartyScope(KILO_API_AUDIENCE, [CLI], {
    requiresSession: true,
    orgRoles: 'any',
  }),
  'kilo-api:auto-routing.write': firstPartyScope(KILO_API_AUDIENCE, [CLI], {
    requiresSession: true,
  }),
  'kilo-api:sessions.write': firstPartyScope(KILO_API_AUDIENCE, [CLI], { requiresSession: true }),
  'kilo-api:shell-security.analyze': firstPartyScope(KILO_API_AUDIENCE, [CLI], {
    requiresSession: true,
  }),
  'kilo-api:feedback.write': firstPartyScope(KILO_API_AUDIENCE, [CLI], { requiresSession: true }),
  'kilo-api:credits.redeem': firstPartyScope(KILO_API_AUDIENCE, [CLI], { requiresSession: true }),
  // Phase 4 Batch B (2026-11-26): the caller's own sessions in session ingest. Each token comes
  // from a CLI or web grant, so it names its session in `sid`.
  'session-ingest:sessions.read': firstPartyScope('session-ingest', [CLI, BFF], {
    requiresSession: true,
  }),
  'session-ingest:sessions.write': firstPartyScope('session-ingest', [CLI, BFF], {
    requiresSession: true,
  }),
  'session-ingest:live.connect': firstPartyScope('session-ingest', [CLI, BFF], {
    requiresSession: true,
  }),
  'session-ingest:sessions.share': firstPartyScope('session-ingest', [BFF], {
    requiresSession: true,
  }),
  'cloud-agent-next:sessions.read': firstPartyScope('cloud-agent-next', [BFF], {
    requiresSession: true,
  }),
  'user-data-export:exports.dispatch': firstPartyScope('user-data-export', [BFF], {
    requiresSession: true,
    lifetimeSeconds: SHORT_LIFETIME_SECONDS,
  }),
  'user-data-export:exports.download': firstPartyScope('user-data-export', [BFF], {
    requiresSession: true,
    lifetimeSeconds: SHORT_LIFETIME_SECONDS,
  }),
  'git-token-service:github-user-authorizations.disconnect': firstPartyScope(
    'git-token-service',
    [BFF],
    { requiresSession: true, lifetimeSeconds: SHORT_LIFETIME_SECONDS }
  ),
  'git-token-service:bitbucket.repositories.read': firstPartyScope('git-token-service', [BFF], {
    requiresSession: true,
    orgRoles: 'any',
  }),
  // Phase 4 Batch A (2026-11-26). The attribution Worker rechecks the exact role itself.
  'ai-attribution:identity.read': firstPartyScope('ai-attribution', [CLI], {
    requiresSession: true,
    orgRoles: ['owner', 'member'],
  }),
  'ai-attribution:attributions.write': firstPartyScope('ai-attribution', [CLI], {
    requiresSession: true,
    orgRoles: ['owner', 'member'],
  }),
  'session-sync:grants.exchange': firstPartyScope('session-sync', [CLI, MOBILE], {
    requiresSession: true,
  }),
  'notifications:badges.read': firstPartyScope('notifications', [MOBILE], {
    requiresSession: true,
  }),
  'notifications:badges.write': firstPartyScope('notifications', [MOBILE], {
    requiresSession: true,
  }),
  'event-service:events.subscribe': firstPartyScope('event-service', [BFF, MOBILE, CLI], {
    requiresSession: true,
  }),
  // One chat credential serves the client's reads and writes.
  'kilo-chat:chat.use': firstPartyScope('kilo-chat', [BFF], { requiresSession: true }),
  // Pages (design 5.9): the `pages-dev` deployment's tools, for the web app's Pages exchange only.
  [PAGES_DEV_TOOLS_USE_SCOPE]: firstPartyScope('pages-dev', [BFF], {
    requiresSession: true,
    lifetimeSeconds: SHORT_LIFETIME_SECONDS,
  }),
  // The AI gateway. The CLI (which the IDE extensions run) calls it for inference; the mobile app
  // reads its model catalog with the user's bearer. The web app reaches the gateway only through
  // its rewrites, where the gateway ignores the browser session, so `kilo-web` is not listed. A
  // PAT and an org bot key may carry it: they replace the long-lived API key that the gateway's
  // OpenAI-compatible API takes today (decision Q4).
  [KILO_GATEWAY_INFERENCE_SCOPE]: {
    audience: KILO_GATEWAY_AUDIENCE,
    maxLifetimeSeconds: UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
    allowedClients: [CLI, MOBILE],
    subjects: { kind: 'any_user' },
    thirdPartySafe: false,
    stepUp: false,
    patEligible: true,
    privileged: false,
    requiresSession: false,
    requiresOrgClaim: false,
    delegable: false,
    issuance: 'grant',
    delegatesTo: [],
    consentText: null,
  },
  // Kilo MCP (design 5.9). A third-party grant names its consent family in `sid`, not a session.
  [KILO_MCP_CATALOG_READ_SCOPE]: {
    audience: KILO_MCP_AUDIENCE,
    maxLifetimeSeconds: UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
    allowedClients: [THIRD_PARTY_CLIENTS, CLI],
    subjects: { kind: 'any_user' },
    thirdPartySafe: true,
    stepUp: false,
    patEligible: false,
    privileged: false,
    requiresSession: false,
    requiresOrgClaim: false,
    delegable: false,
    issuance: 'grant',
    delegatesTo: [KILO_API_MCP_READ_SCOPE],
    consentText: KILO_MCP_CATALOG_CONSENT_TEXT,
  },
  // Only the broker exchange mints it, from a `kilo-mcp:catalog.read` token of the same client.
  [KILO_API_MCP_READ_SCOPE]: {
    audience: KILO_API_AUDIENCE,
    maxLifetimeSeconds: SHORT_LIFETIME_SECONDS,
    allowedClients: [THIRD_PARTY_CLIENTS, CLI],
    subjects: { kind: 'any_user' },
    thirdPartySafe: true,
    stepUp: false,
    patEligible: false,
    privileged: false,
    requiresSession: false,
    requiresOrgClaim: false,
    delegable: true,
    issuance: 'token_exchange',
    delegatesTo: [],
    consentText: null,
  },
};

/** The registry entry of `scope`, or null when the registry does not list it. */
export function utsScopeEntry(scope: string): UtsScopeEntry | null {
  const entry = Object.hasOwn(UTS_SCOPE_REGISTRY, scope) ? UTS_SCOPE_REGISTRY[scope] : undefined;
  return entry !== undefined && entry.audience === audienceOfScope(scope) ? entry : null;
}
