import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

import {
  ExecutionError,
  isExecutionError,
  type PermanentErrorCode,
  type RetryableErrorCode,
} from '../../../src/execution/errors.js';
import { ExecutionOrchestrator } from '../../../src/execution/orchestrator.js';
import { CloudflareAgentSandbox } from '../../../src/agent-sandbox/cloudflare/cloudflare-agent-sandbox.js';
import { WrapperClient } from '../../../src/kilo/wrapper-client.js';
import { SessionService } from '../../../src/session-service.js';
import type {
  ExecutionPlan,
  ExecutionResult,
  FencedWrapperDispatchRequest,
  ModelConfig,
  WorkspaceDeliveryPlan,
  WrapperRunFence,
} from '../../../src/execution/types.js';
import type { Env, ExecutionSession, SandboxInstance, SessionContext } from '../../../src/types.js';
import type {
  WrapperPromptRequest,
  WrapperSessionReadyRequest,
  WrapperWorkspaceReady,
} from '../../../src/shared/wrapper-bootstrap.js';
import { FAST_SANDBOX_COMMAND_TIMEOUT_MS } from '../../../src/sandbox-timeout-logging.js';

const createWorkspaceDeliveryPlan = (): WorkspaceDeliveryPlan => ({
  sandboxId: 'sandbox_123',
  metadata: {
    version: 1,
    sessionId: 'agent_123',
    userId: 'user_123',
    timestamp: 1,
    kiloSessionId: 'kilo_sess_456',
    kilocodeToken: 'kilo_token',
    workspacePath: '/workspace/project',
    sessionHome: '/home/agent_123',
    branchName: 'feature-branch',
  },
});

const createExecutionPlan = (): ExecutionPlan => ({
  executionId: 'exec_123',
  scope: {
    sessionId: 'agent_123',
    userId: 'user_123',
  },
  turn: {
    prompt: 'Do the work',
    messageId: 'msg_018f1e2d3c4bOrchestratorAAAA',
  },
  agent: {
    mode: 'code',
    model: 'claude-sonnet-4-20250514',
  },
  workspace: createWorkspaceDeliveryPlan(),
  wrapper: {
    kiloSessionId: 'kilo_sess_456',
    fence: {
      wrapperRunId: 'wr_123',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_123',
    },
  },
});

const createWrapperReady = (): WrapperWorkspaceReady => ({
  workspacePath: '/workspace/user_123/sessions/agent_123',
  sandboxId: 'sandbox_123',
  sessionHome: '/home/agent_123',
  branchName: 'feature-branch',
  kiloSessionId: 'kilo_sess_456',
});

const createWrapperReadyRequest = (): WrapperSessionReadyRequest => ({
  agentSessionId: 'agent_123',
  userId: 'user_123',
  sandboxId: 'sandbox_123',
  kiloSessionId: 'kilo_sess_456',
  workspace: {
    workspacePath: '/workspace/user_123/sessions/agent_123',
    sessionHome: '/home/agent_123',
    branchName: 'feature-branch',
  },
  materialized: {
    env: {
      HOME: '/home/agent_123',
      KILOCODE_TOKEN: 'kilo_token',
    },
  },
  session: {
    ingestUrl: 'wss://cloud-agent.example.com/sessions/user_123/agent_123/ingest',
    workerAuthToken: 'kilo_token',
    wrapperRunId: 'wr_123',
    wrapperGeneration: 1,
    wrapperConnectionId: 'conn_123',
  },
});

const createWrapperPromptRequest = (): WrapperPromptRequest => ({
  message: {
    id: 'msg_018f1e2d3c4bOrchestratorAAAA',
    prompt: 'Do the work',
  },
  session: createWrapperReadyRequest().session,
});

const createSessionContext = (): SessionContext => ({
  sandboxId: 'sandbox_123',
  sessionId: 'agent_123',
  userId: 'user_123',
  sessionHome: '/home/agent_123',
  workspacePath: '/workspace/user_123/sessions/agent_123',
  branchName: 'feature-branch',
});

