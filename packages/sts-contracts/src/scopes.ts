import { AudienceSchema, ScopeSchema, scopeAudience } from './token';

/**
 * STS service-token scopes by audience (design 5.3 scope model, 6.3 default deny). STS mints, and
 * a verifier accepts, an STS token only for a scope listed under its own audience here.
 */
export type StsScopeRegistry = Readonly<Record<string, { readonly scopes: readonly string[] }>>;

/**
 * The pilot pair (decision D6c): usage-ingest's canary calls the web app and the web app calls
 * usage-ingest back, each with a token of the other's canary scope. The UTS scopes are those UTS
 * and its feed accept from a service: the web app reads the revocation feed and ends or revokes a
 * subject's sessions and credentials; `uts:token-exchange` authenticates kilo-mcp's RFC 8693
 * exchange. STS mints each one only where a policy grants it (default deny).
 */
export const STS_SCOPE_REGISTRY: StsScopeRegistry = {
  web: { scopes: ['web:sts.canary'] },
  'usage-ingest': { scopes: ['usage-ingest:sts.canary'] },
  'uts-feed': { scopes: ['uts-feed:revocation.read'] },
  uts: {
    scopes: [
      'uts:subjects.revoke',
      'uts:browser-sessions.end',
      'uts:api-credentials.revoke',
      'uts:token-exchange',
    ],
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
