import { z } from 'zod';

const SECONDS_PER_DAY = 86400;

const accessJWTRegex = /^[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i;

const AccessJWT = z.string().regex(accessJWTRegex);
const AccessTeam = z.string().regex(/^[a-z0-9-]+$/);
const AccessTeamDomain = z.string().regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/);
const AccessKid = z.string().regex(/^[a-f0-9]{64}$/);
const AccessAudience = z.string().regex(/^[a-f0-9]{64}$/);
const AccessAlgorithm = z.literal('RS256');

const AccessHeader = z.object({
  kid: AccessKid,
  alg: AccessAlgorithm,
  typ: z.literal('JWT').optional(),
});

const AccessKey = z.object({
  kid: AccessKid,
  kty: z.literal('RSA'),
  alg: AccessAlgorithm,
  use: z.string().min(1),
  e: z.string().min(1),
  n: z.string().min(1),
});

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

const AccessCertsResponse = z.object({
  keys: z.array(AccessKey).min(1, { message: 'Could not fetch signing keys.' }),
  public_cert: PublicCERT,
  public_certs: z.array(PublicCERT).min(1, { message: 'Could not fetch public certs.' }),
});

const AccessPayloadCommon = z.object({
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

const AccessPayload = z.union([UserAccessPayload, ServiceAuthAccessPayload]);

type UserAccessPayload = z.infer<typeof UserAccessPayload>;

function base64URLDecode(s: string): ArrayBuffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  return new Uint8Array(Array.from(atob(s)).map((c: string) => c.charCodeAt(0))).buffer;
}

function asciiToUint8Array(s: string): ArrayBuffer {
  const chars: number[] = [];
  for (let i = 0; i < s.length; ++i) chars.push(s.charCodeAt(i));
  return new Uint8Array(chars).buffer;
}

function includesAud(payload: z.infer<typeof AccessPayload>, aud: string): boolean {
  if (typeof payload.aud === 'string') return payload.aud === aud;
  return payload.aud.includes(aud);
}

function extractJWTFromRequest(req: Request): string {
  return AccessJWT.parse(req.headers.get('Cf-Access-Jwt-Assertion'));
}

async function validateAccessJWT(
  request: Request,
  accessTeamDomain: string,
  accessAud: string
): Promise<{ payload: z.infer<typeof AccessPayload> }> {
  const jwt = extractJWTFromRequest(request);
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('JWT does not have three parts.');
  const [header, payload, signature] = parts;

  const textDecoder = new TextDecoder('utf-8');
  const { kid } = AccessHeader.parse(JSON.parse(textDecoder.decode(base64URLDecode(header))));

  const certsURL = new URL('/cdn-cgi/access/certs', accessTeamDomain);
  const certsResponse = await fetch(certsURL.toString(), {
    cf: { cacheEverything: true, cacheTtl: SECONDS_PER_DAY },
  });
  const { keys } = AccessCertsResponse.parse(await certsResponse.json());
  const jwk = keys.find(key => key.kid === kid);
  if (!jwk) throw new Error('Could not find matching signing key.');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const unroundedSecondsSinceEpoch = Date.now() / 1000;
  const payloadObj = AccessPayload.parse(JSON.parse(textDecoder.decode(base64URLDecode(payload))));

  if (payloadObj.iss !== certsURL.origin) throw new Error('JWT issuer is incorrect.');
  if (!includesAud(payloadObj, accessAud)) throw new Error('JWT audience is incorrect.');
  if (Math.floor(unroundedSecondsSinceEpoch) >= payloadObj.exp) throw new Error('JWT has expired.');
  if (payloadObj.identity_nonce && Math.ceil(unroundedSecondsSinceEpoch) < payloadObj.nbf) {
    throw new Error('JWT is not yet valid.');
  }

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64URLDecode(signature),
    asciiToUint8Array(`${header}.${payload}`)
  );
  if (!verified) throw new Error('Could not verify JWT.');

  return { payload: payloadObj };
}

export async function verifyCfAccess(
  request: Request,
  team: string,
  audience: string
): Promise<string | null> {
  try {
    AccessTeam.parse(team);
    AccessAudience.parse(audience);
  } catch {
    return null;
  }

  const assertionHeader = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertionHeader) return null;

  const accessTeamDomain = AccessTeamDomain.parse(`https://${team}.cloudflareaccess.com`);
  const accessAud = AccessAudience.parse(audience);

  try {
    const { payload } = await validateAccessJWT(request, accessTeamDomain, accessAud);
    if ('email' in payload) {
      return payload.email;
    }
    return null;
  } catch {
    return null;
  }
}
