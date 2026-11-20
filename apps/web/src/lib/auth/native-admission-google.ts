import 'server-only';
import { createHash, createSign } from 'node:crypto';
import { captureMessage } from '@sentry/nextjs';
import {
  GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME,
  GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS,
  GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER,
  GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY,
} from '@kilocode/web-shared/lib/config.server';

/**
 * Google Play Integrity verifier.
 *
 * Calls the Play Integrity API to decode and validate a verdict token.
 * Without credentials or on a provider fault it throws, so the admission layer
 * surfaces the infrastructure fault as a 5xx instead of refusing the device.
 */

const PLAY_INTEGRITY_API_BASE = 'https://playintegrity.googleapis.com/v1';

/** Abort budget for both outbound Google calls. */
const GOOGLE_FETCH_TIMEOUT_MS = 10_000;

/** Refresh the cached access token this long before its actual expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Access-token cache keyed by service-account email. Google tokens are
 * reusable for about an hour, so verification mints a token only when the
 * cached one is inside the expiry margin. Concurrent cold starts share the
 * single in-flight refresh promise.
 */
const accessTokenCache = new Map<
  string,
  { token: string; refreshAt: number; inflight?: Promise<string> }
>();

/** Exported for tests: clear the cache so each test exercises a cold start. */
export function resetAccessTokenCacheForTests(): void {
  accessTokenCache.clear();
}

// Required integrity labels per the plan
const REQUIRED_INTEGRITY_LABEL = 'MEETS_DEVICE_INTEGRITY';

export type PlayIntegrityError =
  | 'INVALID_TOKEN'
  | 'DEVICE_NOT_RECOGNIZED'
  | 'APP_NOT_RECOGNIZED'
  | 'NONCE_MISMATCH'
  | 'PACKAGE_MISMATCH'
  | 'CERT_DIGEST_MISMATCH';

/**
 * Allowlisted classifications of Google's verdict for telemetry. Every value is
 * one this module names itself: the raw verdict strings and the certificate
 * digests Google returned never leave it, so a log record built from these can
 * only say which fixed bucket a proof landed in.
 */
export type PlayIntegrityAppRecognition =
  | 'play_recognized'
  | 'unrecognized_version'
  | 'unevaluated'
  | 'unknown'
  | 'missing';

export type PlayIntegrityDeviceIntegrity =
  | 'meets_device_integrity'
  | 'other_integrity_label'
  | 'no_known_label'
  | 'empty'
  | 'missing';

export type PlayIntegrityDiagnostics = {
  appRecognition: PlayIntegrityAppRecognition;
  certificatePresent: boolean;
  deviceIntegrity: PlayIntegrityDeviceIntegrity;
};

/** Google's `appRecognitionVerdict` values this module distinguishes by name. */
const PLAY_RECOGNIZED = 'PLAY_RECOGNIZED';
const UNRECOGNIZED_VERSION = 'UNRECOGNIZED_VERSION';
const UNEVALUATED = 'UNEVALUATED';

/** Integrity labels Google may put in `deviceRecognitionVerdict`. */
const KNOWN_INTEGRITY_LABELS = [
  REQUIRED_INTEGRITY_LABEL,
  'MEETS_BASIC_INTEGRITY',
  'MEETS_STRONG_INTEGRITY',
  'MEETS_VIRTUAL_INTEGRITY',
] as const;

function classifyAppRecognition(verdict: string | undefined): PlayIntegrityAppRecognition {
  switch (verdict) {
    case PLAY_RECOGNIZED:
      return 'play_recognized';
    case UNRECOGNIZED_VERSION:
      return 'unrecognized_version';
    case UNEVALUATED:
      return 'unevaluated';
    case undefined:
      return 'missing';
    default:
      return 'unknown';
  }
}

function classifyDeviceIntegrity(verdicts: string[] | undefined): PlayIntegrityDeviceIntegrity {
  if (!Array.isArray(verdicts)) return 'missing';
  if (verdicts.length === 0) return 'empty';
  if (verdicts.includes(REQUIRED_INTEGRITY_LABEL)) return 'meets_device_integrity';
  if (verdicts.some(verdict => KNOWN_INTEGRITY_LABELS.some(label => label === verdict))) {
    return 'other_integrity_label';
  }
  return 'no_known_label';
}

/** Obtain a GCP access token from a service-account key via JWT bearer assertion. */
async function requestAccessToken(
  clientEmail: string,
  privateKey: string,
  tokenUri: string
): Promise<{ token: string; refreshAt: number }> {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claimSet = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/playintegrity',
      aud: tokenUri,
      exp: now + 3600,
      iat: now,
    })
  ).toString('base64url');

  const signingInput = `${header}.${claimSet}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  sign.end();
  const sig = sign.sign(privateKey, 'base64url');
  const jwt = `${signingInput}.${sig}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google token endpoint ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  if (!data.access_token) throw new Error('Google token endpoint returned no access_token');
  // Without expires_in, fall back to the standard one-hour Google lifetime.
  const lifetimeMs = (data.expires_in ?? 3600) * 1000;
  return { token: data.access_token, refreshAt: Date.now() + lifetimeMs };
}

