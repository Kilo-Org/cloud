import { createMiddleware } from 'hono/factory';
import { seconds } from 'itty-time';
import { z } from 'zod';
import type { GastownEnv } from '../gastown.worker';

export function withCloudflareAccess({
  team,
  audience,
}: {
  team: AccessTeam;
  audience: AccessAudience;
}) {
  const accessTeamDomain = AccessTeamDomain.parse(
    `https://${AccessTeam.parse(team)}.cloudflareaccess.com`
  );
  const accessAud = AccessAudience.parse(audience);

  return createMiddleware<GastownEnv>(async (c, next) => {
    if (!hasValidJWT(c.req.raw)) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }

    try {
      await validateAccessJWT({
        request: c.req.raw,
        accessTeamDomain,
        accessAud,
      });
    } catch (e) {
      console.warn(`validateAccessJWT failed ${e instanceof Error ? e.message : 'unknown'}`, {
        error: e,
      });
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }

    await next();
  });
}

// Access validation code adapted from:
// https://github.com/cloudflare/pages-plugins/blob/main/packages/cloudflare-access/functions/_middleware.ts?at=90281ad52b77506bb7723a8db813e19723725509#L88

function extractJWTFromRequest(req: Request): AccessJWT {
  return AccessJWT.parse(req.headers.get('Cf-Access-Jwt-Assertion'));
}

function includesAud(payload: AccessPayload, aud: string): boolean {
  if (typeof payload.aud === 'string') {
    return payload.aud === aud;
  }
  return payload.aud.includes(aud);
}

function hasValidJWT(req: Request): boolean {
  try {
    extractJWTFromRequest(req);
    return true;
  } catch {
    return false;
  }
}

// Adapted slightly from https://github.com/cloudflare/workers-access-external-auth-example
function base64URLDecode(s: string): ArrayBuffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  return new Uint8Array(Array.from(atob(s)).map((c: string) => c.charCodeAt(0))).buffer;
}

function asciiToUint8Array(s: string): ArrayBuffer {
  const chars = [];
  for (let i = 0; i < s.length; ++i) {
    chars.push(s.charCodeAt(i));
  }
  return new Uint8Array(chars).buffer;
}

async function validateAccessJWT({
  request,
  accessTeamDomain,
  accessAud,
}: {
  request: Request;
  accessTeamDomain: AccessTeamDomain;
  accessAud: AccessAudience;
}): Promise<{ jwt: string; payload: object }> {
  const jwt = extractJWTFromRequest(request);

  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('JWT does not have three parts.');
  }
  const [header, payload, signature] = parts;

  const textDecoder = new TextDecoder('utf-8');
  const { kid } = AccessHeader.parse(JSON.parse(textDecoder.decode(base64URLDecode(header))));
  const certsURL = new URL('/cdn-cgi/access/certs', accessTeamDomain);
  const certsResponse = await fetch(certsURL.toString(), {
    cf: {
      cacheEverything: true,
      cacheTtl: seconds('1 day'),
    },
  });
  const { keys } = AccessCertsResponse.parse(await certsResponse.json());
  const jwk = keys.find(key => key.kid === kid);
  if (!jwk) {
    throw new Error('Could not find matching signing key.');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const unroundedSecondsSinceEpoch = Date.now() / 1000;

  const payloadObj = AccessPayload.parse(JSON.parse(textDecoder.decode(base64URLDecode(payload))));

  if (payloadObj.iss !== certsURL.origin) {
    throw new Error('JWT issuer is incorrect.');
  }
  if (!includesAud(payloadObj, accessAud)) {
    throw new Error('JWT audience is incorrect.');
  }
  if (Math.floor(unroundedSecondsSinceEpoch) >= payloadObj.exp) {
    throw new Error('JWT has expired.');
  }
  // nbf is only present for users, not service auth
  if (payloadObj.identity_nonce && Math.ceil(unroundedSecondsSinceEpoch) < payloadObj.nbf) {
    throw new Error('JWT is not yet valid.');
  }

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64URLDecode(signature),
    asciiToUint8Array(`${header}.${payload}`)
  );
  if (!verified) {
    throw new Error('Could not verify JWT.');
  }

  return { jwt, payload: payloadObj };
}

// ============= TYPES ============= //
const accessJWTRegex = /^[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i;

export type AccessJWT = z.infer<typeof AccessJWT>;
export const AccessJWT = z.string().regex(accessJWTRegex);

export type AccessTeam = z.infer<typeof AccessTeam>;
export const AccessTeam = z.string().regex(/^[a-z0-9-]+$/);

export type AccessTeamDomain = z.infer<typeof AccessTeamDomain>;
export const AccessTeamDomain = z.string().regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/);

export type AccessKid = z.infer<typeof AccessKid>;
export const AccessKid = z.string().regex(/^[a-f0-9]{64}$/);

export type AccessAudience = z.infer<typeof AccessAudience>;
export const AccessAudience = z.string().regex(/^[a-f0-9]{64}$/);

export type AccessAlgorithm = z.infer<typeof AccessAlgorithm>;
export const AccessAlgorithm = z.literal('RS256');

export type AccessHeader = z.infer<typeof AccessHeader>;
export const AccessHeader = z.object({
  kid: AccessKid,
  alg: AccessAlgorithm,
  typ: z.literal('JWT').optional(),
});

export type AccessKey = z.infer<typeof AccessKey>;
export const AccessKey = z.object({
  kid: AccessKid,
  kty: z.literal('RSA'),
  alg: AccessAlgorithm,
  use: z.string().min(1),
  e: z.string().min(1),
  n: z.string().min(1),
});

export type PublicCERT = z.infer<typeof PublicCERT>;
const PublicCERT = z.object({
  kid: AccessKid,
  cert: z
    .string()
    .min(1)
    .refine(
      c => c.includes('-----BEGIN CERTIFICATE-----') && c.includes('-----END CERTIFICATE-----'),
      { message: 'invalid cert format - missing or invalid header/footer' }
    ),
});

export type AccessCertsResponse = z.infer<typeof AccessCertsResponse>;
export const AccessCertsResponse = z.object({
  keys: z.array(AccessKey).min(1, { message: 'Could not fetch signing keys.' }),
  public_cert: PublicCERT,
  public_certs: z.array(PublicCERT).min(1, { message: 'Could not fetch public certs.' }),
});

// JWT fields are documented here: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/

export const AccessPayloadCommon = z.object({
  type: z.enum(['app', 'org']),
  exp: z.number().min(1),
  iat: z.number().min(1),
  iss: AccessTeamDomain,
});

const ServiceAuthAccessPayload = AccessPayloadCommon.extend({
  aud: AccessAudience,
  common_name: z.string().regex(/^[a-f0-9]{32}\.access$/),
  sub: z.literal(''),
  identity_nonce: z.undefined(),
});

const UserAccessPayload = AccessPayloadCommon.extend({
  aud: z.array(AccessAudience),
  nbf: z.number().min(1),
  email: z
    .string()
    .min(1)
    .refine(e => e.includes('@')),
  identity_nonce: z.string().min(1),
  sub: z.string().uuid(),
  country: z.string().length(2),
});

export type AccessPayload = z.infer<typeof AccessPayload>;
export const AccessPayload = z.union([UserAccessPayload, ServiceAuthAccessPayload]);
