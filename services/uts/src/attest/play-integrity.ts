import { Buffer } from 'node:buffer';
import { SignJWT, importPKCS8 } from 'jose';
import { z } from 'zod';

/**
 * Google Play Integrity (design 5.5): UTS sends the app's integrity token to Google's
 * `decodeIntegrityToken` with an access token of its own service account, then checks the decoded
 * verdict. One decode costs one call of the project's daily Play Integrity quota, so a caller
 * decodes each code's token once (src/attest/gate.ts). Google's answers are read through zod; a
 * refusal names the rule that failed, never a value from the verdict.
 */

/** Where the decode and the service account's token exchange go. */
export type PlayIntegrityEndpoints = { tokenUri: string; apiBase: string };

/** Google's endpoints, the only ones a deployed environment uses. */
export const GOOGLE_PLAY_INTEGRITY_ENDPOINTS: PlayIntegrityEndpoints = {
  tokenUri: 'https://oauth2.googleapis.com/token',
  apiBase: 'https://playintegrity.googleapis.com/v1',
};

/** The fields UTS uses of a Google service-account key file (JSON). */
export const ServiceAccountKeySchema = z
  .looseObject({
    type: z.literal('service_account'),
    client_email: z.email(),
    private_key_id: z.string().regex(/^[0-9a-f]{40}$/),
    private_key: z.string().startsWith('-----BEGIN PRIVATE KEY-----'),
  })
  .transform(key => ({
    clientEmail: key.client_email,
    privateKeyId: key.private_key_id,
    privateKeyPem: key.private_key,
  }));
export type ServiceAccountKey = z.output<typeof ServiceAccountKeySchema>;

const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
/** Each Google call is given up after this long. */
const GOOGLE_CALL_TIMEOUT_MS = 4_000;
/** A cached access token is replaced this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const AccessTokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

/**
 * The parts of the decoded verdict UTS checks (Play Integrity `TokenPayloadExternal`). A verdict
 * without them does not pass.
 */
const TokenPayloadSchema = z.looseObject({
  requestDetails: z.looseObject({
    requestPackageName: z.string(),
    requestHash: z.string().optional(),
    timestampMillis: z
      .string()
      .regex(/^[0-9]{1,16}$/)
      .transform(Number),
  }),
  appIntegrity: z.looseObject({
    appRecognitionVerdict: z.string(),
    packageName: z.string().optional(),
    certificateSha256Digest: z.array(z.string()).optional(),
  }),
  deviceIntegrity: z.looseObject({
    deviceRecognitionVerdict: z.array(z.string()).optional(),
  }),
});
export type PlayVerdict = z.output<typeof TokenPayloadSchema>;

const DecodeResponseSchema = z.looseObject({ tokenPayloadExternal: z.unknown() });

export type PlayDecodeResult =
  | { status: 'decoded'; verdict: PlayVerdict }
  /** Google refused the token, or its verdict lacks a part UTS checks. */
  | { status: 'invalid_token' }
  /** A retry may succeed: UTS's credential was refused, the quota is spent, or Google failed. */
  | { status: 'unavailable'; reason: 'credential' | 'quota' | 'upstream' };

export type PlayDecode = (integrityToken: string) => Promise<PlayDecodeResult>;

type CachedToken =
  | { state: 'ready'; token: string; refreshAt: number }
  | { state: 'pending'; promise: Promise<string> };

/**
 * Access tokens per isolate, by token endpoint and key id. Concurrent cold requests share one
 * exchange; a failed exchange leaves no entry, so the next request tries again.
 */
const accessTokens = new Map<string, CachedToken>();

