import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSandboxRuntimeContext } from '../protocol.js';
import { WRAPPER_VERSION } from '../../shared/wrapper-version.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { VercelAgentSandbox } from './vercel-agent-sandbox.js';
import type { VercelSandboxRuntimeConfig } from './vercel-runtime-config.js';
import type {
  VercelSandboxCommand,
  VercelSandboxRestClient,
} from './vercel-sandbox-rest-client.js';

const config: VercelSandboxRuntimeConfig = {
  accessToken: 'token',
  teamId: 'team',
  projectId: 'project',
  snapshotId: 'snapshot',
  runtimeBuildId: 'build',
  runtime: 'node24',
  initialTimeoutMs: 300_000,
  extendDurationMs: 600_000,
};

function metadata(runtime?: NonNullable<SessionMetadata['workspace']>['providerRuntime']) {
  return {
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_vercel', userId: 'user_vercel' },
    auth: {},
    workspace: {
      sandboxId: 'ses-abcdef',
      sandboxProvider: 'vercel',
      providerRuntime: runtime,
    },
    lifecycle: { version: 1, timestamp: 1 },
  } satisfies SessionMetadata;
}

function command(overrides: Partial<VercelSandboxCommand> = {}): VercelSandboxCommand {
  return {
    id: 'command-1',
    name: 'bun',
    args: ['run', '/usr/local/bin/kilocode-wrapper.js', 'kilo-launch:launch-1'],
    cwd: '/',
    sessionId: 'session-1',
    exitCode: null,
    startedAt: 1,
    ...overrides,
  };
}

function runtimeContext() {
  const context = {
    getCreateIntent: vi.fn().mockResolvedValue(undefined),
    beginCreate: vi.fn().mockResolvedValue({
      version: 1,
      sandboxName: 'ses-abcdef',
      operationId: 'operation-1',
      projectId: 'project',
      snapshotId: 'snapshot',
      runtimeBuildId: 'build',
      runtime: 'node24',
      startedAt: 1,
      settleUntil: 10_000,
      attempts: 1,
      nextRetryAt: 1,
    }),
    clearCreateIntent: vi.fn().mockResolvedValue(undefined),
    persistRuntimeOnce: vi.fn().mockResolvedValue(undefined),
    getWrapperLaunchIntent: vi.fn().mockResolvedValue(undefined),
    clearWrapperLaunchIntent: vi.fn().mockResolvedValue(undefined),
    beginWrapperLaunch: vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      launchId: 'launch-1',
      instanceId: 'instance-1',
      instanceGeneration: 2,
      startedAt: 1,
    }),
    persistWrapperProcessOnce: vi.fn().mockResolvedValue(undefined),
    clearWrapperProcess: vi.fn().mockResolvedValue(undefined),
    isDeletionPending: vi.fn().mockResolvedValue(false),
  } satisfies AgentSandboxRuntimeContext;
  return context;
}

function restClient() {
  return {
    createSandbox: vi.fn().mockResolvedValue({ session: { id: 'session-1' } }),
    inspectByName: vi.fn(),
    readFile: vi.fn().mockImplementation((_sessionId: string, path: string) =>
      Promise.resolve(
        new TextEncoder().encode(
          path.endsWith('runtime-manifest.json')
            ? JSON.stringify({
                runtimeBuildId: 'build',
                wrapperVersion: WRAPPER_VERSION,
                runtime: 'node24',
                bunVersion: '1.3.14',
                wrapperSha256: 'a'.repeat(64),
              })
            : `1.3.14\n${'a'.repeat(64)}\n`
        )
      )
    ),
    executeCommand: vi.fn().mockResolvedValue(command()),
    listCommands: vi.fn().mockResolvedValue([]),
    getCommand: vi.fn().mockResolvedValue(command()),
    killCommand: vi.fn().mockResolvedValue(command({ exitCode: 143 })),
    getSession: vi.fn().mockResolvedValue({ session: { status: 'running' }, routes: [] }),
    extendSessionTimeout: vi.fn(),
    stopSession: vi.fn(),
  };
}

function asRestClient(client: ReturnType<typeof restClient>): VercelSandboxRestClient {
  return client as unknown as VercelSandboxRestClient;
}

function ensureRequest() {
  return {
    leasedInstance: { instanceId: 'instance-1', instanceGeneration: 2 },
    plan: {},
    prepared: { context: { workspacePath: '/workspace' } },
  } as never;
}

