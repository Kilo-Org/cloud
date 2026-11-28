import type { UtsEnvironment } from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { APPLE_APP_ATTEST_ROOT } from '../../src/attest/app-attest';
import { type AttestEnv, attestationPolicy, readAttestationConfig } from '../../src/attest/config';
import type { UtsSecrets } from '../../src/secrets';
import { secretsOf } from '../secrets-support';
import { GOOGLE_PLAY_INTEGRITY_ENDPOINTS } from '../../src/attest/play-integrity';

/**
 * Refuse by default: `kilo-mobile` is served only where every attestation value is set and valid,
 * and development without any value is the one place it is served without attestation.
 */

/** The attestation vars and the key, in one record. */
type Settings = AttestEnv & { ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY?: string };

let complete: Settings;
/** The service account key file, as the bundle delivers it. */
let serviceAccountKey: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  serviceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'b'.repeat(40),
    private_key: await exportPKCS8(privateKey),
    client_email: 'uts-play-integrity@example-project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  complete = {
    ATTEST_APPLE_TEAM_ID: 'ABCDE12345',
    ATTEST_APPLE_BUNDLE_ID: 'com.example.kilo',
    ATTEST_PLAY_INTEGRITY_PACKAGE_NAME: 'com.example.kilo',
    ATTEST_PLAY_INTEGRITY_CERT_DIGESTS: `${'AB:'.repeat(31)}AB,${Buffer.alloc(32, 1).toString('base64url')}`,
    ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: serviceAccountKey,
  };
});

const ENVIRONMENTS: UtsEnvironment[] = ['production', 'staging', 'development'];
const policy = (
  { ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: key, ...vars }: Settings,
  environment: UtsEnvironment,
  secrets: UtsSecrets = secretsOf(
    key === undefined ? {} : { ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: key }
  )
) => attestationPolicy(readAttestationConfig(vars, secrets, environment), environment);

