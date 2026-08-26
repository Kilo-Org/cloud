import { describe, expect, it, vi } from 'vitest';
import { VercelSandboxRestError } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { VercelSandboxRuntimeConfig } from '../agent-sandbox/vercel/vercel-runtime-config.js';
import {
  createVercelProviderAdapter,
  decodeVercelProviderRef,
  encodeVercelProviderRef,
  type VercelControlRestClient,
} from './vercel-provider.js';

const config: VercelSandboxRuntimeConfig = {
  accessToken: 'token',
  teamId: 'team_1',
  projectId: 'prj_1',
  snapshotId: 'snap_1',
  runtimeBuildId: 'build_1',
  runtime: 'node24',
  initialTimeoutMs: 300_000,
  extendDurationMs: 120_000,
};

const runningSession = {
  id: 'vsess_1',
  sourceSandboxName: 'ses-abc',
  projectId: 'prj_1',
  runtime: 'node24',
  status: 'running' as const,
  memory: 2048,
  vcpus: 2,
  region: 'iad1',
  timeout: 300_000,
  requestedAt: 1_000,
  startedAt: 1_000,
  cwd: '/',
  createdAt: 1_000,
  updatedAt: 1_000,
};

function fakeClient(overrides: Partial<VercelControlRestClient> = {}): VercelControlRestClient {
  return {
    createSandbox: async () => ({
      sandbox: {
        name: 'ses-abc',
        currentSessionId: 'vsess_1',
        status: 'running',
        persistent: false,
        createdAt: 1,
        updatedAt: 1,
        tags: {},
      },
      session: runningSession,
      routes: [],
      runtime: { sandboxName: 'ses-abc', sessionId: 'vsess_1' },
    }),
    getSession: async () => ({ session: runningSession, routes: [] }),
    executeCommand: async () => ({
      id: 'cmd_1',
      name: 'sh',
      args: ['-lc', 'exec bun run /usr/local/bin/kilocode-control-wrapper.js'],
      cwd: '/',
      sessionId: 'vsess_1',
      exitCode: null,
      startedAt: 1,
    }),
    extendSessionTimeout: async () => runningSession,
    stopSession: async () => ({ ...runningSession, status: 'stopped' as const }),
    readFile: async () => new TextEncoder().encode('wrapper log'),
    ...overrides,
  };
}

