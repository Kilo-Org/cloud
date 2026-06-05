import { describe, expect, it, vi } from 'vitest';
import type { AgentSandbox } from '../agent-sandbox/protocol.js';
import type { Env } from '../types.js';
import type {
  FencedWrapperDispatchRequest,
  MessageDeliveryRequest,
  WorkspaceReady,
} from '../execution/types.js';
import { createAgentRuntime } from './agent-runtime.js';
import { getWrapperLease, getWrapperRuntimeState } from './wrapper-runtime-state.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

type MemoryRuntimeStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;

function createMemoryStorage(
  initialEntries?: Array<[string, unknown]>,
  onPut?: (key: string, value: unknown) => void
): MemoryRuntimeStorage & DurableObjectStorage {
  const store = new Map(initialEntries ?? []);
  return {
    async get<T = unknown>(key: string) {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      onPut?.(key, value);
      store.set(key, value);
    },
    async delete(keys: string | string[]) {
      let deleted = false;
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        deleted = store.delete(key) || deleted;
      }
      return deleted;
    },
  } as MemoryRuntimeStorage & DurableObjectStorage;
}

function createMetadata(): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'agent_runtime',
      userId: 'user_runtime',
    },
    auth: {
      kiloSessionId: 'kilo_runtime',
    },
    lifecycle: {
      version: 1,
      timestamp: 1,
    },
    workspace: {
      sandboxId: 'ses-runtime',
      workspacePath: '/workspace/runtime',
      sessionHome: '/home/agent_runtime',
      branchName: 'main',
    },
  } satisfies SessionMetadata;
}

function createPlan(metadata = createMetadata()): MessageDeliveryRequest {
  return {
    scope: {
      sessionId: 'agent_runtime',
      userId: 'user_runtime',
    },
    turn: {
      type: 'prompt',
      messageId: 'msg_018f1e2d3c4bRuntimeAbCdEfG',
      prompt: 'Ship the runtime boundary',
    },
    agent: {
      mode: 'code',
      model: 'runtime-model',
    },
    workspace: {
      sandboxId: 'ses-runtime',
      metadata,
    },
    wrapper: {
      kiloSessionId: 'kilo_runtime',
    },
  } satisfies MessageDeliveryRequest;
}

function createWorkspaceReady(): WorkspaceReady {
  return {
    workspacePath: '/workspace/runtime',
    sandboxId: 'ses-runtime',
    sessionHome: '/home/agent_runtime',
    branchName: 'main',
    kiloSessionId: 'kilo_runtime',
  };
}

