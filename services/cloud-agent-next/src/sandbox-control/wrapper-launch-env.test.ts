import { describe, expect, it } from 'vitest';
import { buildControlWrapperLaunchEnv } from './wrapper-launch-env.js';

const input = {
  workerUrl: 'https://worker.example.com',
  sandboxId: 'sbx-test',
  provider: 'cloudflare' as const,
  credential: 'control-credential',
};
const trustedDsn = 'https://0123456789abcdef@o123.ingest.sentry.io/456';

describe('buildControlWrapperLaunchEnv Sentry configuration', () => {
  it('passes only validated trusted configuration alongside the existing launch environment', () => {
    const env = buildControlWrapperLaunchEnv({
      ...input,
      sentry: {
        CLOUD_AGENT_SENTRY_DSN: trustedDsn,
        CLOUD_AGENT_SENTRY_ENVIRONMENT: 'production',
      },
    });

    expect(env).toMatchObject({
      CLOUD_AGENT_SENTRY_DSN: trustedDsn,
      CLOUD_AGENT_SENTRY_ENVIRONMENT: 'production',
      SANDBOX_CONTROL_CREDENTIAL: input.credential,
      PROVIDER_INSTANCE_ID: input.sandboxId,
      KILO_PLATFORM: 'cloud-agent',
      KILO_DISABLE_AUTOUPDATE: 'true',
    });
    expect(env).not.toHaveProperty('SENTRY_DSN');
    expect(env).not.toHaveProperty('SENTRY_ENVIRONMENT');
  });

  it.each([undefined, {}, { CLOUD_AGENT_SENTRY_DSN: 'http://key@o123.ingest.sentry.io/456' }])(
    'omits telemetry when trusted configuration is absent or invalid: %j',
    sentry => {
      const forged = {
        ...input,
        CLOUD_AGENT_SENTRY_DSN: 'https://attacker@evil.example.com/123',
        CLOUD_AGENT_SENTRY_ENVIRONMENT: 'forged',
        envVars: { CLOUD_AGENT_SENTRY_DSN: 'https://attacker@evil.example.com/123' },
        sentry,
      };
      const env = buildControlWrapperLaunchEnv(forged);

      expect(env).not.toHaveProperty('CLOUD_AGENT_SENTRY_DSN');
      expect(env).not.toHaveProperty('CLOUD_AGENT_SENTRY_ENVIRONMENT');
      expect(env).toEqual(buildControlWrapperLaunchEnv(input));
    }
  );

  it('does not spread unrelated trusted Worker bindings into the launch environment', () => {
    const sentry = {
      CLOUD_AGENT_SENTRY_DSN: trustedDsn,
      CLOUD_AGENT_SENTRY_ENVIRONMENT: 'production',
      SENTRY_AUTH_TOKEN: 'upload-only-token',
      NEXTAUTH_SECRET: 'worker-only-secret',
    };
    const env = buildControlWrapperLaunchEnv({ ...input, sentry });

    expect(env).not.toHaveProperty('SENTRY_AUTH_TOKEN');
    expect(env).not.toHaveProperty('NEXTAUTH_SECRET');
  });
});