describe('vercel provider adapter', () => {
  it('creates a sandbox, starts the control wrapper, and returns an opaque ref', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      id: 'cmd_1',
      name: 'sh',
      args: [],
      cwd: '/',
      sessionId: 'vsess_1',
      exitCode: null,
      startedAt: 1,
    });
    const provider = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient({ executeCommand }),
    });
    const created = await provider.create({
      intentId: 'op_1',
      env: {
        SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/ses-abc',
        SANDBOX_CONTROL_CREDENTIAL: 'secret',
        PROVIDER_INSTANCE_ID: 'ses-abc',
      },
    });
    expect(created).toEqual({
      providerRef: encodeVercelProviderRef({ sandboxName: 'ses-abc', sessionId: 'vsess_1' }),
    });
    expect(executeCommand).toHaveBeenCalledWith(
      'vsess_1',
      expect.objectContaining({
        command: 'sh',
        wait: false,
        env: expect.objectContaining({
          SANDBOX_CONTROL_CREDENTIAL: 'secret',
          PROVIDER_INSTANCE_ID: encodeVercelProviderRef({
            sandboxName: 'ses-abc',
            sessionId: 'vsess_1',
          }),
          WRAPPER_LOG_PATH: '/tmp/kilocode-control-wrapper.log',
        }),
      })
    );
    expect(String(executeCommand.mock.calls[0]?.[1].args[1])).toContain(
      'kilocode-control-wrapper.js'
    );
    expect(String(executeCommand.mock.calls[0]?.[1].args[1])).not.toContain('kilocode-wrapper.js');
  });

  it('returns the instance ref even when the control wrapper fails to start', async () => {
    const provider = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient({
        executeCommand: async () => {
          throw new VercelSandboxRestError('request_failed', 'execute-command', 500);
        },
      }),
    });
    await expect(
      provider.create({ intentId: 'op_1', env: { SANDBOX_CONTROL_CREDENTIAL: 'secret' } })
    ).resolves.toEqual({
      providerRef: encodeVercelProviderRef({ sandboxName: 'ses-abc', sessionId: 'vsess_1' }),
    });
  });

  it('maps running to active, 404 to terminal, and other failures to unknown', async () => {
    const provider = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient(),
    });
    const ref = encodeVercelProviderRef({ sandboxName: 'ses-abc', sessionId: 'vsess_1' });
    await expect(provider.observe(ref)).resolves.toBe('active');
    await expect(provider.observe(null)).resolves.toBe('terminal');
    await expect(provider.observe('not-json')).resolves.toBe('unknown');

    const missing = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient({
        getSession: async () => {
          throw new VercelSandboxRestError('request_failed', 'get-session', 404);
        },
      }),
    });
    await expect(missing.observe(ref)).resolves.toBe('terminal');

    const flaky = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient({
        getSession: async () => {
          throw new VercelSandboxRestError('request_failed', 'get-session');
        },
      }),
    });
    await expect(flaky.observe(ref)).resolves.toBe('unknown');
  });

  it('stop is terminal on 404 or stopped, retryable otherwise', async () => {
    const ref = encodeVercelProviderRef({ sandboxName: 'ses-abc', sessionId: 'vsess_1' });
    const stopSession = vi.fn().mockResolvedValue({ ...runningSession, status: 'stopped' });
    const stopped = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient({ stopSession }),
    });
    await expect(stopped.stop(ref)).resolves.toBe('terminal');
    await expect(stopped.stop(null)).resolves.toBe('terminal');
    await expect(stopped.stop('not-json')).resolves.toBe('retryable');
    expect(stopSession).toHaveBeenCalledTimes(1);

    const gone = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient({
        stopSession: async () => {
          throw new VercelSandboxRestError('request_failed', 'stop-session', 404);
        },
      }),
    });
    await expect(gone.stop(ref)).resolves.toBe('terminal');

    const busy = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient({
        stopSession: async () => {
          throw new VercelSandboxRestError('request_failed', 'stop-session', 500);
        },
      }),
    });
    await expect(busy.stop(ref)).resolves.toBe('retryable');
  });

  it('extends the lease only when remaining lifetime is below the requested floor', async () => {
    const extendSessionTimeout = vi.fn().mockResolvedValue(runningSession);
    const provider = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient({ extendSessionTimeout }),
      now: () => 1_000 + 250_000,
    });
    const ref = encodeVercelProviderRef({ sandboxName: 'ses-abc', sessionId: 'vsess_1' });
    await provider.ensureLeaseAtLeast(ref, 60_000);
    expect(extendSessionTimeout).toHaveBeenCalledWith('vsess_1', 'ses-abc', 120_000);

    extendSessionTimeout.mockClear();
    const plenty = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient({ extendSessionTimeout }),
      now: () => 1_000 + 10_000,
    });
    await plenty.ensureLeaseAtLeast(ref, 60_000);
    expect(extendSessionTimeout).not.toHaveBeenCalled();
  });

  it('reads wrapper logs without throwing', async () => {
    const provider = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config,
      restClient: fakeClient(),
    });
    const ref = encodeVercelProviderRef({ sandboxName: 'ses-abc', sessionId: 'vsess_1' });
    await expect(provider.logs(ref)).resolves.toBe('wrapper log');
  });

  it('round-trips the opaque provider ref', () => {
    const encoded = encodeVercelProviderRef({ sandboxName: 'ses-abc', sessionId: 'vsess_1' });
    expect(decodeVercelProviderRef(encoded)).toEqual({
      sandboxName: 'ses-abc',
      sessionId: 'vsess_1',
    });
    expect(decodeVercelProviderRef(null)).toBeNull();
    expect(decodeVercelProviderRef('{"sandboxName":1}')).toBeNull();
  });
});