/**
 * Return a cached access token when it is still outside the expiry margin;
 * otherwise mint a fresh one. Concurrent callers awaiting the same cold start
 * share one in-flight refresh; a failed refresh clears the entry so the next
 * caller retries.
 */
async function getAccessToken(
  clientEmail: string,
  privateKey: string,
  tokenUri: string
): Promise<string> {
  const cached = accessTokenCache.get(clientEmail);
  if (cached && cached.refreshAt > Date.now()) return cached.token;
  if (cached?.inflight) return cached.inflight;

  // Holder lets the callbacks compare against the settled promise reference
  // without reassigning it.
  const pending: { promise?: Promise<string> } = {};
  const promise = requestAccessToken(clientEmail, privateKey, tokenUri)
    .then(({ token, refreshAt }) => {
      const entry = accessTokenCache.get(clientEmail);
      if (entry?.inflight === pending.promise) {
        // Refresh inside the margin so the token stays valid for the whole
        // verify call that follows.
        accessTokenCache.set(clientEmail, {
          token,
          refreshAt: refreshAt - TOKEN_EXPIRY_MARGIN_MS,
        });
      }
      return token;
    })
    .catch(err => {
      const entry = accessTokenCache.get(clientEmail);
      if (entry?.inflight === pending.promise) accessTokenCache.delete(clientEmail);
      throw err;
    });
  pending.promise = promise;

  accessTokenCache.set(clientEmail, { token: '', refreshAt: 0, inflight: promise });
  return promise;
}

/**
 * Drop the cache entry for this client email, but only while it still holds the
 * token the caller sent. A concurrent caller may already have replaced the
 * entry with a fresh token; that entry must survive.
 */
function dropRejectedAccessToken(clientEmail: string, rejectedToken: string): void {
  const entry = accessTokenCache.get(clientEmail);
  if (entry && entry.inflight === undefined && entry.token === rejectedToken) {
    accessTokenCache.delete(clientEmail);
  }
}

/**
 * Required server-side environment variables for Play Integrity.
 */
interface PlayIntegrityConfig {
  serviceAccountKey: string;
  expectedPackageName: string;
  expectedCertDigests: string[];
}

function getPlayIntegrityConfig(): PlayIntegrityConfig | null {
  const projectNumber = GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER;
  const serviceAccountKey = GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY;

  if (!projectNumber || !serviceAccountKey || !GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME) {
    return null;
  }

  const expectedCertDigests = GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS
    ? GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS.split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];

  return {
    serviceAccountKey,
    expectedPackageName: GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME,
    expectedCertDigests,
  };
}

/**
 * Verify a Play Integrity verdict token.
 *
 * Binds the token to the server-issued challenge via the nonce field.
 * Requires MEETS_DEVICE_INTEGRITY in the deviceRecognitionVerdict array.
 * Verifies package name and signing certificate digest.
 *
 * Throws on infrastructure faults (network errors, auth failures) so the
 * admission layer can surface them as 5xx.
 */
export type PlayIntegrityResult =
  | { ok: true; packageName: string }
  | { ok: false; error: PlayIntegrityError; diagnostics: PlayIntegrityDiagnostics };

/**
 * The classification of a verdict that was never parsed, so a refusal before the
 * payload exists still reports a complete, log-safe shape.
 */
const UNPARSED_VERDICT_DIAGNOSTICS: PlayIntegrityDiagnostics = {
  appRecognition: 'missing',
  certificatePresent: false,
  deviceIntegrity: 'missing',
};

