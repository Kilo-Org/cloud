/**
 * Cloudflare Access gate for the deployed e2e Worker. e2e-only: referenced from
 * `src/e2e-entry.ts`, never from production.
 *
 * The Worker's only hostname sits behind an Access application. Access adds a
 * signed `Cf-Access-Jwt-Assertion` to every request it admits; the Worker
 * verifies it against the team's signing keys and the application audience, and
 * requires its `common_name` (the service token's client id) to be the token the
 * Worker holds, so a request that bypassed Access (a `workers.dev` or preview
 * address turned on by hand, a route added outside the renderer) or that another
 * identity got admitted is refused. Without a configured audience, team domain
 * and client id every request is refused. Only the local development config
 * (`ENVIRONMENT=development`) skips the gate; the deployed render never sets it,
 * and the fence checks that.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type AccessGateEnv = {
  ENVIRONMENT?: string;
  E2E_ACCESS_AUD?: string;
  E2E_ACCESS_TEAM_DOMAIN?: string;
  E2E_ACCESS_CLIENT_ID?: string;
};

/** Marks the Worker's own refusal, so a probe can tell it apart from Access's. */
export const ACCESS_REFUSAL_HEADER = 'X-Cloud-Agent-E2E-Refusal';

const AUD_PATTERN = /^[a-f0-9]{64}$/;
const TEAM_DOMAIN_PATTERN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const keySets = new Map<string, JWTVerifyGetKey>();

async function hasValidAssertion(
  request: Request,
  env: AccessGateEnv,
  binding: AccessBinding
): Promise<boolean> {
  const audience = env.E2E_ACCESS_AUD ?? '';
  const teamDomain = env.E2E_ACCESS_TEAM_DOMAIN ?? '';
  const clientId = env.E2E_ACCESS_CLIENT_ID ?? '';
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (
    !assertion ||
    (binding === 'client-id' && !clientId) ||
    !AUD_PATTERN.test(audience) ||
    !TEAM_DOMAIN_PATTERN.test(teamDomain)
  ) {
    return false;
  }
  const issuer = `https://${teamDomain}`;
  let keySet = keySets.get(issuer);
  if (keySet === undefined) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keySet);
  }
  try {
    const { payload } = await jwtVerify(assertion, keySet, {
      issuer,
      audience,
      algorithms: ['RS256'],
    });
    return binding === 'audience' || payload.common_name === clientId;
  } catch {
    return false;
  }
}

/**
 * How the assertion's identity is bound. `client-id`: its `common_name` must be
 * the service token the Worker holds (the e2e Worker). `audience`: the
 * application audience alone (the fake LLM, whose Access application admits
 * only that service token and which holds no Access secret).
 */
export type AccessBinding = 'client-id' | 'audience';

/** `null` admits the request; otherwise the refusal to return. */
export async function refuseWithoutAccess(
  request: Request,
  env: AccessGateEnv,
  binding: AccessBinding = 'client-id'
): Promise<Response | null> {
  if (env.ENVIRONMENT === 'development') return null;
  if (await hasValidAssertion(request, env, binding)) return null;
  return new Response('Forbidden', { status: 403, headers: { [ACCESS_REFUSAL_HEADER]: 'access' } });
}

const ACCESS_HEADERS = [
  'CF-Access-Client-Id',
  'CF-Access-Client-Secret',
  'Cf-Access-Jwt-Assertion',
];

/**
 * The admitted request without the Access service-token headers and assertion,
 * so no handler behind the gate ever sees them. A request that carries none of
 * them is returned unchanged.
 */
export function withoutAccessHeaders(request: Request): Request {
  if (!ACCESS_HEADERS.some(name => request.headers.has(name))) return request;
  const headers = new Headers(request.headers);
  for (const name of ACCESS_HEADERS) headers.delete(name);
  return new Request(request, { headers });
}
