import 'server-only';
import { createHash, createSign } from 'node:crypto';
import { captureMessage } from '@sentry/nextjs';
import {
  GOOGLE_PLAY_INTEGRITY_PACKAGE_NAME,
  GOOGLE_PLAY_INTEGRITY_CERT_DIGESTS,
  GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER,
  GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY,
} from '@/lib/config.server';
import { getEnvVariable } from '@/lib/dotenvx';

/**
 * Google Play Integrity verifier.
 *
 * Calls the Play Integrity API to decode and validate a verdict token.
 * In production without credentials, the provider fails closed — a 5xx is
 * thrown so the admission layer can surface the infrastructure fault.
 *
 * Non-production can use a simulator bypass behind the production guard.
 */

const PLAY_INTEGRITY_API_BASE = 'https://playintegrity.googleapis.com/v1';

// Required integrity labels per the plan
const REQUIRED_INTEGRITY_LABEL = 'MEETS_DEVICE_INTEGRITY';

export type PlayIntegrityError =
  | 'INVALID_TOKEN'
  | 'INTEGRITY_API_FAILURE'
  | 'DEVICE_NOT_RECOGNIZED'
  | 'APP_NOT_RECOGNIZED'
  | 'NONCE_MISMATCH'
  | 'PACKAGE_MISMATCH'
  | 'CERT_DIGEST_MISMATCH';

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Exported for testing the production guard. */
export const isProductionInternal = isProduction;

/** Obtain a GCP access token from a service-account key via JWT bearer assertion. */
async function getAccessToken(
  clientEmail: string,
  privateKey: string,
  tokenUri: string
): Promise<string> {
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
  });
  if (!res.ok) throw new Error(`Google token endpoint ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
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
export async function verifyPlayIntegrity(
  integrityToken: string,
  challenge: string
): Promise<{ ok: true; packageName: string } | { ok: false; error: PlayIntegrityError }> {
  // Production guard: simulator bypass only in non-production.
  if (!isProduction()) {
    const bypass = getEnvVariable('NATIVE_ADMISSION_SIMULATOR_BYPASS');
    if (bypass === 'true') {
      captureMessage('google_play_integrity_simulator_bypass');
      return { ok: true, packageName: 'com.example.simulator' };
    }
  }

  const config = getPlayIntegrityConfig();

  if (!config) {
    captureMessage('google_play_integrity_missing_credentials');
    // Fail-closed: missing credentials in production means we cannot verify.
    throw new Error('Google Play Integrity credentials not configured');
  }

  // Decode and verify the integrity token
  let accessToken: string;
  try {
    const saKey = JSON.parse(config.serviceAccountKey);
    accessToken = await getAccessToken(
      saKey.client_email,
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
    }
  );

  if (!response.ok) {
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
  if (!payload) return { ok: false, error: 'INVALID_TOKEN' };

  // ── Challenge binding ───────────────────────────────────────────────────
  // Standard requests bind through `requestHash`, returned verbatim; classic
  // requests use `nonce`. The client sends standard requests, so read
  // `requestHash` and fall back to `nonce` only so a device still running a
  // classic-request build is not refused mid-rollout. Both are compared
  // against the same digest, so accepting either binds the same challenge.
  const binding = payload.requestDetails?.requestHash ?? payload.requestDetails?.nonce;
  if (!binding) {
    captureMessage('play_integrity_missing_request_hash');
    return { ok: false, error: 'NONCE_MISMATCH' };
  }

  const expectedBinding = createHash('sha256').update(challenge, 'utf8').digest('base64');
  if (binding !== expectedBinding) {
    captureMessage('play_integrity_request_hash_mismatch');
    return { ok: false, error: 'NONCE_MISMATCH' };
  }

  // ── Package identity ────────────────────────────────────────────────────
  const actualPackageName =
    payload.requestDetails?.requestPackageName ?? payload.appIntegrity?.packageName;
  if (!actualPackageName || actualPackageName !== config.expectedPackageName) {
    captureMessage(
      `play_integrity_package_mismatch: expected=${config.expectedPackageName} got=${actualPackageName ?? 'null'}`
    );
    return { ok: false, error: 'PACKAGE_MISMATCH' };
  }

  // ── Signing certificate digest ──────────────────────────────────────────
  const certDigests = payload.appIntegrity?.certificateSha256Digest ?? [];
  const hasMatch = config.expectedCertDigests.some(expected =>
    certDigests.some(actual => actual.toLowerCase() === expected.toLowerCase())
  );
  if (!hasMatch) {
    captureMessage(
      `play_integrity_cert_digest_mismatch: expected=[${config.expectedCertDigests.join(',')}] got=[${certDigests.join(',')}]`
    );
    return { ok: false, error: 'CERT_DIGEST_MISMATCH' };
  }

  // ── App recognition ─────────────────────────────────────────────────────
  const appVerdict = payload.appIntegrity?.appRecognitionVerdict;
  if (appVerdict !== 'PLAY_RECOGNIZED') {
    captureMessage(`play_integrity_app_unrecognized: ${appVerdict ?? 'null'}`);
    return { ok: false, error: 'APP_NOT_RECOGNIZED' };
  }

  // ── Device integrity: must contain MEETS_DEVICE_INTEGRITY in the array ──
  const deviceVerdicts = payload.deviceIntegrity?.deviceRecognitionVerdict;
  if (!deviceVerdicts || !Array.isArray(deviceVerdicts) || deviceVerdicts.length === 0) {
    return { ok: false, error: 'DEVICE_NOT_RECOGNIZED' };
  }

  if (!deviceVerdicts.includes(REQUIRED_INTEGRITY_LABEL)) {
    captureMessage(
      `play_integrity_device_verdict_insufficient: got=[${deviceVerdicts.join(',')}] needed=${REQUIRED_INTEGRITY_LABEL}`
    );
    return { ok: false, error: 'DEVICE_NOT_RECOGNIZED' };
  }

  return { ok: true, packageName: actualPackageName };
}
