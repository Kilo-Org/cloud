import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WrapperClientModule from '../kilo/wrapper-client.js';
import type { Env, SandboxInstance } from '../types.js';
import type { FencedWrapperDispatchRequest } from './types.js';

const {
  ensureBootstrapWrapperMock,
  ensureWrapperMock,
  ensureSessionReadyMock,
  promptMock,
  commandMock,
  buildWrapperSessionReadyAndPromptRequestsMock,
  prepareWorkspaceMock,
} = vi.hoisted(() => ({
  ensureBootstrapWrapperMock: vi.fn(),
  ensureWrapperMock: vi.fn(),
  ensureSessionReadyMock: vi.fn(),
  promptMock: vi.fn(),
  commandMock: vi.fn(),
  buildWrapperSessionReadyAndPromptRequestsMock: vi.fn(),
  prepareWorkspaceMock: vi.fn(),
}));

vi.mock('../session-service.js', () => ({
  SessionService: class SessionService {
    buildWrapperSessionReadyAndPromptRequests = buildWrapperSessionReadyAndPromptRequestsMock;
    prepareWorkspace = prepareWorkspaceMock;
  },
}));

vi.mock('../kilo/wrapper-client.js', async importActual => {
  const actual = await importActual<typeof WrapperClientModule>();
  return {
    ...actual,
    WrapperClient: {
      ensureBootstrapWrapper: ensureBootstrapWrapperMock,
      ensureWrapper: ensureWrapperMock,
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
} satisfies FencedWrapperDispatchRequest['workspace']['metadata'];

const basePlan = {
  scope: {
    sessionId: 'agent_test',
    userId: 'user_test',
  },
  turn: {
    type: 'prompt',
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
} satisfies FencedWrapperDispatchRequest;

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
    type: 'prompt' as const,
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
    commandMock.mockResolvedValue({});
    ensureBootstrapWrapperMock.mockResolvedValue({
      client: {
        ensureSessionReady: ensureSessionReadyMock,
        prompt: promptMock,
        command: commandMock,
      },
    });
    ensureWrapperMock.mockResolvedValue({
      client: {
        prompt: promptMock,
        command: commandMock,
      },
      sessionId: 'kilo_devcontainer',
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
    } satisfies FencedWrapperDispatchRequest;

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

  it('forwards wrapper-resolved devcontainer readiness to persistence hooks', async () => {
    const prepared = buildPreparedRequests();
    const devcontainer = {
      workspacePath: '/workspace/test',
      innerWorkspaceFolder: '/workspaces/repo',
      wrapperPort: 4173,
      configPath: '.devcontainer/devcontainer.json',
    };
    buildWrapperSessionReadyAndPromptRequestsMock.mockResolvedValueOnce(prepared);
    ensureSessionReadyMock.mockResolvedValueOnce({
      kiloSessionId: 'kilo_ready',
      workspaceReady: {
        ...prepared.ready,
        devcontainer,
      },
    });
    const { orchestrator } = createOrchestrator();
    const onWorkspaceReady = vi.fn().mockResolvedValue(undefined);

    await orchestrator.execute(basePlan, { onWorkspaceReady });

    expect(onWorkspaceReady).toHaveBeenCalledWith({
      ...prepared.ready,
      devcontainer,
    });
  });

  it('routes devcontainer-requested deliveries through the prepared devcontainer runtime path', async () => {
    const prepared = buildPreparedRequests();
    const devcontainer = {
      workspacePath: '/workspace/test',
      innerWorkspaceFolder: '/workspaces/repo',
      wrapperPort: 4173,
      configPath: '.devcontainer/devcontainer.json',
    };
    const devcontainerPlan = {
      ...basePlan,
      workspace: {
        sandboxId: 'dind-abcdef',
        metadata: {
          ...baseMetadata,
          workspace: {
            sandboxId: 'dind-abcdef',
            devcontainerRequested: true,
          },
        },
      },
    } satisfies FencedWrapperDispatchRequest;
    buildWrapperSessionReadyAndPromptRequestsMock.mockResolvedValueOnce(prepared);
    prepareWorkspaceMock.mockResolvedValueOnce({
      ready: {
        ...prepared.ready,
        sandboxId: 'dind-abcdef',
        devcontainer,
      },
      context: {
        workspacePath: '/workspace/test',
      },
      runtimeEnv: {},
      session: {},
      devcontainer: {
        containerId: 'container-dev',
        innerWorkspaceFolder: devcontainer.innerWorkspaceFolder,
        workspacePath: devcontainer.workspacePath,
        agentSessionId: 'agent_test',
        overrideConfigPath: '/tmp/devcontainer.json',
        teardown: vi.fn(),
      },
    });
    const { orchestrator, sandbox } = createOrchestrator();
    const onWorkspaceReady = vi.fn().mockResolvedValue(undefined);

    await expect(orchestrator.execute(devcontainerPlan, { onWorkspaceReady })).resolves.toEqual({
      kiloSessionId: 'kilo_devcontainer',
    });

    expect(ensureBootstrapWrapperMock).not.toHaveBeenCalled();
    expect(ensureSessionReadyMock).not.toHaveBeenCalled();
    expect(ensureWrapperMock).toHaveBeenCalledWith(
      sandbox,
      expect.anything(),
      expect.objectContaining({
        agentSessionId: 'agent_test',
        fixedPort: devcontainer.wrapperPort,
      })
    );
    expect(onWorkspaceReady).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: 'dind-abcdef', devcontainer })
    );
    expect(promptMock).toHaveBeenCalledWith(prepared.promptRequest);
  });

  it('dispatches queued command turns through wrapper command delivery', async () => {
    const prepared = buildPreparedRequests();
    const commandPlan = {
      ...basePlan,
      turn: {
        type: 'command',
        messageId: 'msg_018f1e2d3c4bCommandTurnAAAA',
        command: 'compact',
        arguments: '--aggressive',
      },
      finalization: {
        autoCommit: true,
        condenseOnComplete: false,
      },
    } satisfies FencedWrapperDispatchRequest;
    const commandRequest = {
      command: 'compact',
      args: '--aggressive',
      messageId: commandPlan.turn.messageId,
      autoCommit: true,
      condenseOnComplete: false,
      session: prepared.readyRequest.session,
    };
    buildWrapperSessionReadyAndPromptRequestsMock.mockResolvedValueOnce({
      ...prepared,
      type: 'command',
      commandRequest,
    });
    const { orchestrator } = createOrchestrator();

    await orchestrator.execute(commandPlan);

    expect(commandMock).toHaveBeenCalledWith(commandRequest);
    expect(promptMock).not.toHaveBeenCalled();
  });
});
