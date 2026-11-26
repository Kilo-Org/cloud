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

/**
 * The pilot pair (decision D6c): usage-ingest's canary calls the web app and the web app calls
 * usage-ingest back, each with a token of the other's canary scope. `canary` holds only the
 * reserved denied probe. The UTS scopes are those UTS and its feed accept from a service: the web
 * app reads the revocation feed and ends or revokes a subject's sessions and credentials;
 * `uts:token-exchange` authenticates kilo-mcp's RFC 8693 exchange. The service-only scopes of
 * phase 4 are the Secure Proxy forward (`STS_SECURE_PROXY_FORWARD`), the usage publish to Usage
 * Ingest (`STS_USAGE_PUBLISH`) and the usage record at the web app (`STS_USAGE_RECORD`). STS mints
 * each one only where a policy grants it (default deny).
 */
export const STS_SCOPE_REGISTRY: StsScopeRegistry = {
  web: { scopes: ['web:sts.canary', STS_USAGE_RECORD.scope] },
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
