import { describe, expect, it } from 'vitest';
import { buildControlWrapperLaunchEnv } from './wrapper-launch-env.js';

describe('buildControlWrapperLaunchEnv', () => {
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
