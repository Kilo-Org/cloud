import type { UtsEnvironment } from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { APPLE_APP_ATTEST_ROOT, type AppAttestSettings } from './app-attest';
import {
  GOOGLE_PLAY_INTEGRITY_ENDPOINTS,
  type PlayExpectation,
  type PlayIntegrityEndpoints,
  type ServiceAccountKey,
  ServiceAccountKeySchema,
  parseCertificateDigest,
} from './play-integrity';

/**
 * Attestation configuration from the Worker's vars and one secret (names only here; README "Mobile
 * attestation" gives where each value comes from). `kilo-mobile` is served only where every value
 * is set and valid. Anything less refuses the client: in staging and production whatever is set,
 * and in development as soon as one value is set. Development with no value at all serves the
 * client without attestation, for the local tests (decision Q67).
 *
 * Vars (plain): `ATTEST_APPLE_TEAM_ID`, `ATTEST_APPLE_BUNDLE_ID`,
 * `ATTEST_PLAY_INTEGRITY_PACKAGE_NAME`, `ATTEST_PLAY_INTEGRITY_CERT_DIGESTS` (comma-separated
 * SHA-256 digests of the accepted app signing certificates).
 * Secret: `ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY` (the service account's JSON key file).
 * Development only: `ATTEST_DEV_ENDPOINTS`, a stand-in App Attest root and Play Integrity origin.
 */

const REQUIRED_VAR_NAMES = [
  'ATTEST_APPLE_TEAM_ID',
  'ATTEST_APPLE_BUNDLE_ID',
  'ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY',
  'ATTEST_PLAY_INTEGRITY_CERT_DIGESTS',
  'ATTEST_PLAY_INTEGRITY_PACKAGE_NAME',
] as const;
const DEV_ENDPOINTS_VAR = 'ATTEST_DEV_ENDPOINTS';

export type AttestVarName = (typeof REQUIRED_VAR_NAMES)[number] | typeof DEV_ENDPOINTS_VAR;
export type AttestEnv = Partial<Record<AttestVarName, string>>;

export type AttestationSettings = {
  appAttest: AppAttestSettings;
  play: {
    key: ServiceAccountKey;
    endpoints: PlayIntegrityEndpoints;
    expectation: PlayExpectation;
  };
};

/**
 * `on`: every value is valid. `off`: none is set. `misconfigured`: the names of the values that
 * are missing or invalid (never a value).
 */
export type AttestationConfig =
  | { status: 'on'; settings: AttestationSettings }
  | { status: 'off' }
  | { status: 'misconfigured'; problems: readonly AttestVarName[] };

/**
 * What the endpoints do for a client that needs attestation. `verified`: serve it and verify every
 * code exchange. `unattested_development`: development with no attestation config. `refused`: do
 * not serve it; `problems` names the values to fix, empty when none is set.
 */
export type AttestationPolicy =
  | { kind: 'verified'; settings: AttestationSettings }
  | { kind: 'unattested_development' }
  | { kind: 'refused'; problems: readonly AttestVarName[] };

const TeamIdSchema = z.string().regex(/^[A-Z0-9]{10}$/);
/** A reverse-domain app id: an iOS bundle id or an Android package name. */
const AppIdSchema = z
  .string()
  .max(155)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_-]*)+$/);
const DigestsSchema = z
  .string()
  .transform(value => value.split(','))
  .pipe(z.array(z.string()).min(1).max(8))
  .transform((values, context) => {
    const digests: Uint8Array[] = [];
    for (const value of values) {
      const digest = parseCertificateDigest(value);
      if (digest === null) {
        context.addIssue({ code: 'custom', message: 'a SHA-256 digest' });
        return z.NEVER;
      }
      digests.push(digest);
    }
    return digests;
  });
const ServiceAccountKeyJsonSchema = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: 'custom', message: 'JSON' });
      return z.NEVER;
    }
  })
  .pipe(ServiceAccountKeySchema);

/** A loopback origin, the only place a development stand-in may live. */
const LoopbackOriginSchema = z.url().refine(value => {
  const url = new URL(value);
  return (
    url.origin === value &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  );
}, 'a loopback origin');

const DevEndpointsSchema = z.strictObject({
  /** A stand-in App Attest root certificate, DER in standard base64. */
  appleRootCertificate: z.base64().transform(value => new Uint8Array(Buffer.from(value, 'base64'))),
  /** The origin of a stand-in for Google's token endpoint (`/token`) and Play Integrity (`/v1`). */
  playIntegrityOrigin: LoopbackOriginSchema,
});

type DevEndpoints = { appleRoot: Uint8Array; play: PlayIntegrityEndpoints };

function devEndpoints(raw: string): DevEndpoints | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = DevEndpointsSchema.safeParse(json);
  if (!parsed.success) return null;
  const origin = parsed.data.playIntegrityOrigin;
  return {
    appleRoot: parsed.data.appleRootCertificate,
    play: { tokenUri: `${origin}/token`, apiBase: `${origin}/v1` },
  };
}

export function readAttestationConfig(
  env: AttestEnv,
  environment: UtsEnvironment
): AttestationConfig {
  const present = (name: AttestVarName) => (env[name] ?? '').trim() !== '';
  if (!REQUIRED_VAR_NAMES.some(present) && !present(DEV_ENDPOINTS_VAR)) return { status: 'off' };

  const problems: AttestVarName[] = [];
  const check = <Output>(name: AttestVarName, schema: z.ZodType<Output, string>) => {
    const parsed = schema.safeParse((env[name] ?? '').trim());
    if (!parsed.success) problems.push(name);
    return parsed.data;
  };
  const teamId = check('ATTEST_APPLE_TEAM_ID', TeamIdSchema);
  const bundleId = check('ATTEST_APPLE_BUNDLE_ID', AppIdSchema);
  const key = check('ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY', ServiceAccountKeyJsonSchema);
  const digests = check('ATTEST_PLAY_INTEGRITY_CERT_DIGESTS', DigestsSchema);
  const packageName = check('ATTEST_PLAY_INTEGRITY_PACKAGE_NAME', AppIdSchema);

  // Stand-ins only in development: anywhere else the var alone refuses the client.
  let endpoints: DevEndpoints | null = null;
  const devRaw = env[DEV_ENDPOINTS_VAR];
  if (devRaw !== undefined && devRaw.trim() !== '') {
    endpoints = environment === 'development' ? devEndpoints(devRaw) : null;
    if (endpoints === null) problems.push(DEV_ENDPOINTS_VAR);
  }

  if (
    problems.length > 0 ||
    teamId === undefined ||
    bundleId === undefined ||
    key === undefined ||
    digests === undefined ||
    packageName === undefined
  ) {
    return { status: 'misconfigured', problems };
  }
  return {
    status: 'on',
    settings: {
      appAttest: {
        appId: `${teamId}.${bundleId}`,
        rootCertificate: endpoints?.appleRoot ?? APPLE_APP_ATTEST_ROOT,
        environments:
          environment === 'development' ? ['production', 'development'] : ['production'],
      },
      play: {
        key,
        endpoints: endpoints?.play ?? GOOGLE_PLAY_INTEGRITY_ENDPOINTS,
        expectation: { packageName, certificateDigests: digests },
      },
    },
  };
}

export function attestationPolicy(
  config: AttestationConfig,
  environment: UtsEnvironment
): AttestationPolicy {
  if (config.status === 'on') return { kind: 'verified', settings: config.settings };
  if (config.status === 'off' && environment === 'development') {
    return { kind: 'unattested_development' };
  }
  return { kind: 'refused', problems: config.status === 'off' ? [] : config.problems };
}