const createMockSandbox = (options: { workspaceWarm?: boolean } = {}) => {
  const calls: string[] = [];
  const session = {} as ExecutionSession;
  const sandbox = {
    exec: vi.fn(async (command: string) => {
      calls.push(`exec:${command}`);
      if (command.includes("test -d '/workspace/user_123/sessions/agent_123/.git'")) {
        return {
          exitCode: options.workspaceWarm ? 0 : 1,
          stdout: options.workspaceWarm ? 'exists\n' : '',
          stderr: '',
        };
      }
      if (command.includes('df -B1 --output=avail,size /')) {
        return { exitCode: 0, stdout: '9999999999 10000000000\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    createSession: vi.fn(async () => {
      calls.push('createSession');
      return session;
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    listProcesses: vi.fn().mockResolvedValue([]),
  } as unknown as SandboxInstance & {
    exec: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    listProcesses: ReturnType<typeof vi.fn>;
  };

  return { sandbox, calls };
};

function stubWrapperBootstrap(
  overrides: Partial<
    Awaited<ReturnType<SessionService['buildWrapperSessionReadyAndPromptRequests']>>
  > = {}
) {
  const ready = createWrapperReady();
  const built = {
    readyRequest: createWrapperReadyRequest(),
    promptRequest: createWrapperPromptRequest(),
    ready,
    context: createSessionContext(),
    ...overrides,
  } satisfies Awaited<ReturnType<SessionService['buildWrapperSessionReadyAndPromptRequests']>>;
  vi.spyOn(SessionService.prototype, 'buildWrapperSessionReadyAndPromptRequests').mockResolvedValue(
    built
  );

  const ensureSessionReady = vi.fn().mockResolvedValue({
    status: 'ready',
    kiloSessionId: 'kilo_sess_456',
    workspaceReady: ready,
  });
  const prompt = vi.fn().mockResolvedValue({
    messageId: 'msg_018f1e2d3c4bOrchestratorAAAA',
  });
  vi.spyOn(WrapperClient, 'ensureBootstrapWrapper').mockResolvedValue({
    client: { ensureSessionReady, prompt } as unknown as WrapperClient,
  });

  return { ensureSessionReady, prompt, built };
}

function createOrchestrator(
  sandbox: SandboxInstance,
  env: Partial<Env> & Record<string, unknown> = {},
  options: { recordKiloServerActivity?: ReturnType<typeof vi.fn> } = {}
) {
  const recordKiloServerActivity =
    options.recordKiloServerActivity ?? vi.fn().mockResolvedValue(undefined);
  return new ExecutionOrchestrator({
    getAgentSandbox: plan =>
      new CloudflareAgentSandbox(env as Env, plan.workspace.metadata, {
        resolveSandbox: () => sandbox,
      }),
    getSessionStub: vi.fn(
      () =>
        ({
          recordKiloServerActivity,
        }) as unknown as DurableObjectStub
    ),
    env: env as Env,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ExecutionError', () => {
  describe('retryable error factory methods', () => {
    it('sandboxConnectFailed creates retryable error', () => {
      const error = ExecutionError.sandboxConnectFailed('Connection refused');

      expect(error.code).toBe('SANDBOX_CONNECT_FAILED');
      expect(error.retryable).toBe(true);
      expect(error.message).toBe('Connection refused');
      expect(error.name).toBe('ExecutionError');
    });

    it('workspaceSetupFailed creates retryable error', () => {
      const error = ExecutionError.workspaceSetupFailed('Git clone failed');

      expect(error.code).toBe('WORKSPACE_SETUP_FAILED');
      expect(error.retryable).toBe(true);
    });

    it('kiloServerFailed creates retryable error', () => {
      const error = ExecutionError.kiloServerFailed('Server starting');

      expect(error.code).toBe('KILO_SERVER_FAILED');
      expect(error.retryable).toBe(true);
    });

    it('wrapperStartFailed creates retryable error', () => {
      const error = ExecutionError.wrapperStartFailed('Wrapper timeout');

      expect(error.code).toBe('WRAPPER_START_FAILED');
      expect(error.retryable).toBe(true);
    });
  });

  describe('permanent error factory methods', () => {
    it('invalidRequest creates non-retryable error', () => {
      const error = ExecutionError.invalidRequest('Missing field');

      expect(error.code).toBe('INVALID_REQUEST');
      expect(error.retryable).toBe(false);
    });

    it('sessionNotFound creates non-retryable error', () => {
      const error = ExecutionError.sessionNotFound('session_abc');

      expect(error.code).toBe('SESSION_NOT_FOUND');
      expect(error.retryable).toBe(false);
      expect(error.message).toContain('session_abc');
    });

    it('wrapperJobConflict creates non-retryable error', () => {
      const error = ExecutionError.wrapperJobConflict('Already running');

      expect(error.code).toBe('WRAPPER_JOB_CONFLICT');
      expect(error.retryable).toBe(false);
    });
  });

  it('preserves cause for debugging', () => {
    const originalError = new Error('Original problem');
    const error = ExecutionError.sandboxConnectFailed('Wrapped', originalError);

    expect(error.cause).toBe(originalError);
  });

  it('classifies retryable codes', () => {
    const retryableCodes: RetryableErrorCode[] = [
      'SANDBOX_CONNECT_FAILED',
      'WORKSPACE_SETUP_FAILED',
      'KILO_SERVER_FAILED',
      'WRAPPER_START_FAILED',
    ];
    const permanentCodes: PermanentErrorCode[] = [
      'INVALID_REQUEST',
      'SESSION_NOT_FOUND',
      'WRAPPER_JOB_CONFLICT',
    ];

    expect(retryableCodes).toHaveLength(4);
    expect(permanentCodes).toHaveLength(3);
  });
});

describe('isExecutionError', () => {
  it('returns true for ExecutionError instances', () => {
    expect(isExecutionError(ExecutionError.sandboxConnectFailed('test'))).toBe(true);
  });

  it('returns false for other values', () => {
    expect(isExecutionError(new Error('test'))).toBe(false);
    expect(isExecutionError(null)).toBe(false);
    expect(isExecutionError({ code: 'SANDBOX_CONNECT_FAILED' })).toBe(false);
  });
});

describe('WorkspaceDeliveryPlan types', () => {
  it('carries sandbox and metadata in a single shape', () => {
    const plan = createWorkspaceDeliveryPlan();

    expect(plan.sandboxId).toBe('sandbox_123');
    expect(plan.metadata.kiloSessionId).toBe('kilo_sess_456');
    expect(plan.metadata.kilocodeToken).toBe('kilo_token');
  });
});

describe('ExecutionResult types', () => {
  it('contains kiloSessionId', () => {
    const result: ExecutionResult = {
      kiloSessionId: 'kilo_sess_456',
    };

    expect(result.kiloSessionId).toBeDefined();
  });
});

describe('ModelConfig types', () => {
  it('requires modelID and accepts optional providerID', () => {
    const model: ModelConfig = {
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4-20250514',
    };

    expect(model).toEqual({
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4-20250514',
    });
  });
});

describe('WrapperRunFence types', () => {
  it('keeps runtime fence identity grouped on wrapper delivery bindings', () => {
    const fence: WrapperRunFence = {
      wrapperRunId: 'wr_123',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_123',
    };
    const wrapper: FencedWrapperDispatchRequest['wrapper'] = {
      kiloSessionId: 'kilo_sess_456',
      fence,
    };

    expect(wrapper.kiloSessionId).toBe('kilo_sess_456');
    expect(wrapper.fence.wrapperRunId).toBe('wr_123');
  });
});

describe('ExecutionPlan types', () => {
  it('extends the composed message delivery plan with only compatibility identity', () => {
    const plan: ExecutionPlan = {
      executionId: 'exec_123',
      scope: {
        sessionId: 'agent_123',
        userId: 'user_123',
      },
      turn: {
        prompt: 'Do the work',
        messageId: 'msg_018f1e2d3c4bPlanTypeAbCdE',
      },
      agent: {
        mode: 'code',
        model: 'claude-sonnet-4-20250514',
      },
      workspace: createWorkspaceDeliveryPlan(),
      wrapper: {
        kiloSessionId: 'kilo_sess_456',
        fence: {
          wrapperRunId: 'wr_plan_type',
          wrapperGeneration: 1,
          wrapperConnectionId: 'conn_plan_type',
        },
      },
    };

    expect(plan.workspace.metadata.sessionId).toBe('agent_123');
    expect(plan.agent.model).toBe('claude-sonnet-4-20250514');
    expect(plan.turn.messageId).toBe('msg_018f1e2d3c4bPlanTypeAbCdE');
  });
});

describe('ExecutionOrchestrator bootstrap execution', () => {
  it('uses wrapper bootstrap without a feature flag and cleans cold workspaces before starting the bootstrap session', async () => {
    const { sandbox, calls } = createMockSandbox({ workspaceWarm: false });
    const { ensureSessionReady, prompt, built } = stubWrapperBootstrap();
    const recordKiloServerActivity = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createOrchestrator(sandbox, {}, { recordKiloServerActivity });
    const onWorkspaceReady = vi.fn().mockResolvedValue(undefined);

    const result = await orchestrator.execute(createExecutionPlan(), { onWorkspaceReady });

    expect(result).toEqual({ kiloSessionId: 'kilo_sess_456' });
    expect(WrapperClient.ensureBootstrapWrapper).toHaveBeenCalledOnce();
    expect(ensureSessionReady).toHaveBeenCalledWith(built.readyRequest);
    expect(onWorkspaceReady).toHaveBeenCalledWith(built.ready);
    expect(prompt).toHaveBeenCalledWith(built.promptRequest);
    expect(
      vi.mocked(WrapperClient.ensureBootstrapWrapper).mock.invocationCallOrder[0]
    ).toBeLessThan(ensureSessionReady.mock.invocationCallOrder[0]);
    expect(ensureSessionReady.mock.invocationCallOrder[0]).toBeLessThan(
      onWorkspaceReady.mock.invocationCallOrder[0]
    );
    expect(onWorkspaceReady.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.mock.invocationCallOrder[0]
    );
    expect(prompt.mock.invocationCallOrder[0]).toBeLessThan(
      recordKiloServerActivity.mock.invocationCallOrder[0]
    );
    expect(calls).toEqual([
      "exec:test -d '/workspace/user_123/sessions/agent_123/.git' && echo exists",
      'exec:df -B1 --output=avail,size / | tail -1',
      'createSession',
    ]);
  });

  it('reports Kilo startup progress when delivering to a warm workspace', async () => {
    const { sandbox } = createMockSandbox({ workspaceWarm: true });
    const { ensureSessionReady, prompt } = stubWrapperBootstrap();
    const orchestrator = createOrchestrator(sandbox);
    const onProgress = vi.fn();

    await orchestrator.execute(createExecutionPlan(), { onProgress });

    expect(onProgress).toHaveBeenCalledExactlyOnceWith('kilo_server', 'Starting Kilo...');
    expect(ensureSessionReady).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('destroys the sandbox when a bootstrap sandbox operation hits HTTP 500', async () => {
    const { sandbox } = createMockSandbox({ workspaceWarm: true });
    stubWrapperBootstrap();
    const sandbox500 = Object.assign(new Error('HTTP Error! status: 500'), {
      name: 'SandboxError',
      httpStatus: 500,
    });
    sandbox.createSession.mockRejectedValueOnce(sandbox500);
    const orchestrator = createOrchestrator(sandbox);

    await expect(orchestrator.execute(createExecutionPlan())).rejects.toThrow(
      'HTTP Error! status: 500'
    );

    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('destroys a stale sandbox when the warm workspace probe stalls', async () => {
    vi.useFakeTimers();
    const { sandbox } = createMockSandbox({ workspaceWarm: true });
    sandbox.exec.mockImplementationOnce(() => new Promise(() => {}));
    stubWrapperBootstrap();
    const orchestrator = createOrchestrator(sandbox);

    const execution = orchestrator.execute(createExecutionPlan());
    const rejection = expect(execution).rejects.toThrow(
      'Sandbox workspace Git probe timed out before wrapper bootstrap'
    );
    await vi.advanceTimersByTimeAsync(FAST_SANDBOX_COMMAND_TIMEOUT_MS);

    await rejection;
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });
});
