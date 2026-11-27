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

async function hasValidAssertion(request: Request, env: AccessGateEnv): Promise<boolean> {
  const audience = env.E2E_ACCESS_AUD ?? '';
  const teamDomain = env.E2E_ACCESS_TEAM_DOMAIN ?? '';
  const clientId = env.E2E_ACCESS_CLIENT_ID ?? '';
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (
    !assertion ||
    !clientId ||
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
    return payload.common_name === clientId;
  } catch {
    return false;
  }
}

/** `null` admits the request; otherwise the refusal to return. */
export async function refuseWithoutAccess(
  request: Request,
  env: AccessGateEnv
): Promise<Response | null> {
  if (env.ENVIRONMENT === 'development') return null;
  if (await hasValidAssertion(request, env)) return null;
  return new Response('Forbidden', { status: 403, headers: { [ACCESS_REFUSAL_HEADER]: 'access' } });
}