export async function verifyPlayIntegrity(
  integrityToken: string,
  challenge: string
): Promise<PlayIntegrityResult> {
  const config = getPlayIntegrityConfig();

  if (!config) {
    captureMessage('google_play_integrity_missing_credentials');
    // Fail-closed: missing credentials in production means we cannot verify.
    throw new Error('Google Play Integrity credentials not configured');
  }

  // Decode and verify the integrity token
  let accessToken: string;
  let clientEmail: string;
  try {
    const saKey = JSON.parse(config.serviceAccountKey);
    clientEmail = saKey.client_email;
    accessToken = await getAccessToken(
      clientEmail,
      saKey.private_key,
      saKey.token_uri || 'https://oauth2.googleapis.com/token'
    );
  } catch (err) {
    captureMessage('google_play_integrity_auth_failure');
    throw new Error('Failed to obtain Play Integrity access token', { cause: err });
  }

  // Google requires the app's package name as the resource path on the decode
  // endpoint; the project number alone is rejected.
  const response = await fetch(
    `${PLAY_INTEGRITY_API_BASE}/${encodeURIComponent(config.expectedPackageName)}:decodeIntegrityToken`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ integrityToken }),
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    // A refused credential (401/403) must not be replayed: the next admission
    // mints a fresh access token instead of resending a rejected one for the
    // rest of its lifetime. Every other status is a verdict or provider
    // condition, so its token stays cached.
    if (response.status === 401 || response.status === 403) {
      dropRejectedAccessToken(clientEmail, accessToken);
    }
    captureMessage(`play_integrity_api_status: ${response.status}`);
    throw new Error(`Play Integrity API returned ${response.status}`);
  }

  const result = (await response.json()) as {
    tokenPayloadExternal?: {
      requestDetails?: {
        requestPackageName?: string;
        /** Standard requests: the client-supplied hash, returned verbatim. */
        requestHash?: string;
        /** Classic requests only. */
        nonce?: string;
        timestampMillis?: string;
      };
      appIntegrity?: {
        appRecognitionVerdict?: string;
        certificateSha256Digest?: string[];
        packageName?: string;
      };
      deviceIntegrity?: {
        deviceRecognitionVerdict?: string[];
      };
      accountDetails?: {
        appLicensingVerdict?: string;
      };
    };
  };

  const payload = result.tokenPayloadExternal;
  if (!payload) {
    return { ok: false, error: 'INVALID_TOKEN', diagnostics: UNPARSED_VERDICT_DIAGNOSTICS };
  }

  // The classification every refusal below reports. Built once from the parsed
  // verdict, so the record says which fixed bucket the proof landed in and
  // never carries Google's raw strings or the digest itself.
  const certDigests = payload.appIntegrity?.certificateSha256Digest ?? [];
  const diagnostics: PlayIntegrityDiagnostics = {
    appRecognition: classifyAppRecognition(payload.appIntegrity?.appRecognitionVerdict),
    certificatePresent: certDigests.length > 0,
    deviceIntegrity: classifyDeviceIntegrity(payload.deviceIntegrity?.deviceRecognitionVerdict),
  };

  // ── Challenge binding ───────────────────────────────────────────────────
  // Standard requests bind through `requestHash`, returned verbatim; classic
  // requests use `nonce`. The client sends standard requests, so read
  // `requestHash` and fall back to `nonce` only so a device still running a
  // classic-request build is not refused mid-rollout. Both are compared
  // against the same digest, so accepting either binds the same challenge.
  const binding = payload.requestDetails?.requestHash ?? payload.requestDetails?.nonce;
  if (!binding) {
    captureMessage('play_integrity_missing_request_hash');
    return { ok: false, error: 'NONCE_MISMATCH', diagnostics };
  }

  const expectedBinding = createHash('sha256').update(challenge, 'utf8').digest('base64');
  if (binding !== expectedBinding) {
    captureMessage('play_integrity_request_hash_mismatch');
    return { ok: false, error: 'NONCE_MISMATCH', diagnostics };
  }

  // ── Package identity ────────────────────────────────────────────────────
  const actualPackageName =
    payload.requestDetails?.requestPackageName ?? payload.appIntegrity?.packageName;
  if (!actualPackageName || actualPackageName !== config.expectedPackageName) {
    captureMessage(
      `play_integrity_package_mismatch: expected=${config.expectedPackageName} got=${actualPackageName ?? 'null'}`
    );
    return { ok: false, error: 'PACKAGE_MISMATCH', diagnostics };
  }

  // ── App recognition ─────────────────────────────────────────────────────
  const appVerdict = payload.appIntegrity?.appRecognitionVerdict;
  if (appVerdict !== PLAY_RECOGNIZED) {
    captureMessage(`play_integrity_app_unrecognized: ${appVerdict ?? 'null'}`);
    return { ok: false, error: 'APP_NOT_RECOGNIZED', diagnostics };
  }

  // ── Signing certificate digest ──────────────────────────────────────────
  const hasMatch = config.expectedCertDigests.some(expected =>
    certDigests.some(actual => actual.toLowerCase() === expected.toLowerCase())
  );
  if (!hasMatch) {
    captureMessage(
      `play_integrity_cert_digest_mismatch: expected=[${config.expectedCertDigests.join(',')}] got=[${certDigests.join(',')}]`
    );
    return { ok: false, error: 'CERT_DIGEST_MISMATCH', diagnostics };
  }

  // ── Device integrity: must contain MEETS_DEVICE_INTEGRITY in the array ──
  const deviceVerdicts = payload.deviceIntegrity?.deviceRecognitionVerdict;
  if (!deviceVerdicts || !Array.isArray(deviceVerdicts) || deviceVerdicts.length === 0) {
    return { ok: false, error: 'DEVICE_NOT_RECOGNIZED', diagnostics };
  }

  if (!deviceVerdicts.includes(REQUIRED_INTEGRITY_LABEL)) {
    captureMessage(
      `play_integrity_device_verdict_insufficient: got=[${deviceVerdicts.join(',')}] needed=${REQUIRED_INTEGRITY_LABEL}`
    );
    return { ok: false, error: 'DEVICE_NOT_RECOGNIZED', diagnostics };
  }

  return { ok: true, packageName: actualPackageName };
}
