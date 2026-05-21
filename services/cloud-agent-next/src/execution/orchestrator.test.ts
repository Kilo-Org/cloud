import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WrapperClientModule from '../kilo/wrapper-client.js';
import type { Env, SandboxInstance } from '../types.js';
import type { MessageDeliveryPlan } from './types.js';

const {
  ensureBootstrapWrapperMock,
  ensureSessionReadyMock,
  promptMock,
  buildWrapperSessionReadyAndPromptRequestsMock,
} = vi.hoisted(() => ({
  ensureBootstrapWrapperMock: vi.fn(),
  ensureSessionReadyMock: vi.fn(),
  promptMock: vi.fn(),
  buildWrapperSessionReadyAndPromptRequestsMock: vi.fn(),
}));

vi.mock('../session-service.js', () => ({
  SessionService: class SessionService {
    buildWrapperSessionReadyAndPromptRequests = buildWrapperSessionReadyAndPromptRequestsMock;
  },
}));

vi.mock('../kilo/wrapper-client.js', async importActual => {
  const actual = await importActual<typeof WrapperClientModule>();
  return {
    ...actual,
    WrapperClient: {
      ensureBootstrapWrapper: ensureBootstrapWrapperMock,
    },
  };
});

import { ExecutionOrchestrator } from './orchestrator.js';

const baseMetadata = {
  metadataSchemaVersion: 2,
  identity: {
    sessionId: 'agent_test',
    userId: 'user_test',
  },
  auth: {
    kiloSessionId: 'kilo_existing',
    kilocodeToken: 'kilo_token',
  },
  lifecycle: {
    version: 1,
    timestamp: 1,
  },
} satisfies MessageDeliveryPlan['workspace']['metadata'];

const basePlan = {
  scope: {
    sessionId: 'agent_test',
    userId: 'user_test',
  },
  turn: {
    messageId: 'msg_018f1e2d3c4bOrchestratorAAAA',
    prompt: 'Review this change',
  },
  agent: {
    mode: 'code',
    model: 'test-model',
  },
  workspace: {
    sandboxId: 'sandbox_test',
    metadata: baseMetadata,
  },
  wrapper: {
    kiloSessionId: 'kilo_existing',
    fence: {
      wrapperRunId: 'wr_test',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_test',
    },
  },
} satisfies MessageDeliveryPlan;

function buildPreparedRequests() {
  const session = {
    ingestUrl: 'wss://ingest.example.com/sessions/user_test/agent_test/ingest',
    workerAuthToken: 'kilo_token',
    wrapperRunId: 'wr_test',
    wrapperGeneration: 1,
    wrapperConnectionId: 'conn_test',
  };
  const ready = {
    workspacePath: '/workspace/test',
    sandboxId: 'sandbox_test',
    sessionHome: '/home/agent_test',
    branchName: 'session/agent_test',
    kiloSessionId: 'kilo_existing',
  };

  return {
    readyRequest: {
      agentSessionId: 'agent_test',
      userId: 'user_test',
      sandboxId: 'sandbox_test',
      kiloSessionId: 'kilo_existing',
      workspace: {
        workspacePath: '/workspace/test',
        sessionHome: '/home/agent_test',
        branchName: 'session/agent_test',
      },
      materialized: { env: {} },
      session,
    },
    promptRequest: {
      message: {
        id: basePlan.turn.messageId,
        prompt: basePlan.turn.prompt,
      },
      agent: {
        mode: 'code',
      },
      session,
    },
    ready,
    context: {
      workspacePath: '/workspace/test',
    },
  };
}

function createOrchestrator() {
  const sandbox = {
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'exists\n', stderr: '' }),
    createSession: vi.fn().mockResolvedValue({}),
  } as unknown as SandboxInstance;
  const recordKiloServerActivity = vi.fn().mockResolvedValue(undefined);

  const orchestrator = new ExecutionOrchestrator({
    getSandbox: vi.fn().mockResolvedValue(sandbox),
    getSessionStub: vi.fn().mockReturnValue({ recordKiloServerActivity }),
    env: {} as Env,
  });

  return { orchestrator, sandbox };
}

describe('ExecutionOrchestrator split wrapper bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildWrapperSessionReadyAndPromptRequestsMock.mockImplementation(async () =>
      buildPreparedRequests()
    );
    ensureSessionReadyMock.mockResolvedValue({ kiloSessionId: 'kilo_ready' });
    promptMock.mockResolvedValue({ messageId: basePlan.turn.messageId });
    ensureBootstrapWrapperMock.mockResolvedValue({
      client: {
        ensureSessionReady: ensureSessionReadyMock,
        prompt: promptMock,
      },
    });
  });

  it('disables interactive tools from current code-review session metadata', async () => {
    const { orchestrator } = createOrchestrator();
    const plan = {
      ...basePlan,
      workspace: {
        ...basePlan.workspace,
        metadata: {
          ...baseMetadata,
          identity: {
            ...baseMetadata.identity,
            createdOnPlatform: 'code-review',
          },
        },
      },
    } satisfies MessageDeliveryPlan;

    await orchestrator.execute(plan);

    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          tools: {
            question: false,
            plan_enter: false,
            plan_exit: false,
          },
        }),
      })
    );
  });

  it('does not send tool overrides for ordinary message deliveries', async () => {
    const { orchestrator } = createOrchestrator();

    await orchestrator.execute(basePlan);

    const promptRequest = promptMock.mock.calls[0]?.[0] as {
      agent?: { tools?: Record<string, boolean> };
    };
    expect(promptRequest.agent?.tools).toBeUndefined();
  });

  it('readies the session separately before delivering the grouped prompt', async () => {
    const prepared = buildPreparedRequests();
    buildWrapperSessionReadyAndPromptRequestsMock.mockResolvedValueOnce(prepared);
    const { orchestrator, sandbox } = createOrchestrator();
    const onWorkspaceReady = vi.fn().mockResolvedValue(undefined);

    await expect(orchestrator.execute(basePlan, { onWorkspaceReady })).resolves.toEqual({
      kiloSessionId: 'kilo_ready',
    });

    expect(ensureBootstrapWrapperMock).toHaveBeenCalledWith(sandbox, expect.anything(), {
      agentSessionId: 'agent_test',
      userId: 'user_test',
    });
    expect(ensureSessionReadyMock).toHaveBeenCalledWith(prepared.readyRequest);
    expect(onWorkspaceReady).toHaveBeenCalledWith(prepared.ready);
    expect(promptMock).toHaveBeenCalledWith(prepared.promptRequest);
  });
});
