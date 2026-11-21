import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildFrameEnv } from '../control-plane/sandbox/frame-env.js';
import { validateControlSessionOptions } from '../sandbox-session/attach-payload.js';
import { envVarsSchema } from '../types.js';
import { encryptWithPublicKey } from '../utils/encryption.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../shared/runtime-environment.js';

describe('cloud-agent Sentry reserved environment names', () => {
  it.each(['CLOUD_AGENT_SENTRY_DSN', 'CLOUD_AGENT_SENTRY_ENVIRONMENT'])(
    'rejects user profile configuration for %s',
    key => {
      expect(CONTROL_RUNTIME_RESERVED_ENV_VARS).toContain(key);
      expect(envVarsSchema.safeParse({ [key]: 'forged' }).success).toBe(false);
      expect(() =>
        validateControlSessionOptions({ profile: { envVars: { [key]: 'forged' } } })
      ).toThrow(`Reserved control runtime environment variable: ${key}`);
      expect(() =>
        validateControlSessionOptions({
          profile: {
            encryptedSecrets: {
              [key]: {
                encryptedData: 'not-decrypted',
                encryptedDEK: 'not-decrypted',
                algorithm: 'rsa-aes-256-gcm',
                version: 1,
              },
            },
          },
        })
      ).toThrow(`Reserved control runtime environment variable: ${key}`);
    }
  );

  it('keeps generic Sentry environment variables available to the user application', () => {
    expect(
      envVarsSchema.safeParse({
        SENTRY_DSN: 'https://application@application.example.com/123',
        SENTRY_ENVIRONMENT: 'application',
        SENTRY_AUTH_TOKEN: 'application-upload-token',
      }).success
    ).toBe(true);
  });

  it('strips decrypted persisted overrides without injecting telemetry into the session spec', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const result = buildFrameEnv({
      specEnv: { PUBLIC_VALUE: 'preserved' },
      encryptedSecrets: {
        CLOUD_AGENT_SENTRY_DSN: encryptWithPublicKey(
          'https://forged@evil.example.com/123',
          publicKey
        ),
        CLOUD_AGENT_SENTRY_ENVIRONMENT: encryptWithPublicKey('forged', publicKey),
        SENTRY_DSN: encryptWithPublicKey('application-dsn', publicKey),
      },
      privateKey,
    });

    expect(result.env).toEqual({ PUBLIC_VALUE: 'preserved', SENTRY_DSN: 'application-dsn' });
    expect(result.secretEnvKeys).toEqual(['SENTRY_DSN']);
  });
});
