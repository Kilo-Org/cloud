import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  buildControlWrapperLaunchEnv,
  type ControlWrapperLaunchEnvInput,
} from './wrapper-launch-env.js';
import {
  validateControlLogUploadGrant,
  validateSandboxTransferGrant,
} from './sandbox-transfer-grant.js';

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

const secret = 'launch-test-secret';
const sandboxId = 'sandbox_test';
const allocationId = 'allocation_test';

function build(overrides: Partial<ControlWrapperLaunchEnvInput> = {}) {
  return buildControlWrapperLaunchEnv({
    workerUrl: 'https://worker.example/',
    sandboxId,
    provider: 'cloudflare',
    credential: 'credential',
    diagnostics: { allocationId, signingSecret: secret },
    ...overrides,
  });
}

describe('buildControlWrapperLaunchEnv', () => {
  it('mints both transfer scopes and a legacy log grant with one wrapper identity', () => {
    const env = build();
    const wrapperInstanceId = env.CONTROL_WRAPPER_INSTANCE_ID;
    expect(wrapperInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.SANDBOX_TRANSFER_URL).toBe(
      `https://worker.example/sandbox-transfer/${sandboxId}/${allocationId}/${wrapperInstanceId}`
    );
    expect(env.CONTROL_LOG_UPLOAD_URL).toBe(
      `https://worker.example/sandbox-logs/${sandboxId}/${allocationId}/${wrapperInstanceId}`
    );

    const transfer = validateSandboxTransferGrant(`Bearer ${env.SANDBOX_TRANSFER_GRANT}`, secret);
    expect(transfer?.identity).toEqual({ sandboxId, allocationId, wrapperInstanceId });
    expect(transfer?.scopes).toEqual(['logs', 'workspace_artifacts']);

    expect(validateControlLogUploadGrant(`Bearer ${env.CONTROL_LOG_UPLOAD_GRANT}`, secret)).toEqual(
      { sandboxId, allocationId, wrapperInstanceId }
    );

    const legacy = jwt.decode(env.CONTROL_LOG_UPLOAD_GRANT) as Record<string, unknown>;
    expect(legacy.type).toBe('control_log_upload');
    const current = jwt.decode(env.SANDBOX_TRANSFER_GRANT) as Record<string, unknown>;
    expect(current.type).toBe('sandbox_transfer');
  });

  it('emits no transfer environment without a signing secret', () => {
    const env = build({ diagnostics: { allocationId, signingSecret: null } });
    expect(env).not.toHaveProperty('SANDBOX_TRANSFER_URL');
    expect(env).not.toHaveProperty('CONTROL_LOG_UPLOAD_URL');
    expect(env.SANDBOX_CONTROL_URL).toContain(`/sandbox-control/${sandboxId}`);
  });

  it('emits no transfer environment for an invalid worker origin', () => {
    const env = build({ workerUrl: 'ftp://worker.example' });
    expect(env).not.toHaveProperty('SANDBOX_TRANSFER_URL');
    expect(env).not.toHaveProperty('CONTROL_LOG_UPLOAD_GRANT');
  });
});
