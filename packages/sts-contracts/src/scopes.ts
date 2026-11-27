import { AudienceSchema, ScopeSchema, scopeAudience } from './token';

/**
 * STS service-token scopes by audience (design 5.3 scope model, 6.3 default deny). STS mints, and
 * a verifier accepts, an STS token only for a scope listed under its own audience here.
 */
export type StsScopeRegistry = Readonly<Record<string, { readonly scopes: readonly string[] }>>;

/**
 * The STS canary's denied probe: a scope no policy can ever grant. The web app's canary route asks
 * STS for it every run; STS identifies the function and refuses the token by policy, which it
 * records as an `ai.kilo.sts.token.denied` row (services/usage-ingest README, "STS canary").
 */
export const STS_DENIED_PROBE = { audience: 'canary', scope: 'canary:denied-probe' } as const;

/**
 * Registered scopes no policy may grant: the STS policy loader refuses a policy that lists one,
 * or lists its audience. Being registered, a request for one passes the registry check and is
 * refused as an audience no policy lists (`audience_not_allowed`), never as `unknown_scope`.
 */
export const STS_RESERVED_SCOPES: readonly string[] = [STS_DENIED_PROBE.scope];

/**
 * The AI Gateway forwards a provider request to the AI Gateway Secure Proxy. Only the `ai-gateway`
 * workload may send it; the Secure Proxy accepts it only from that service caller.
 */
export const STS_SECURE_PROXY_FORWARD = {
  audience: 'ai-gateway-secure-proxy',
  scope: 'ai-gateway-secure-proxy:request.forward',
} as const;

/** A publisher (the AI Gateway or the web app) sends usage to Usage Ingest's publisher routes. */
export const STS_USAGE_PUBLISH = {
  audience: 'usage-ingest',
  scope: 'usage-ingest:usage.publish',
} as const;

/** Usage Ingest's queue consumer records usage at the web app's private record routes. */
export const STS_USAGE_RECORD = { audience: 'web', scope: 'web:usage.record' } as const;

/** The AI Gateway and the web app write API metrics to O11y's ingestion endpoint. */
export const STS_O11Y_API_METRICS_WRITE = {
  audience: 'o11y',
  scope: 'o11y:api-metrics.write',
} as const;

/** The web app's admin alerts router reads O11y's alerting configuration and baselines. */
export const STS_O11Y_ALERTING_READ = { audience: 'o11y', scope: 'o11y:alerting.read' } as const;

/** The web app's admin alerts router changes O11y's alerting configuration and baselines. */
export const STS_O11Y_ALERTING_WRITE = { audience: 'o11y', scope: 'o11y:alerting.write' } as const;

/** The web app asks Security Sync to enqueue a manual sync. Only the `web` workload may send it. */
export const STS_SECURITY_SYNC_MANUAL_SYNC = {
  audience: 'security-sync',
  scope: 'security-sync:manual-sync.enqueue',
} as const;

/** The web app asks Security Sync to enqueue a finding dismissal. Only the `web` workload may send it. */
export const STS_SECURITY_SYNC_DISMISS_FINDING = {
  audience: 'security-sync',
  scope: 'security-sync:dismiss-finding.enqueue',
} as const;

/**
 * Security Sync asks the web app to dispatch security notifications. Only the Security Sync
 * Worker's workload may send it.
 */
export const STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH = {
  audience: 'web',
  scope: 'web:security-notifications.dispatch',
} as const;

/**
 * A GitHub Actions job asks the web app to mint the one-hour catalog API token
 * (`POST /api/internal/mcp-catalog/token`): the MCP catalog dump and the kilo-app changelog jobs.
 */
export const STS_WEB_MCP_CATALOG_TOKEN_MINT = {
  audience: 'web',
  scope: 'web:mcp-catalog-token.mint',
} as const;

/**
 * Kilo-Org/kilocode's watch-opencode-releases job asks the community contributions dashboard to
 * sync a new upstream opencode release (`POST /api/opencode/sync`).
 */
export const STS_COMMUNITY_CONTRIBUTIONS_DASHBOARD_OPENCODE_SYNC = {
  audience: 'community-contributions-dashboard',
  scope: 'community-contributions-dashboard:opencode.sync',
} as const;