describe('attestation policy', () => {
  it('refuses the client in staging and production without any value', () => {
    expect(policy({}, 'production')).toEqual({ kind: 'refused', problems: [] });
    expect(policy({}, 'staging')).toEqual({ kind: 'refused', problems: [] });
  });

  it('serves the client without attestation in development without any value', () => {
    expect(policy({}, 'development')).toEqual({ kind: 'unattested_development' });
  });

  it.each(ENVIRONMENTS)('verifies every exchange in %s once every value is valid', environment => {
    const result = policy(complete, environment);
    expect(result.kind).toBe('verified');
    if (result.kind !== 'verified') return;
    expect(result.settings.appAttest.appId).toBe('ABCDE12345.com.example.kilo');
    expect(result.settings.appAttest.rootCertificate).toBe(APPLE_APP_ATTEST_ROOT);
    expect(result.settings.play.endpoints).toBe(GOOGLE_PLAY_INTEGRITY_ENDPOINTS);
    expect(result.settings.play.expectation.certificateDigests).toHaveLength(2);
    expect(result.settings.appAttest.environments).toEqual(
      environment === 'development' ? ['production', 'development'] : ['production']
    );
  });

  it.each(ENVIRONMENTS)('refuses the client in %s when one value is missing', environment => {
    const names = [
      'ATTEST_APPLE_TEAM_ID',
      'ATTEST_APPLE_BUNDLE_ID',
      'ATTEST_PLAY_INTEGRITY_PACKAGE_NAME',
      'ATTEST_PLAY_INTEGRITY_CERT_DIGESTS',
      'ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY',
    ] as const;
    for (const name of names) {
      const partial: Settings = { ...complete, [name]: undefined };
      expect(policy(partial, environment)).toEqual({ kind: 'refused', problems: [name] });
    }
  });

  it.each([
    ['a team id that is not 10 characters', 'ATTEST_APPLE_TEAM_ID', 'ABC'],
    ['a bundle id that is no reverse domain', 'ATTEST_APPLE_BUNDLE_ID', 'kilo app'],
    ['a key that is not JSON', 'ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY', '{not json'],
    [
      'a key of another type',
      'ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY',
      JSON.stringify({ type: 'authorized_user', client_email: 'a@example.com' }),
    ],
    ['a digest that is not SHA-256', 'ATTEST_PLAY_INTEGRITY_CERT_DIGESTS', 'abcd'],
    ['an empty digest in the list', 'ATTEST_PLAY_INTEGRITY_CERT_DIGESTS', `${'ab'.repeat(32)},`],
  ] as const)('refuses the client with %s, naming the var and no value', (_name, name, value) => {
    const result = policy({ ...complete, [name]: value }, 'production');
    expect(result).toEqual({ kind: 'refused', problems: [name] });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it('accepts development stand-ins only in development', () => {
    const dev = {
      ...complete,
      ATTEST_DEV_ENDPOINTS: JSON.stringify({
        appleRootCertificate: Buffer.from([0x30, 0x00]).toString('base64'),
        playIntegrityOrigin: 'http://127.0.0.1:9491',
      }),
    };
    const development = policy(dev, 'development');
    expect(development.kind).toBe('verified');
    if (development.kind === 'verified') {
      expect(development.settings.play.endpoints).toEqual({
        tokenUri: 'http://127.0.0.1:9491/token',
        apiBase: 'http://127.0.0.1:9491/v1',
      });
      expect(development.settings.appAttest.rootCertificate).toEqual(new Uint8Array([0x30, 0x00]));
    }
    for (const environment of ['staging', 'production'] as const) {
      expect(policy(dev, environment)).toEqual({
        kind: 'refused',
        problems: ['ATTEST_DEV_ENDPOINTS'],
      });
    }
  });

  it('refuses a development stand-in that is not on a loopback origin', () => {
    const dev = {
      ...complete,
      ATTEST_DEV_ENDPOINTS: JSON.stringify({
        appleRootCertificate: 'MAA=',
        playIntegrityOrigin: 'https://playintegrity.example.com',
      }),
    };
    expect(policy(dev, 'development')).toEqual({
      kind: 'refused',
      problems: ['ATTEST_DEV_ENDPOINTS'],
    });
  });

  it('refuses the client in development as soon as any value is set', () => {
    expect(policy({ ATTEST_APPLE_TEAM_ID: 'ABCDE12345' }, 'development')).toMatchObject({
      kind: 'refused',
    });
  });

  it.each(ENVIRONMENTS)(
    'serves the client in %s with a retryable answer while STS gives no bundle',
    environment => {
      expect(policy(complete, environment, { status: 'unavailable' })).toEqual({
        kind: 'unavailable',
      });
    }
  );

  it('keeps the off answer of each environment while STS gives no bundle and no var is set', () => {
    const unavailable: UtsSecrets = { status: 'unavailable' };
    expect(policy({}, 'production', unavailable)).toEqual({ kind: 'refused', problems: [] });
    expect(policy({}, 'development', unavailable)).toEqual({ kind: 'unattested_development' });
  });

  it('keeps attestation off while none of its vars is set, whatever the bundle holds', () => {
    // The bundle delivers the key while no var is set: the vars are the switch, so attestation
    // stays off and the client is not refused for a method this environment has not turned on.
    const delivered = { ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: serviceAccountKey };
    expect(policy(delivered, 'staging')).toEqual({ kind: 'refused', problems: [] });
    expect(policy(delivered, 'development')).toEqual({ kind: 'unattested_development' });
  });

  it('reads the key from the secrets, never from the vars', () => {
    const { ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: key, ...vars } = complete;
    const onlyInVars = { ...vars, ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY: key };
    expect(
      attestationPolicy(readAttestationConfig(onlyInVars, secretsOf(), 'production'), 'production')
    ).toEqual({ kind: 'refused', problems: ['ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY'] });
  });
});