describe('VercelAgentSandbox', () => {
  afterEach(() => vi.restoreAllMocks());

  it('persists create intent and exact runtime before validating and launching the wrapper', async () => {
    const context = runtimeContext();
    const client = restClient();
    const health = vi.fn().mockResolvedValue({
      healthy: true,
      version: WRAPPER_VERSION,
      wrapperInstanceId: 'instance-1',
      wrapperInstanceGeneration: 2,
    });
    const wrapperHealth = vi
      .spyOn(
        Object.getPrototypeOf(
          new VercelAgentSandbox(metadata(), config, context, { restClient: asRestClient(client) })
        ),
        'wrapperClient'
      )
      .mockReturnValue({ health });
    const sandbox = new VercelAgentSandbox(metadata(), config, context, {
      restClient: asRestClient(client),
    });

    await sandbox.ensureWrapper(ensureRequest());

    expect(context.beginCreate).toHaveBeenCalledOnce();
    expect(context.persistRuntimeOnce).toHaveBeenCalledWith({
      provider: 'vercel',
      sessionId: 'session-1',
      projectId: 'project',
      snapshotId: 'snapshot',
      runtimeBuildId: 'build',
      runtime: 'node24',
    });
    expect(client.readFile).toHaveBeenCalledWith(
      'session-1',
      '/usr/local/share/kilo/runtime-manifest.json',
      16 * 1024
    );
    expect(context.beginWrapperLaunch).toHaveBeenCalledBefore(context.persistWrapperProcessOnce);
    expect(client.executeCommand).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        wait: false,
        command: 'sh',
        args: ['-lc', expect.stringContaining('kilo-launch:launch-1')],
        env: expect.objectContaining({
          KILO_AGENT_SESSION_ID: 'agent_vercel',
          KILO_USER_ID: 'user_vercel',
        }),
      })
    );
    const launchEnv = vi.mocked(client.executeCommand).mock.calls[0]?.[1]?.env;
    expect(launchEnv).toBeDefined();
    expect(launchEnv).not.toHaveProperty('WORKSPACE_PATH');
    expect(context.persistWrapperProcessOnce).toHaveBeenCalledWith({
      sessionId: 'session-1',
      launchId: 'launch-1',
      commandId: 'command-1',
      instance: { instanceId: 'instance-1', instanceGeneration: 2 },
    });
    expect(health).toHaveBeenCalledOnce();
    wrapperHealth.mockRestore();
  });

  it('uses bounded exponential delays until wrapper health matches the persisted lease', async () => {
    const context = runtimeContext();
    const client = restClient();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const health = vi
      .fn()
      .mockRejectedValueOnce(new Error('wrapper is starting'))
      .mockResolvedValueOnce({
        healthy: true,
        version: WRAPPER_VERSION,
        wrapperInstanceId: 'instance-1',
        wrapperInstanceGeneration: 1,
      })
      .mockResolvedValueOnce({
        healthy: true,
        version: WRAPPER_VERSION,
        wrapperInstanceId: 'instance-1',
        wrapperInstanceGeneration: 2,
      });
    vi.spyOn(
      Object.getPrototypeOf(
        new VercelAgentSandbox(metadata(), config, context, { restClient: asRestClient(client) })
      ),
      'wrapperClient'
    ).mockReturnValue({ health });
    const sandbox = new VercelAgentSandbox(metadata(), config, context, {
      restClient: asRestClient(client),
      sleep,
    });

    await expect(sandbox.ensureWrapper(ensureRequest())).resolves.toMatchObject({
      status: 'wrapper-running',
    });
    expect(health).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it('limits wrapper readiness exhaustion to eight health transactions', async () => {
    const context = runtimeContext();
    const client = restClient();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const health = vi.fn().mockResolvedValue({
      healthy: true,
      version: 'stale-wrapper-version',
      wrapperInstanceId: 'instance-1',
      wrapperInstanceGeneration: 2,
    });
    vi.spyOn(
      Object.getPrototypeOf(
        new VercelAgentSandbox(metadata(), config, context, { restClient: asRestClient(client) })
      ),
      'wrapperClient'
    ).mockReturnValue({ health });
    const sandbox = new VercelAgentSandbox(metadata(), config, context, {
      restClient: asRestClient(client),
      sleep,
    });

    await expect(sandbox.ensureWrapper(ensureRequest())).rejects.toThrow(
      'Vercel wrapper did not report the persisted lease'
    );
    expect(health).toHaveBeenCalledTimes(8);
    expect(sleep.mock.calls).toEqual([[250], [500], [1_000], [2_000], [4_000], [8_000], [14_000]]);
  });

  it('recovers a lost launch only from one exact-session launch marker', async () => {
    const context = runtimeContext();
    context.getWrapperLaunchIntent.mockResolvedValue({
      sessionId: 'session-1',
      launchId: 'launch-1',
      instanceId: 'instance-1',
      instanceGeneration: 2,
      startedAt: 1,
    });
    const client = restClient();
    vi.mocked(client.listCommands).mockResolvedValue([command()]);
    const sandbox = new VercelAgentSandbox(
      metadata({ provider: 'vercel', sessionId: 'session-1' }),
      config,
      context,
      { restClient: asRestClient(client) }
    );

    await expect(
      (
        sandbox as unknown as {
          ensureWrapperCommand: (
            sessionId: string,
            instance: { instanceId: string; instanceGeneration: number }
          ) => Promise<VercelSandboxCommand>;
        }
      ).ensureWrapperCommand('session-1', { instanceId: 'instance-1', instanceGeneration: 2 })
    ).resolves.toMatchObject({ id: 'command-1' });
    expect(client.executeCommand).not.toHaveBeenCalled();
    expect(client.listCommands).toHaveBeenCalledWith('session-1');
  });

  it('does not launch from a cached runtime after deletion is fenced', async () => {
    const context = runtimeContext();
    context.isDeletionPending.mockResolvedValue(true);
    const client = restClient();
    const sandbox = new VercelAgentSandbox(
      metadata({ provider: 'vercel', sessionId: 'session-1' }),
      config,
      context,
      { restClient: asRestClient(client) }
    );

    await expect(sandbox.ensureWrapper(ensureRequest())).rejects.toThrow(
      'Vercel sandbox deletion is pending'
    );
    expect(client.readFile).not.toHaveBeenCalled();
    expect(client.executeCommand).not.toHaveBeenCalled();
  });

  it('fails closed on duplicate launch markers without starting another wrapper', async () => {
    const context = runtimeContext();
    context.getWrapperLaunchIntent.mockResolvedValue({
      sessionId: 'session-1',
      launchId: 'launch-1',
      instanceId: 'instance-1',
      instanceGeneration: 2,
      startedAt: 1,
    });
    const client = restClient();
    client.listCommands.mockResolvedValue([command(), command({ id: 'command-2' })]);
    const sandbox = new VercelAgentSandbox(
      metadata({ provider: 'vercel', sessionId: 'session-1' }),
      config,
      context,
      { restClient: asRestClient(client) }
    );

    await expect(sandbox.ensureWrapper(ensureRequest())).rejects.toThrow(
      'Vercel wrapper launch matched multiple commands'
    );
    expect(client.executeCommand.mock.calls.some(([, input]) => input.wait === false)).toBe(false);
    expect(context.persistWrapperProcessOnce).not.toHaveBeenCalled();
  });

  it('extends timeout only when the exact session approaches its watermark', async () => {
    const distantClient = restClient();
    distantClient.getSession.mockResolvedValue({
      session: { status: 'running', startedAt: 0, requestedAt: 0, timeout: 500_000 },
      routes: [],
    });
    const nearClient = restClient();
    nearClient.getSession.mockResolvedValue({
      session: { status: 'running', startedAt: 0, requestedAt: 0, timeout: 350_000 },
      routes: [],
    });
    const runtime = { provider: 'vercel' as const, sessionId: 'session-1' };

    await new VercelAgentSandbox(metadata(runtime), config, undefined, {
      restClient: asRestClient(distantClient),
      now: () => 100_000,
    }).keepAlive();
    await new VercelAgentSandbox(metadata(runtime), config, undefined, {
      restClient: asRestClient(nearClient),
      now: () => 100_000,
    }).keepAlive();

    expect(distantClient.extendSessionTimeout).not.toHaveBeenCalled();
    expect(nearClient.extendSessionTimeout).toHaveBeenCalledWith(
      'session-1',
      'ses-abcdef',
      600_000
    );
  });

  it('reconciles an unresolved launch before confirming wrapper cleanup', async () => {
    const context = runtimeContext();
    context.getWrapperLaunchIntent.mockResolvedValue({
      sessionId: 'session-1',
      launchId: 'launch-1',
      instanceId: 'instance-1',
      instanceGeneration: 2,
      startedAt: 1,
    });
    const client = restClient();
    client.listCommands.mockResolvedValue([command()]);
    client.getCommand
      .mockResolvedValueOnce(command())
      .mockResolvedValueOnce(command({ exitCode: 143 }));
    const sandbox = new VercelAgentSandbox(
      metadata({ provider: 'vercel', sessionId: 'session-1' }),
      config,
      context,
      { restClient: asRestClient(client), sleep: async () => undefined }
    );

    await expect(
      sandbox.stopWrappers({
        target: { kind: 'session' },
        attemptId: 'attempt-unresolved',
        reason: 'startup-failed',
      })
    ).resolves.toEqual({ status: 'absent', stoppedInstanceIds: ['instance-1'] });
    expect(context.persistWrapperProcessOnce).toHaveBeenCalledWith({
      sessionId: 'session-1',
      launchId: 'launch-1',
      commandId: 'command-1',
      instance: { instanceId: 'instance-1', instanceGeneration: 2 },
    });
    expect(client.killCommand).toHaveBeenCalledWith('session-1', 'command-1', 15);
  });

  it('does not stop a newer wrapper for a stale instance target', async () => {
    const context = runtimeContext();
    const client = restClient();
    const sandbox = new VercelAgentSandbox(
      metadata({
        provider: 'vercel',
        sessionId: 'session-1',
        wrapper: {
          launchId: 'launch-2',
          commandId: 'command-2',
          instanceId: 'instance-1',
          instanceGeneration: 3,
        },
      }),
      config,
      context,
      { restClient: asRestClient(client), sleep: async () => undefined }
    );

    await expect(
      sandbox.stopWrappers({
        target: {
          kind: 'instance',
          instance: { instanceId: 'instance-1', instanceGeneration: 2 },
        },
        attemptId: 'attempt-stale',
        reason: 'startup-failed',
      })
    ).resolves.toEqual({ status: 'absent' });
    expect(client.getCommand).not.toHaveBeenCalled();
    expect(client.killCommand).not.toHaveBeenCalled();
    expect(context.clearWrapperProcess).not.toHaveBeenCalled();
  });

  it('does not reconcile a newer unresolved launch for a stale instance target', async () => {
    const context = runtimeContext();
    context.getWrapperLaunchIntent.mockResolvedValue({
      sessionId: 'session-1',
      launchId: 'launch-2',
      instanceId: 'instance-1',
      instanceGeneration: 3,
      startedAt: 1,
    });
    const client = restClient();
    const sandbox = new VercelAgentSandbox(
      metadata({ provider: 'vercel', sessionId: 'session-1' }),
      config,
      context,
      { restClient: asRestClient(client), sleep: async () => undefined }
    );

    await expect(
      sandbox.stopWrappers({
        target: {
          kind: 'instance',
          instance: { instanceId: 'instance-1', instanceGeneration: 2 },
        },
        attemptId: 'attempt-stale-launch',
        reason: 'startup-failed',
      })
    ).resolves.toEqual({ status: 'absent' });
    expect(client.listCommands).not.toHaveBeenCalled();
    expect(context.persistWrapperProcessOnce).not.toHaveBeenCalled();
    expect(context.clearWrapperLaunchIntent).not.toHaveBeenCalled();
  });

  it('discovers and stops a matching instance target without stopping the VM', async () => {
    const context = runtimeContext();
    const client = restClient();
    vi.mocked(client.getCommand)
      .mockResolvedValueOnce(command())
      .mockResolvedValueOnce(command())
      .mockResolvedValueOnce(command({ exitCode: 143 }));
    const sandbox = new VercelAgentSandbox(
      metadata({
        provider: 'vercel',
        sessionId: 'session-1',
        wrapper: {
          launchId: 'launch-1',
          commandId: 'command-1',
          instanceId: 'instance-1',
          instanceGeneration: 2,
        },
      }),
      config,
      context,
      { restClient: asRestClient(client), sleep: async () => undefined }
    );

    await expect(sandbox.discoverSessionWrappers()).resolves.toMatchObject({ status: 'present' });
    await expect(
      sandbox.stopWrappers({
        target: {
          kind: 'instance',
          instance: { instanceId: 'instance-1', instanceGeneration: 2 },
        },
        attemptId: 'attempt-1',
        reason: 'idle-timeout',
      })
    ).resolves.toEqual({ status: 'absent', stoppedInstanceIds: ['instance-1'] });
    expect(client.killCommand).toHaveBeenCalledWith('session-1', 'command-1', 15);
    expect(client.stopSession).not.toHaveBeenCalled();
    expect(context.clearWrapperProcess).toHaveBeenCalledWith({
      sessionId: 'session-1',
      commandId: 'command-1',
    });
    await expect(sandbox.discoverSessionWrappers()).resolves.toEqual({ status: 'absent' });
    expect(client.getCommand).toHaveBeenCalledTimes(3);
  });

  it('keeps recovery delete from recreating, looking up by name, or deleting by name', async () => {
    const context = runtimeContext();
    const client = restClient();
    const sandbox = new VercelAgentSandbox(metadata(), config, context, {
      restClient: asRestClient(client),
    });

    await sandbox.delete('recovery');

    expect(context.beginCreate).not.toHaveBeenCalled();
    expect(client.inspectByName).not.toHaveBeenCalled();
    expect(client.stopSession).not.toHaveBeenCalled();
  });
});
