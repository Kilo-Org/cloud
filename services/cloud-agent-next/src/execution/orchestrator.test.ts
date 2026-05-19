import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, SandboxInstance } from '../types.js';
import type { ExecutionPlan } from './types.js';

const { ensureWrapperMock, promptMock, resumeMock, initiateMock, getOrCreateSessionMock } =
  vi.hoisted(() => ({
    ensureWrapperMock: vi.fn(),
    promptMock: vi.fn(),
    resumeMock: vi.fn(),
    initiateMock: vi.fn(),
    getOrCreateSessionMock: vi.fn(),
  }));

vi.mock('../session-service.js', () => ({
  SessionService: class SessionService {
    resume = resumeMock;
    initiateWithRetry = initiateMock;
    getOrCreateSession = getOrCreateSessionMock;
  },
}));

vi.mock('../kilo/wrapper-client.js', () => ({
  WrapperClient: {
    ensureWrapper: ensureWrapperMock,
  },
}));

vi.mock('./image-prompt-parts.js', () => ({
  buildImagePromptParts: vi.fn(),
  downloadImagePromptParts: vi.fn().mockResolvedValue([]),
}));

import { ExecutionOrchestrator } from './orchestrator.js';

const preparedSession = {
  session: { exec: vi.fn() },
  context: {
    workspacePath: '/workspace/test',
    upstreamBranch: 'main',
  },
};

const basePlan = {
  executionId: 'exc_test',
  sessionId: 'agent_test',
  userId: 'user_test',
  payload: {
    type: 'prompt',
    prompt: 'Review this change',
  },
  mode: 'code',
  workspace: {
    shouldPrepare: false,
    sandboxId: 'sandbox_test',
    resumeContext: {
      kiloSessionId: 'kilo_existing',
      workspacePath: '/workspace/test',
      kilocodeToken: 'kilo_token',
      branchName: 'session/agent_test',
    },
  },
  wrapper: {
    kiloSessionId: 'kilo_existing',
    model: { providerID: 'kilocode', modelID: 'test-model' },
  },
} satisfies ExecutionPlan;

function createOrchestrator() {
  const sandbox = {} as SandboxInstance;
  const recordKiloServerActivity = vi.fn().mockResolvedValue(undefined);

  const orchestrator = new ExecutionOrchestrator({
    getSandbox: vi.fn().mockResolvedValue(sandbox),
    getSessionStub: vi.fn().mockReturnValue({ recordKiloServerActivity }),
    getIngestUrl: vi.fn().mockReturnValue('wss://ingest.example.com/ingest'),
    env: {} as Env,
  });

  return orchestrator;
}

describe('ExecutionOrchestrator tool overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promptMock.mockResolvedValue({ messageId: 'msg_test' });
    ensureWrapperMock.mockResolvedValue({
      client: { prompt: promptMock },
      sessionId: 'kilo_existing',
    });
    resumeMock.mockResolvedValue(preparedSession);
    initiateMock.mockResolvedValue(preparedSession);
    getOrCreateSessionMock.mockResolvedValue(preparedSession.session);
  });

  it('disables interactive tools for code-review resume executions', async () => {
    const orchestrator = createOrchestrator();
    const plan = {
      ...basePlan,
      workspace: {
        ...basePlan.workspace,
        resumeContext: {
          ...basePlan.workspace.resumeContext,
          createdOnPlatform: 'code-review',
        },
      },
    } satisfies ExecutionPlan;

    await orchestrator.execute(plan);

    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          question: false,
          plan_enter: false,
          plan_exit: false,
        },
      })
    );
  });

  it('does not send tool overrides for non-code-review executions', async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.execute(basePlan);

    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
      })
    );
  });

  it('uses existing metadata to detect code-review fast-path executions', async () => {
    const orchestrator = createOrchestrator();
    const plan = {
      ...basePlan,
      workspace: {
        shouldPrepare: true,
        sandboxId: 'sandbox_test',
        initContext: {
          kilocodeToken: 'kilo_token',
          isPreparedSession: true,
        },
        existingMetadata: {
          workspacePath: '/workspace/test',
          kiloSessionId: 'kilo_existing',
          sandboxId: 'sandbox_test',
          sessionHome: '/home/agent_test',
          branchName: 'session/agent_test',
          createdOnPlatform: 'code-review',
        },
      },
    } satisfies ExecutionPlan;

    await orchestrator.execute(plan);

    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          question: false,
          plan_enter: false,
          plan_exit: false,
        },
      })
    );
    expect(getOrCreateSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        createdOnPlatform: 'code-review',
      })
    );
  });
});
