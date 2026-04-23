import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { KiloOpsEnv } from './worker';

/**
 * Cloudflare Access JWT validation middleware using the jose library.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 *
 * jose handles signature verification, key rotation (via JWKS endpoint),
 * expiry, nbf, issuer, and audience checks.
 */

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export function withCloudflareAccess({
  team,
  audience,
}: {
  team: string;
  audience: string;
}): MiddlewareHandler<KiloOpsEnv> {
  if (!/^[a-z0-9-]+$/.test(team)) {
    throw new Error(`Invalid CF Access team name: ${team}`);
  }
  if (!/^[a-f0-9]{64}$/.test(audience)) {
    throw new Error(`Invalid CF Access audience tag: ${audience}`);
  }

  const teamDomain = `https://${team}.cloudflareaccess.com`;

  return async (c, next) => {
    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    try {
      const { payload } = await jwtVerify(token, getJWKS(teamDomain), {
        issuer: teamDomain,
        audience,
      });

      // User tokens carry 'email', service tokens carry 'common_name'. Reject
      // any token that lacks both — falling back to a shared identity would
      // grant that token Grafana's auto-signup Admin role.
      const email = typeof payload.email === 'string' ? payload.email : null;
      const commonName = typeof payload.common_name === 'string' ? payload.common_name : null;
      const identity = email?.trim() || commonName?.trim();
      if (!identity) {
        console.warn('CF Access JWT validated but contains no email or common_name');
        return c.json({ error: 'Unauthorized' }, 401);
      }
      c.set('userIdentity', identity);
    } catch (e) {
      console.warn(
        `CF Access JWT validation failed: ${e instanceof Error ? e.message : 'unknown'}`
      );
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  };
}
