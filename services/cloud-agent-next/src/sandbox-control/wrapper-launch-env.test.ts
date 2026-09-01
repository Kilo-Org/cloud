import { describe, expect, it } from 'vitest';
import { buildControlWrapperLaunchEnv } from './wrapper-launch-env.js';
import { validateControlLogUploadGrant } from './log-upload-grant.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../shared/runtime-environment.js';

describe('buildControlWrapperLaunchEnv', () => {
  it('issues a separate log-only grant and archive identity for each launch', () => {
    const input = {
      workerUrl: 'https://worker.example.com',
      sandboxId: 'sandbox_test',
      credential: 'control-credential',
      diagnostics: { allocationId: 'allocation_test', signingSecret: 'test-secret' },
    };
    const first = buildControlWrapperLaunchEnv(input);
    const second = buildControlWrapperLaunchEnv(input);
    const identity = validateControlLogUploadGrant(
      `Bearer ${first.CONTROL_LOG_UPLOAD_GRANT}`,
      'test-secret'
    );
    expect(identity).toEqual({
      sandboxId: input.sandboxId,
      allocationId: input.diagnostics.allocationId,
      wrapperInstanceId: first.CONTROL_WRAPPER_INSTANCE_ID,
    });
    expect(first.CONTROL_LOG_UPLOAD_URL).toBe(
      `https://worker.example.com/sandbox-logs/sandbox_test/allocation_test/${first.CONTROL_WRAPPER_INSTANCE_ID}`
    );
    expect(first.CONTROL_WRAPPER_INSTANCE_ID).not.toBe(second.CONTROL_WRAPPER_INSTANCE_ID);
    expect(first.CONTROL_LOG_UPLOAD_GRANT).not.toContain(input.credential);
    expect(first.CONTROL_LOG_UPLOAD_URL).not.toContain(first.CONTROL_LOG_UPLOAD_GRANT);
    for (const key of [
      'CONTROL_LOG_UPLOAD_URL',
      'CONTROL_LOG_UPLOAD_GRANT',
      'CONTROL_WRAPPER_INSTANCE_ID',
    ]) {
      expect(CONTROL_RUNTIME_RESERVED_ENV_VARS).toContain(key);
    }
  });

  it.each([null, ''])('does not break startup without a signing secret: %s', signingSecret => {
    const env = buildControlWrapperLaunchEnv({
      workerUrl: 'https://worker.example.com',
      sandboxId: 'sandbox_test',
      credential: 'control',
      diagnostics: { allocationId: 'allocation_test', signingSecret },
    });
    expect(env.CONTROL_LOG_UPLOAD_GRANT).toBeUndefined();
    expect(env.SANDBOX_CONTROL_CREDENTIAL).toBe('control');
  });

  it('does not put credentials into an invalid upload URL', () => {
    const env = buildControlWrapperLaunchEnv({
      workerUrl: 'https://worker.example.com?token=private',
      sandboxId: 'sandbox_test',
      credential: 'control',
      diagnostics: { allocationId: 'allocation_test', signingSecret: 'test-secret' },
    });
    expect(env.CONTROL_LOG_UPLOAD_GRANT).toBeUndefined();
    expect(env.CONTROL_LOG_UPLOAD_URL).toBeUndefined();
  });

  it('keeps Kilo and SCM credentials out of the wrapper bootstrap environment', () => {
    const input = {
      workerUrl: 'https://worker.example.com/',
      sandboxId: 'sbx_1',
      credential: 'control-credential',
      kiloToken: 'test-kilo-secret',
      kiloTargets: {
        backendBaseUrl: 'https://backend.example.com',
        providerBaseUrl: 'https://provider.example.com/api',
        sessionIngestBaseUrl: 'https://ingest.example.com',
      },
      githubTokenPlaceholder: 'github-placeholder',
      kiloTargetEnv: {
        KILO_OPENROUTER_BASE: 'https://fallback.example.com/api',
        GH_TOKEN: 'test-github-secret',
        GITHUB_TOKEN: 'test-github-secret',
        GITLAB_TOKEN: 'test-gitlab-secret',
        BITBUCKET_TOKEN: 'test-bitbucket-secret',
      },
    };

    expect(buildControlWrapperLaunchEnv(input)).toEqual({
      SANDBOX_CONTROL_URL: 'wss://worker.example.com/sandbox-control/sbx_1',
      SANDBOX_CONTROL_CREDENTIAL: input.credential,
      PROVIDER_INSTANCE_ID: input.sandboxId,
      KILO_PLATFORM: 'cloud-agent',
      KILO_DISABLE_AUTOUPDATE: 'true',
      KILO_DEBUG_SESSION_INGEST: '1',
    });
  });

  it.each([
    { workerUrl: undefined, expectedBase: '' },
    {
      workerUrl: 'https://worker.example.com/agent/',
      expectedBase: 'wss://worker.example.com/agent',
    },
    {
      workerUrl: 'http://127.0.0.1:8794/agent/',
      expectedBase: 'ws://127.0.0.1:8794/agent',
    },
  ])('builds a credential-free control URL from $workerUrl', ({ workerUrl, expectedBase }) => {
    const env = buildControlWrapperLaunchEnv({
      workerUrl,
      sandboxId: 'sbx/one?key=value#part',
      credential: 'control-credential',
    });

    expect(env.SANDBOX_CONTROL_URL).toBe(
      `${expectedBase}/sandbox-control/sbx%2Fone%3Fkey%3Dvalue%23part`
    );
  });
});