/**
 * The pilot pair (decision D6c): usage-ingest's canary calls the web app and the web app calls
 * usage-ingest back, each with a token of the other's canary scope. `canary` holds only the
 * reserved denied probe. The UTS scopes are those UTS and its feed accept from a service: the web
 * app reads the revocation feed and ends or revokes a subject's sessions and credentials;
 * `uts:token-exchange` authenticates kilo-mcp's RFC 8693 exchange. The service-only scopes of
 * phase 4 are the Secure Proxy forward (`STS_SECURE_PROXY_FORWARD`), the usage publish to Usage
 * Ingest (`STS_USAGE_PUBLISH`), the usage record at the web app (`STS_USAGE_RECORD`), O11y's
 * API-metrics write and alerting read and write (`STS_O11Y_*`), Security Sync's manual sync and
 * finding dismissal (`STS_SECURITY_SYNC_*`), and the web app's security notification dispatch
 * (`STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH`). The CI scopes are the web app's catalog token mint
 * (`STS_WEB_MCP_CATALOG_TOKEN_MINT`) and the community contributions dashboard's opencode sync
 * (`STS_COMMUNITY_CONTRIBUTIONS_DASHBOARD_OPENCODE_SYNC`). STS mints each one only where a policy
 * grants it (default deny).
 */
export const STS_SCOPE_REGISTRY: StsScopeRegistry = {
  web: {
    scopes: [
      'web:sts.canary',
      STS_USAGE_RECORD.scope,
      STS_WEB_SECURITY_NOTIFICATIONS_DISPATCH.scope,
      STS_WEB_MCP_CATALOG_TOKEN_MINT.scope,
    ],
  },
  'usage-ingest': { scopes: ['usage-ingest:sts.canary', STS_USAGE_PUBLISH.scope] },
  [STS_DENIED_PROBE.audience]: { scopes: [STS_DENIED_PROBE.scope] },
  'uts-feed': { scopes: ['uts-feed:revocation.read'] },
  uts: {
    scopes: [
      'uts:subjects.revoke',
      'uts:browser-sessions.end',
      'uts:api-credentials.revoke',
      'uts:token-exchange',
    ],
  },
  [STS_SECURE_PROXY_FORWARD.audience]: { scopes: [STS_SECURE_PROXY_FORWARD.scope] },
  o11y: {
    scopes: [
      STS_O11Y_API_METRICS_WRITE.scope,
      STS_O11Y_ALERTING_READ.scope,
      STS_O11Y_ALERTING_WRITE.scope,
    ],
  },
  'security-sync': {
    scopes: [STS_SECURITY_SYNC_MANUAL_SYNC.scope, STS_SECURITY_SYNC_DISMISS_FINDING.scope],
  },
  [STS_COMMUNITY_CONTRIBUTIONS_DASHBOARD_OPENCODE_SYNC.audience]: {
    scopes: [STS_COMMUNITY_CONTRIBUTIONS_DASHBOARD_OPENCODE_SYNC.scope],
  },
};

/** Whether `scope` is registered under `audience`. Inherited object keys never match. */
export function isRegisteredStsScope(
  audience: string,
  scope: string,
  registry: StsScopeRegistry = STS_SCOPE_REGISTRY
): boolean {
  if (!Object.hasOwn(registry, audience)) return false;
  return registry[audience]?.scopes.includes(scope) ?? false;
}

/** Every rule a registry breaks: an invalid audience or scope, a scope under another audience, a duplicate. */
export function stsScopeRegistryProblems(registry: StsScopeRegistry): string[] {
  const problems: string[] = [];
  for (const [audience, entry] of Object.entries(registry)) {
    if (!AudienceSchema.safeParse(audience).success) {
      problems.push(`audience ${JSON.stringify(audience)} is not a valid audience`);
    }
    const seen = new Set<string>();
    for (const scope of entry.scopes) {
      if (!ScopeSchema.safeParse(scope).success) {
        problems.push(`${audience}: scope ${JSON.stringify(scope)} is not a valid scope`);
      } else if (scopeAudience(scope) !== audience) {
        problems.push(`${audience}: scope ${scope} belongs to audience ${scopeAudience(scope)}`);
      }
      if (seen.has(scope)) problems.push(`${audience}: scope ${scope} is listed twice`);
      seen.add(scope);
    }
  }
  return problems;
}