async function exchangeAccessToken(
  key: ServiceAccountKey,
  endpoints: PlayIntegrityEndpoints,
  fetcher: typeof fetch,
  nowMs: number
): Promise<{ token: string; refreshAt: number }> {
  const assertion = await new SignJWT({ scope: PLAY_INTEGRITY_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: key.privateKeyId })
    .setIssuer(key.clientEmail)
    .setAudience(endpoints.tokenUri)
    .setIssuedAt(Math.floor(nowMs / 1000))
    .setExpirationTime(Math.floor(nowMs / 1000) + 3600)
    .sign(await importPKCS8(key.privateKeyPem, 'RS256'));
  const response = await fetcher(endpoints.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(GOOGLE_CALL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`token endpoint answered ${response.status}`);
  const body = AccessTokenResponseSchema.parse(await response.json());
  return {
    token: body.access_token,
    refreshAt: nowMs + body.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS,
  };
}

async function accessToken(
  key: ServiceAccountKey,
  endpoints: PlayIntegrityEndpoints,
  fetcher: typeof fetch,
  nowMs: number
): Promise<string> {
  const cacheKey = `${endpoints.tokenUri} ${key.privateKeyId}`;
  const cached = accessTokens.get(cacheKey);
  if (cached?.state === 'ready' && cached.refreshAt > nowMs) return cached.token;
  if (cached?.state === 'pending') return await cached.promise;
  const promise = exchangeAccessToken(key, endpoints, fetcher, nowMs).then(
    fresh => {
      // A later exchange that replaced this one keeps its own result.
      if (accessTokens.get(cacheKey) === entry) {
        accessTokens.set(cacheKey, { state: 'ready', ...fresh });
      }
      return fresh.token;
    },
    (error: unknown) => {
      if (accessTokens.get(cacheKey) === entry) accessTokens.delete(cacheKey);
      throw error;
    }
  );
  const entry: CachedToken = { state: 'pending', promise };
  accessTokens.set(cacheKey, entry);
  return await promise;
}

/** Drops a cached token Google refused, unless a newer one replaced it already. */
function dropAccessToken(key: ServiceAccountKey, endpoints: PlayIntegrityEndpoints, token: string) {
  const cacheKey = `${endpoints.tokenUri} ${key.privateKeyId}`;
  const cached = accessTokens.get(cacheKey);
  if (cached?.state === 'ready' && cached.token === token) accessTokens.delete(cacheKey);
}

/** Exported for the tests: forget every cached access token. */
export function clearAccessTokens(): void {
  accessTokens.clear();
}

/** The decode port for one service account and package. */
export function playIntegrityDecoder(deps: {
  key: ServiceAccountKey;
  packageName: string;
  endpoints: PlayIntegrityEndpoints;
  fetcher: typeof fetch;
  now: () => number;
}): PlayDecode {
  const url = `${deps.endpoints.apiBase}/${encodeURIComponent(deps.packageName)}:decodeIntegrityToken`;
  return async integrityToken => {
    let token: string;
    try {
      token = await accessToken(deps.key, deps.endpoints, deps.fetcher, deps.now());
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'uts.attestation.google_token_failed',
          error: error instanceof Error ? error.name : 'unknown',
        })
      );
      return { status: 'unavailable', reason: 'credential' };
    }
    let response: Response;
    try {
      response = await deps.fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrityToken }),
        signal: AbortSignal.timeout(GOOGLE_CALL_TIMEOUT_MS),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'uts.attestation.play_decode_failed',
          error: error instanceof Error ? error.name : 'unknown',
        })
      );
      return { status: 'unavailable', reason: 'upstream' };
    }
    if (response.status === 400) return { status: 'invalid_token' };
    if (!response.ok) {
      console.error(
        JSON.stringify({ event: 'uts.attestation.play_decode_status', status: response.status })
      );
      if (response.status === 401 || response.status === 403) {
        dropAccessToken(deps.key, deps.endpoints, token);
        return { status: 'unavailable', reason: 'credential' };
      }
      return { status: 'unavailable', reason: response.status === 429 ? 'quota' : 'upstream' };
    }
    const body = DecodeResponseSchema.safeParse(await response.json().catch(() => null));
    const verdict = TokenPayloadSchema.safeParse(body.data?.tokenPayloadExternal);
    return verdict.success
      ? { status: 'decoded', verdict: verdict.data }
      : { status: 'invalid_token' };
  };
}

/** The verdict a genuine Play build of the app on a genuine device gets. */
export type PlayExpectation = {
  packageName: string;
  /** The SHA-256 of each accepted app signing certificate. */
  certificateDigests: readonly Uint8Array[];
};

export type PlayRefusal =
  | 'request_hash_mismatch'
  | 'package_mismatch'
  | 'stale'
  | 'app_not_recognized'
  | 'certificate_mismatch'
  | 'device_integrity';

/** How old a verdict may be, and how far ahead of this clock. */
const VERDICT_MAX_AGE_MS = 5 * 60 * 1000;
const VERDICT_MAX_SKEW_MS = 60 * 1000;

/**
 * A SHA-256 digest as configured or as Google sends it: 64 hex digits (with or without colons, as
 * the Play Console shows them) or base64 (Google's base64url, with or without padding). Null for
 * anything that is not 32 bytes.
 */
export function parseCertificateDigest(value: string): Uint8Array | null {
  const trimmed = value.trim();
  const hex = trimmed.replaceAll(':', '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return new Uint8Array(Buffer.from(hex, 'hex'));
  if (!/^[A-Za-z0-9_+/-]{43}=?$/.test(trimmed)) return null;
  const bytes = new Uint8Array(Buffer.from(trimmed.replace(/=$/, ''), 'base64url'));
  return bytes.length === 32 ? bytes : null;
}

/**
 * Checks a decoded verdict: bound to `requestHash` (a standard request), for the package, recent,
 * `PLAY_RECOGNIZED`, signed with an accepted certificate, and `MEETS_DEVICE_INTEGRITY`.
 */
export function checkPlayVerdict(
  verdict: PlayVerdict,
  expected: PlayExpectation & { requestHash: string },
  nowMs: number
): { status: 'verified' } | { status: 'refused'; reason: PlayRefusal } {
  const refused = (reason: PlayRefusal) => ({ status: 'refused', reason }) as const;
  if (verdict.requestDetails.requestHash !== expected.requestHash) {
    return refused('request_hash_mismatch');
  }
  if (
    verdict.requestDetails.requestPackageName !== expected.packageName ||
    verdict.appIntegrity.packageName !== expected.packageName
  ) {
    return refused('package_mismatch');
  }
  const age = nowMs - verdict.requestDetails.timestampMillis;
  if (age > VERDICT_MAX_AGE_MS || age < -VERDICT_MAX_SKEW_MS) return refused('stale');
  if (verdict.appIntegrity.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
    return refused('app_not_recognized');
  }
  const accepted = new Set(
    expected.certificateDigests.map(digest => Buffer.from(digest).toString('hex'))
  );
  const signedWithAccepted = (verdict.appIntegrity.certificateSha256Digest ?? []).some(value => {
    const digest = parseCertificateDigest(value);
    return digest !== null && accepted.has(Buffer.from(digest).toString('hex'));
  });
  if (!signedWithAccepted) return refused('certificate_mismatch');
  if (!verdict.deviceIntegrity.deviceRecognitionVerdict?.includes('MEETS_DEVICE_INTEGRITY')) {
    return refused('device_integrity');
  }
  return { status: 'verified' };
}
