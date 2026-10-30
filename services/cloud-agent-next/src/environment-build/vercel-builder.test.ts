import { describe, expect, it, vi } from 'vitest';
import {
  VercelSandboxRestError,
  type VercelSandboxSnapshot,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { vercelSnapshotBaseImage } from '../byoc/vercel-snapshot-compatibility.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import type { BuilderLifecycleState, VercelBuilderAllocation } from './builder-provider.js';
import {
  BuilderCreateUncertainError,
  BuilderRetryableError,
  BuilderStateInvalidError,
} from './builder-errors.js';
import {
  captureVercelBuilder,
  launchVercelBuilder,
  stopVercelBuilder,
  type VercelBuilderClient,
} from './vercel-builder.js';

const allocation: VercelBuilderAllocation = {
  provider: 'vercel',
  sandboxId: 'ses-envbuild-22222222222242228222222222222222',
  allocationId: '33333333-3333-4333-8333-333333333333',
  owner: { type: 'user', id: 'user-1' },
  target: {
    provider: 'vercel',
    credentialId: '44444444-4444-4444-8444-444444444444',
    teamId: 'team-1',
    projectId: 'project-1',
    runtimeBuildId: 'runtime-1',
    baseSnapshotId: 'snap-base',
    resources: { vcpus: 2, memory: 4096 },
  },
};

const runner = { url: 'https://worker.test/environment-build/test', credential: 'synthetic' };
const command = { argv: ['/bin/sh', '-c', 'download-selected-builder'], user: 'root' as const };
const START_MARKER = `--kilocode-envbuild-start=${allocation.allocationId}`;
const now = () => 1_800_000_000_000;
const afterSettle = () => now() + DEADLINE_MS.createSettle + 1;

function memoryState(initial: Record<string, unknown> = {}): BuilderLifecycleState {
  let value: unknown = initial;
  return {
    get: async () => value,
    set: async next => {
      value = next;
    },
    clear: async () => {
      value = undefined;
    },
  };
}

function snapshot(id: string, sourceSessionId = 'session-1'): VercelSandboxSnapshot {
  return {
    id,
    sourceSessionId,
    status: 'created',
    createdAt: now(),
  } as VercelSandboxSnapshot;
}

function createEnvelope(sessionId = 'session-1') {
  return {
    sandbox: { name: allocation.sandboxId, persistent: false },
    session: { id: sessionId },
  } as never;
}

function commandRecord(exitCode: number | null, args: string[] = [START_MARKER]) {
  return {
    id: 'command-1',
    name: '/bin/sh',
    args,
    cwd: '/',
    sessionId: 'session-1',
    exitCode,
    startedAt: now(),
  };
}

function client(overrides: Partial<Record<keyof VercelBuilderClient, unknown>> = {}) {
  return {
    inspectByName: vi.fn(async () => null),
    createSandbox: vi.fn(async () => createEnvelope()),
    executeCommand: vi.fn(async (_sessionId: string, input: { wait?: boolean }) =>
      input.wait ? { command: { exitCode: 0 }, finished: { exitCode: 0 } } : commandRecord(null)
    ),
    getSession: vi.fn(async () => ({ session: { status: 'running' } })),
    stopSession: vi.fn(async () => ({ status: 'stopped' })),
    createSnapshot: vi.fn(async () => snapshot('snap-env')),
    listCommands: vi.fn(async () => []),
    listSnapshots: vi.fn(async () => []),
    ...overrides,
  } as unknown as VercelBuilderClient;
}

describe('Vercel environment builder', () => {
  it('creates from the pinned base, delivers the runner and starts the main process as root', async () => {
    const rest = client();
    const state = memoryState();
    vi.mocked(rest.createSandbox).mockImplementation(async input => {
      expect(await state.get()).toMatchObject({
        createRequestedAt: now(),
        createExpiresAt: now() + input.timeoutMs + DEADLINE_MS.createSettle,
      });
      return createEnvelope();
    });
    await launchVercelBuilder({
      allocation,
      launch: { runner, deadlineAt: now() + 60_000 },
      state,
      client: rest,
      command,
      runtime: 'node24',
      initialTimeoutMs: 5 * 60_000,
      now,
    });

    expect(rest.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        name: allocation.sandboxId,
        operationId: allocation.allocationId,
        runtimeBuildId: 'runtime-1',
        runtime: 'node24',
        source: { type: 'snapshot', snapshotId: 'snap-base' },
        resources: { vcpus: 2, memory: 4096 },
      })
    );
    const delivery = vi.mocked(rest.executeCommand).mock.calls[0];
    expect(delivery?.[1]).toMatchObject({
      command: '/bin/sh',
      sudo: true,
      wait: true,
      env: { KILO_BUILDER_RUNNER: JSON.stringify(runner) },
    });
    const start = vi.mocked(rest.executeCommand).mock.calls[1];
    expect(start?.[1]).toMatchObject({
      command: '/bin/sh',
      args: ['-c', 'download-selected-builder', START_MARKER],
      env: {},
      sudo: true,
      wait: false,
    });
  });

  it('does not create twice when the create reply is lost, then fails after the settle bound', async () => {
    const rest = client({
      createSandbox: vi.fn(async () => {
        throw new TypeError('network');
      }),
    });
    const state = memoryState();
    const launch = (time: number) =>
      launchVercelBuilder({
        allocation,
        launch: { runner, deadlineAt: now() + 60_000 },
        state,
        client: rest,
        command,
        runtime: 'node24',
        initialTimeoutMs: 5 * 60_000,
        now: () => time,
      });

    await expect(launch(now())).rejects.toBeInstanceOf(BuilderRetryableError);
    await expect(launch(now() + 1)).rejects.toBeInstanceOf(BuilderRetryableError);
    await expect(launch(afterSettle())).rejects.toBeInstanceOf(BuilderCreateUncertainError);
    expect(rest.createSandbox).toHaveBeenCalledTimes(1);
  });

  it('reconciles an ambiguous start through the command marker without starting twice', async () => {
    let startAttempts = 0;
    const rest = client({
      inspectByName: vi.fn(async () => createEnvelope()),
      executeCommand: vi.fn(async (_sessionId: string, input: { wait?: boolean }) => {
        if (input.wait) return { command: { exitCode: 0 }, finished: { exitCode: 0 } };
        startAttempts += 1;
        if (startAttempts === 1) throw new TypeError('network');
        return commandRecord(null);
      }),
    });
    const state = memoryState({ sessionId: 'session-1' });
    const launch = () =>
      launchVercelBuilder({
        allocation,
        launch: { runner, deadlineAt: now() + 60_000 },
        state,
        client: rest,
        command,
        runtime: 'node24',
        initialTimeoutMs: 5 * 60_000,
        now,
      });

    await expect(launch()).rejects.toBeInstanceOf(BuilderRetryableError);
    vi.mocked(rest.listCommands).mockResolvedValue([commandRecord(null)]);
    await launch();
    expect(startAttempts).toBe(1);
    expect(await state.get()).toMatchObject({ started: true });
  });

  it('fails a start whose command exited before the builder reported ready', async () => {
    const rest = client({
      inspectByName: vi.fn(async () => createEnvelope()),
      listCommands: vi.fn(async () => [commandRecord(1)]),
    });
    const state = memoryState({ sessionId: 'session-1', startRequestedAt: now() });
    await expect(
      launchVercelBuilder({
        allocation,
        launch: { runner, deadlineAt: now() + 60_000 },
        state,
        client: rest,
        command,
        runtime: 'node24',
        initialTimeoutMs: 5 * 60_000,
        now,
      })
    ).rejects.toThrow('exited before reporting ready');
  });

  it('adopts a snapshot created before a lost capture reply instead of capturing again', async () => {
    const state = memoryState({ sessionId: 'session-1' });
    const rest = client({
      createSnapshot: vi.fn(async () => {
        throw new TypeError('network');
      }),
    });
    await expect(
      captureVercelBuilder({
        allocation,
        captureId: 'capture',
        state,
        client: rest,
        runtime: 'node24',
        now,
      })
    ).rejects.toBeInstanceOf(BuilderRetryableError);

    vi.mocked(rest.listSnapshots).mockResolvedValue([snapshot('snap-adopted')]);
    const result = await captureVercelBuilder({
      allocation,
      captureId: 'capture',
      state,
      client: rest,
      runtime: 'node24',
      now,
    });
    expect(rest.createSnapshot).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'stored',
      snapshotId: 'snap-adopted',
      baseImage: vercelSnapshotBaseImage(allocation.target),
    });
  });

  it('fails capture once a requested snapshot misses the settle bound', async () => {
    const state = memoryState({
      sessionId: 'session-1',
      captureRequestedAt: now(),
      captureStartedAt: now(),
    });
    const rest = client();
    await expect(
      captureVercelBuilder({
        allocation,
        captureId: 'capture',
        state,
        client: rest,
        runtime: 'node24',
        now: afterSettle,
      })
    ).resolves.toEqual({ status: 'failed', reason: 'uncertain' });
  });

  it('does not declare stop terminal while a create may still land', async () => {
    const state = memoryState({ createRequestedAt: now() });
    const rest = client();
    const open = async () => ({
      client: rest,
      runtime: 'node24' as const,
      initialTimeoutMs: 300_000,
    });
    expect(await stopVercelBuilder({ allocation, state, open, now })).toBe('retryable');
    expect(await stopVercelBuilder({ allocation, state, open, now: afterSettle })).toBe('terminal');
  });

  it('fails closed on invalid lifecycle state', async () => {
    const state = memoryState({ createRequestedAt: 'not-a-number' });
    await expect(
      launchVercelBuilder({
        allocation,
        launch: { runner, deadlineAt: now() + 60_000 },
        state,
        client: client(),
        command,
        runtime: 'node24',
        initialTimeoutMs: 5 * 60_000,
        now,
      })
    ).rejects.toBeInstanceOf(BuilderStateInvalidError);
  });

  it('stops the builder session and clears non-secret lifecycle state', async () => {
    const state = memoryState({ sessionId: 'session-1' });
    const rest = client();
    const open = async () => ({
      client: rest,
      runtime: 'node24' as const,
      initialTimeoutMs: 300_000,
    });
    expect(await stopVercelBuilder({ allocation, state, open, now })).toBe('terminal');
    expect(rest.stopSession).toHaveBeenCalledWith('session-1', allocation.sandboxId);
    expect(await state.get()).toBeUndefined();
  });

  it('retains lifecycle state while the provider only reports stopping', async () => {
    const state = memoryState({ sessionId: 'session-1' });
    const rest = client({
      getSession: vi.fn(async () => ({ session: { status: 'stopping' } })),
      stopSession: vi.fn(async () => ({ status: 'stopping' })),
    });
    const open = async () => ({
      client: rest,
      runtime: 'node24' as const,
      initialTimeoutMs: 300_000,
    });

    expect(await stopVercelBuilder({ allocation, state, open, now })).toBe('retryable');
    expect(await state.get()).toMatchObject({ sessionId: 'session-1' });

    vi.mocked(rest.getSession).mockResolvedValue({ session: { status: 'stopped' } } as never);
    expect(await stopVercelBuilder({ allocation, state, open, now })).toBe('terminal');
    expect(await state.get()).toBeUndefined();
  });

  it('does not clear lifecycle state before a just-stopping provider reaches terminal', async () => {
    const state = memoryState({ sessionId: 'session-1' });
    const rest = client({
      stopSession: vi.fn(async () => ({ status: 'stopping' })),
    });
    const open = async () => ({
      client: rest,
      runtime: 'node24' as const,
      initialTimeoutMs: 300_000,
    });

    expect(await stopVercelBuilder({ allocation, state, open, now })).toBe('retryable');
    expect(await state.get()).toMatchObject({ sessionId: 'session-1' });
  });

  it('treats a missing builder session as terminal on 404', async () => {
    const state = memoryState({ sessionId: 'session-1' });
    const rest = client({
      getSession: vi.fn(async () => {
        throw new VercelSandboxRestError('request_failed', 'get-session', 404);
      }),
    });
    const open = async () => ({
      client: rest,
      runtime: 'node24' as const,
      initialTimeoutMs: 300_000,
    });

    expect(await stopVercelBuilder({ allocation, state, open, now })).toBe('terminal');
    expect(await state.get()).toBeUndefined();
  });

  it('clears a rate-limited capture request and retries within the deadline', async () => {
    const state = memoryState({ sessionId: 'session-1' });
    let attempts = 0;
    const rest = client({
      createSnapshot: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new VercelSandboxRestError('request_failed', 'create-snapshot', 429);
        }
        return snapshot('snap-retried');
      }),
    });

    await expect(
      captureVercelBuilder({
        allocation,
        captureId: 'capture',
        state,
        client: rest,
        runtime: 'node24',
        now,
      })
    ).rejects.toBeInstanceOf(BuilderRetryableError);
    expect(await state.get()).not.toHaveProperty('captureRequestedAt');

    const result = await captureVercelBuilder({
      allocation,
      captureId: 'capture',
      state,
      client: rest,
      runtime: 'node24',
      now,
    });
    expect(rest.createSnapshot).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'stored', snapshotId: 'snap-retried' });
  });
});