describe('AgentRuntime', () => {
  it('preflights cold delivery, authorizes its physical lease, and returns the existing queue result shape', async () => {
    const storage = createMemoryStorage();
    const ready = createWorkspaceReady();
    const deliveredPlans: FencedWrapperDispatchRequest[] = [];
    const discoverSessionWrappers = vi.fn().mockResolvedValue({ status: 'absent' });
    const sandbox = {
      discoverSessionWrappers,
    } as unknown as AgentSandbox;
    const alarmDeadlines: number[] = [];
    const orchestrator = {
      execute: vi.fn(
        async (
          plan: FencedWrapperDispatchRequest,
          options?: {
            onProgress?: (step: string, message: string) => void;
            onWorkspaceReady?: (workspace: WorkspaceReady) => Promise<void>;
            leasedInstance?: { instanceId: string; instanceGeneration: number };
          }
        ) => {
          deliveredPlans.push(plan);
          expect(options?.leasedInstance).toMatchObject({ instanceGeneration: 1 });
          options?.onProgress?.('kilo_server', 'Starting Kilo...');
          await options?.onWorkspaceReady?.(ready);
          return { kiloSessionId: 'kilo_runtime' };
        }
      ),
    };
    const progress: Array<{ step: string; message: string }> = [];
    const workspaces: WorkspaceReady[] = [];
    const accepted: Array<{ acceptedAt: number; wrapperRunId: string }> = [];
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => orchestrator,
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
      requestAlarmAtOrBefore: async deadline => {
        alarmDeadlines.push(deadline);
      },
    });

    const result = await runtime.send(createPlan(), {
      onProgress: (step, message) => {
        progress.push({ step, message });
      },
      onWorkspaceReady: async workspace => {
        workspaces.push(workspace);
      },
      onAccepted: async delivery => {
        accepted.push(delivery);
      },
    });
    const wrapperState = await getWrapperRuntimeState(storage);
    const physicalLease = await getWrapperLease(storage);
    const [deliveredPlan] = deliveredPlans;

    expect(discoverSessionWrappers).toHaveBeenCalledOnce();
    expect(alarmDeadlines).toHaveLength(2);
    expect(physicalLease).toMatchObject({
      state: 'owns_wrapper',
      nextInstanceGeneration: 2,
      instance: { instanceGeneration: 1 },
    });
    expect(result).toMatchObject({
      success: true,
      outcome: 'accepted',
      messageId: 'msg_018f1e2d3c4bRuntimeAbCdEfG',
    });
    if (!result.success) return;
    expect(deliveredPlan?.wrapper.fence).toEqual({
      wrapperRunId: result.wrapperRunId,
      wrapperGeneration: wrapperState.wrapperGeneration,
      wrapperConnectionId: wrapperState.wrapperConnectionId,
    });
    expect(progress).toEqual([{ step: 'kilo_server', message: 'Starting Kilo...' }]);
    expect(workspaces).toEqual([ready]);
    expect(accepted).toEqual([
      {
        acceptedAt: expect.any(Number),
        wrapperRunId: result.wrapperRunId,
      },
    ]);
    expect(wrapperState.wrapperRunId).toBe(result.wrapperRunId);
    expect(wrapperState.wrapperIdleDeadlineAt).toBeUndefined();
    expect(wrapperState.noOutputDeadlineAt).toEqual(expect.any(Number));
    expect(wrapperState.nextPingAt).toEqual(expect.any(Number));
  });

  it('keeps an accepted new delivery supervised when physical lease acceptance persistence fails', async () => {
    let rejectedAcceptedLeaseWrite = false;
    const storage = createMemoryStorage(undefined, (key, value) => {
      const lease = value as { state?: string; startupDeadlineAt?: number };
      if (
        key === 'wrapper_lease' &&
        lease.state === 'owns_wrapper' &&
        lease.startupDeadlineAt === undefined &&
        !rejectedAcceptedLeaseWrite
      ) {
        rejectedAcceptedLeaseWrite = true;
        throw new Error('delivery_accepted lease write failed');
      }
    });
    const sandbox = {
      discoverSessionWrappers: vi.fn().mockResolvedValue({ status: 'absent' }),
    } as unknown as AgentSandbox;
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => ({
        execute: async (_plan, options) => {
          await options?.onWorkspaceReady?.(createWorkspaceReady());
          return { kiloSessionId: 'kilo_runtime' };
        },
      }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });
    const onAccepted = vi.fn().mockResolvedValue(undefined);

    await expect(runtime.send(createPlan(), { onAccepted })).resolves.toMatchObject({
      success: true,
      outcome: 'accepted',
    });

    expect(onAccepted).toHaveBeenCalledOnce();
    expect(rejectedAcceptedLeaseWrite).toBe(true);
    await expect(getWrapperRuntimeState(storage)).resolves.toMatchObject({
      wrapperConnectionId: expect.any(String),
      wrapperRunId: expect.any(String),
      noOutputDeadlineAt: expect.any(Number),
    });
    await expect(getWrapperLease(storage)).resolves.toMatchObject({
      state: 'owns_wrapper',
      startupDeadlineAt: expect.any(Number),
    });
  });

  it('preserves accepted-message liveness when a hot follow-up fails before acceptance', async () => {
    const storage = createMemoryStorage([
      [
        'wrapper_runtime_state',
        {
          wrapperGeneration: 3,
          wrapperConnectionId: 'conn_hot',
          wrapperRunId: 'wr_hot',
          noOutputDeadlineAt: 9_000,
          pingDeadlineAt: 8_000,
          nextPingAt: 7_000,
        },
      ],
      [
        'wrapper_lease',
        {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId: 'instance_hot', instanceGeneration: 1 },
        },
      ],
    ]);
    const discoverSessionWrappers = vi.fn().mockResolvedValue({
      status: 'present',
      observed: [
        {
          representation: 'process',
          id: 'wrapper-hot',
          port: 5_000,
          instanceId: 'instance_hot',
          instanceGeneration: 1,
        },
      ],
    });
    const sandbox = {
      discoverSessionWrappers,
    } as unknown as AgentSandbox;
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => ({
        execute: async () => {
          throw new Error('hot follow-up failed');
        },
      }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });

    await expect(runtime.send(createPlan())).rejects.toThrow('hot follow-up failed');

    expect(discoverSessionWrappers).toHaveBeenCalledOnce();
    await expect(getWrapperRuntimeState(storage)).resolves.toMatchObject({
      wrapperGeneration: 3,
      wrapperConnectionId: 'conn_hot',
      wrapperRunId: 'wr_hot',
      noOutputDeadlineAt: 9_000,
      pingDeadlineAt: 8_000,
      nextPingAt: 7_000,
    });
  });

  it('invalidates a warm idle physical wrapper when its reuse delivery fails', async () => {
    const storage = createMemoryStorage([
      [
        'wrapper_runtime_state',
        { wrapperGeneration: 4, wrapperConnectionId: 'conn_previous', wrapperRunId: 'wr_previous' },
      ],
      [
        'wrapper_lease',
        {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId: 'instance_warm', instanceGeneration: 1 },
          keepWarmUntil: Date.now() + 60_000,
        },
      ],
    ]);
    const sandbox = {
      discoverSessionWrappers: vi.fn().mockResolvedValue({
        status: 'present',
        observed: [
          {
            representation: 'process',
            id: 'wrapper-warm',
            port: 5_000,
            instanceId: 'instance_warm',
            instanceGeneration: 1,
          },
        ],
      }),
    } as unknown as AgentSandbox;
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => ({
        execute: async () => {
          throw new Error('warm readiness failed');
        },
      }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });

    await expect(runtime.send(createPlan())).rejects.toThrow('warm readiness failed');

    await expect(getWrapperLease(storage)).resolves.toMatchObject({
      state: 'stop_needed',
      target: { kind: 'instance', instance: { instanceId: 'instance_warm' } },
      reason: 'startup-failed',
    });
    await expect(getWrapperRuntimeState(storage)).resolves.not.toMatchObject({
      wrapperConnectionId: 'conn_previous',
      wrapperRunId: 'wr_previous',
    });
  });

  it('releases a verified-absent owned wrapper before allocating the next generation', async () => {
    const storage = createMemoryStorage([
      [
        'wrapper_runtime_state',
        {
          wrapperGeneration: 7,
          wrapperConnectionId: 'conn_stale',
          wrapperRunId: 'wr_stale',
        },
      ],
      [
        'wrapper_lease',
        {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId: 'instance_old', instanceGeneration: 1 },
        },
      ],
    ]);
    const sandbox = {
      discoverSessionWrappers: vi.fn().mockResolvedValue({ status: 'absent' }),
    } as unknown as AgentSandbox;
    const execute = vi.fn(async (_plan, options) => {
      expect(options?.leasedInstance).toMatchObject({ instanceGeneration: 2 });
      return { kiloSessionId: 'kilo_runtime' };
    });
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => ({ execute }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });

    await runtime.send(createPlan());

    await expect(getWrapperLease(storage)).resolves.toMatchObject({
      state: 'owns_wrapper',
      nextInstanceGeneration: 3,
      instance: { instanceGeneration: 2 },
    });
    await expect(getWrapperRuntimeState(storage)).resolves.not.toMatchObject({
      wrapperRunId: 'wr_stale',
      wrapperConnectionId: 'conn_stale',
    });
  });

  it('stores cleanup obligation when new delivery fails before readiness', async () => {
    const storage = createMemoryStorage();
    const sandbox = {
      discoverSessionWrappers: vi.fn().mockResolvedValue({ status: 'absent' }),
    } as unknown as AgentSandbox;
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => ({
        execute: async () => {
          throw new Error('wrapper unavailable');
        },
      }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });

    await expect(runtime.send(createPlan())).rejects.toThrow('wrapper unavailable');

    await expect(getWrapperLease(storage)).resolves.toMatchObject({
      state: 'stop_needed',
      target: { kind: 'instance', instance: { instanceGeneration: 1 } },
      reason: 'startup-failed',
    });
    await expect(getWrapperRuntimeState(storage)).resolves.toEqual({ wrapperGeneration: 2 });
  });

  it('stores cleanup obligation when a newly leased wrapper readies but its initial dispatch fails', async () => {
    const storage = createMemoryStorage();
    const sandbox = {
      discoverSessionWrappers: vi.fn().mockResolvedValue({ status: 'absent' }),
    } as unknown as AgentSandbox;
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => ({
        execute: async (_plan, options) => {
          await options?.onWorkspaceReady?.(createWorkspaceReady());
          throw new Error('initial prompt failed');
        },
      }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });

    await expect(runtime.send(createPlan())).rejects.toThrow('initial prompt failed');
    await expect(getWrapperLease(storage)).resolves.toMatchObject({
      state: 'stop_needed',
      target: { kind: 'instance', instance: { instanceGeneration: 1 } },
      reason: 'startup-failed',
    });
  });

  it.each([
    {
      observation: { status: 'inspection-failed', error: 'provider unavailable' },
      reason: 'observation-failed',
    },
    { observation: { status: 'present', observed: [] }, reason: 'unexpected-wrapper' },
  ])(
    'blocks cold launch after unsafe physical preflight ($reason)',
    async ({ observation, reason }) => {
      const storage = createMemoryStorage();
      const execute = vi.fn();
      const sandbox = {
        discoverSessionWrappers: vi.fn().mockResolvedValue(observation),
      } as unknown as AgentSandbox;
      const runtime = createAgentRuntime({
        storage,
        env: {} as Env,
        getMetadata: async () => createMetadata(),
        getOrchestratorOverride: () => ({ execute }),
        getSessionIdForLogs: () => 'agent_runtime',
        sendToWrapper: () => false,
        createAgentSandbox: () => sandbox,
      });

      await expect(runtime.send(createPlan())).rejects.toThrow(/cleanup is required/i);
      expect(execute).not.toHaveBeenCalled();
      await expect(getWrapperLease(storage)).resolves.toMatchObject({
        state: 'stop_needed',
        target: { kind: 'session' },
        reason,
      });
    }
  );

  it('does not overwrite cleanup requested while physical wrapper observation is in flight', async () => {
    const storage = createMemoryStorage();
    const execute = vi.fn();
    const sandbox = {
      discoverSessionWrappers: vi.fn().mockImplementation(async () => {
        await storage.put('wrapper_lease', {
          state: 'stop_needed',
          nextInstanceGeneration: 1,
          target: { kind: 'session' },
          reason: 'user-interrupt',
          requestedAt: 10_000,
          nextAttemptAt: 10_000,
          attempts: 0,
        });
        return { status: 'absent' };
      }),
    } as unknown as AgentSandbox;
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => ({ execute }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });

    await expect(runtime.send(createPlan())).rejects.toThrow(/cleanup is required/i);
    expect(execute).not.toHaveBeenCalled();
    await expect(getWrapperLease(storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'user-interrupt',
    });
  });

  it('reauthorizes when cleanup completes during physical wrapper observation', async () => {
    const storage = createMemoryStorage([
      [
        'wrapper_lease',
        {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId: 'instance_stale', instanceGeneration: 1 },
        },
      ],
    ]);
    const leasedInstances: Array<{ instanceId: string; instanceGeneration: number } | undefined> =
      [];
    const discoverSessionWrappers = vi
      .fn()
      .mockImplementationOnce(async () => {
        await storage.put('wrapper_lease', { state: 'none', nextInstanceGeneration: 2 });
        return {
          status: 'present',
          observed: [
            {
              representation: 'process',
              id: 'stale-wrapper',
              port: 5_000,
              instanceId: 'instance_stale',
              instanceGeneration: 1,
            },
          ],
        };
      })
      .mockResolvedValueOnce({ status: 'absent' });
    const sandbox = { discoverSessionWrappers } as unknown as AgentSandbox;

    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => ({
        execute: async (_plan, options) => {
          leasedInstances.push(options?.leasedInstance);
          return { kiloSessionId: 'kilo_runtime' };
        },
      }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });

    await expect(runtime.send(createPlan())).resolves.toMatchObject({ success: true });
    expect(discoverSessionWrappers).toHaveBeenCalledTimes(2);
    expect(leasedInstances).toEqual([expect.objectContaining({ instanceGeneration: 2 })]);
    await expect(getWrapperLease(storage)).resolves.toMatchObject({
      state: 'owns_wrapper',
      instance: { instanceGeneration: 2 },
    });
  });

  it('blocks migrated run-fence state when no durable physical owner authorizes the visible wrapper', async () => {
    const storage = createMemoryStorage([
      [
        'wrapper_runtime_state',
        { wrapperGeneration: 3, wrapperConnectionId: 'conn_legacy', wrapperRunId: 'wr_legacy' },
      ],
    ]);
    const execute = vi.fn();
    const sandbox = {
      discoverSessionWrappers: vi.fn().mockResolvedValue({
        status: 'present',
        observed: [{ representation: 'process', id: 'legacy', port: 5_000 }],
      }),
    } as unknown as AgentSandbox;
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getOrchestratorOverride: () => ({ execute }),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });

    await expect(runtime.send(createPlan())).rejects.toThrow(/cleanup is required/i);
    expect(execute).not.toHaveBeenCalled();
    await expect(getWrapperLease(storage)).resolves.toMatchObject({
      state: 'stop_needed',
      target: { kind: 'session' },
    });
  });

  it('routes snapshot and interrupt commands through the current wrapper run fence', async () => {
    const storage = createMemoryStorage([
      [
        'wrapper_runtime_state',
        {
          wrapperGeneration: 3,
          wrapperConnectionId: 'conn_runtime',
          wrapperRunId: 'wr_runtime',
        },
      ],
    ]);
    const commands: Array<{ ingestTagId: string; command: unknown; fence?: unknown }> = [];
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: (ingestTagId, command, fence) => {
        commands.push({ ingestTagId, command, fence });
        return true;
      },
    });

    await runtime.requestSnapshot();
    await expect(runtime.interruptWrapper()).resolves.toEqual({ commandSent: true });

    expect(commands).toEqual([
      { ingestTagId: 'wr_runtime', command: { type: 'request_snapshot' }, fence: undefined },
      {
        ingestTagId: 'wr_runtime',
        command: { type: 'kill', signal: 'SIGTERM' },
        fence: { wrapperGeneration: 3, wrapperConnectionId: 'conn_runtime' },
      },
    ]);
  });

  it('reports interrupt command unsent when no matching live wrapper socket exists', async () => {
    const storage = createMemoryStorage([
      [
        'wrapper_runtime_state',
        { wrapperGeneration: 3, wrapperConnectionId: 'conn_runtime', wrapperRunId: 'wr_runtime' },
      ],
    ]);
    const runtime = createAgentRuntime({
      storage,
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
    });

    await expect(runtime.interruptWrapper()).resolves.toEqual({ commandSent: false });
  });

  it('keeps the runtime sandbox alive through AgentSandbox transport controls', async () => {
    const keepAlive = vi.fn().mockResolvedValue(undefined);
    const sandbox = { keepAlive } as unknown as AgentSandbox;
    const runtime = createAgentRuntime({
      storage: createMemoryStorage(),
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      createAgentSandbox: () => sandbox,
    });

    await runtime.keepSandboxAlive();

    expect(keepAlive).toHaveBeenCalledOnce();
  });
});
