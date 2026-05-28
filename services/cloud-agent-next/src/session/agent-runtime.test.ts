import { describe, expect, it, vi } from 'vitest';
import type { Env, SandboxInstance } from '../types.js';
import type {
  FencedWrapperDispatchRequest,
  MessageDeliveryRequest,
  WorkspaceReady,
} from '../execution/types.js';
import { createAgentRuntime } from './agent-runtime.js';
import { getWrapperRuntimeState } from './wrapper-runtime-state.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

type MemoryRuntimeStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;

function createMemoryStorage(
  initialEntries?: Array<[string, unknown]>
): MemoryRuntimeStorage & DurableObjectStorage {
  const store = new Map(initialEntries ?? []);
  return {
    async get<T = unknown>(key: string) {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
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
  it('fences grouped delivery, records wrapper readiness, and returns the existing queue result shape', async () => {
    const storage = createMemoryStorage();
    const ready = createWorkspaceReady();
    const deliveredPlans: FencedWrapperDispatchRequest[] = [];
    const orchestrator = {
      execute: vi.fn(
        async (
          plan: FencedWrapperDispatchRequest,
          options?: {
            onProgress?: (step: string, message: string) => void;
            onWorkspaceReady?: (workspace: WorkspaceReady) => Promise<void>;
          }
        ) => {
          deliveredPlans.push(plan);
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
    const [deliveredPlan] = deliveredPlans;

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
    ]);
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
    });

    await expect(runtime.send(createPlan())).rejects.toThrow('hot follow-up failed');

    await expect(getWrapperRuntimeState(storage)).resolves.toMatchObject({
      wrapperGeneration: 3,
      wrapperConnectionId: 'conn_hot',
      wrapperRunId: 'wr_hot',
      noOutputDeadlineAt: 9_000,
      pingDeadlineAt: 8_000,
      nextPingAt: 7_000,
    });
  });

  it('clears a newly allocated wrapper fence when delivery fails before readiness', async () => {
    const storage = createMemoryStorage();
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
    });

    await expect(runtime.send(createPlan())).rejects.toThrow('wrapper unavailable');

    await expect(getWrapperRuntimeState(storage)).resolves.toEqual({ wrapperGeneration: 2 });
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

  it('keeps and stops the resolved sandbox runtime through transport controls', async () => {
    const renewActivityTimeout = vi.fn();
    const sandbox = { renewActivityTimeout } as unknown as SandboxInstance;
    const stopRuntimeWrapper = vi.fn().mockResolvedValue(undefined);
    const runtime = createAgentRuntime({
      storage: createMemoryStorage(),
      env: {} as Env,
      getMetadata: async () => createMetadata(),
      getSessionIdForLogs: () => 'agent_runtime',
      sendToWrapper: () => false,
      resolveSandbox: () => sandbox,
      stopRuntimeWrapper,
    });

    await runtime.keepSandboxAlive();
    await expect(runtime.stopWrapperProcess('idle-timeout')).resolves.toBe(true);

    expect(renewActivityTimeout).toHaveBeenCalledOnce();
    expect(stopRuntimeWrapper).toHaveBeenCalledWith(sandbox, 'agent_runtime');
  });
});
