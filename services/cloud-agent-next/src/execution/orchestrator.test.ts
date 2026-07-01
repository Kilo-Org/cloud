import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSandbox, WrapperInstanceLease } from '../agent-sandbox/protocol.js';
import type { Env } from '../types.js';
import { WrapperError } from '../kilo/wrapper-client.js';
import type { ExecutionError } from './errors.js';
import type { FencedWrapperDispatchRequest } from './types.js';
import {
  SandboxCapacityInspectionError,
  WorkspaceCapacityAdmissionRejectedError,
} from '../workspace-errors.js';

const { buildWrapperSessionReadyAndPromptRequestsMock } = vi.hoisted(() => ({
  buildWrapperSessionReadyAndPromptRequestsMock: vi.fn(),
}));

vi.mock('../session-service.js', () => ({
  SessionService: class SessionService {
    buildWrapperSessionReadyAndPromptRequests = buildWrapperSessionReadyAndPromptRequestsMock;
  },
}));

import { ExecutionOrchestrator } from './orchestrator.js';

const baseMetadata = {
  metadataSchemaVersion: 2,
  identity: { sessionId: 'agent_test', userId: 'user_test' },
  auth: { kiloSessionId: 'kilo_existing', kilocodeToken: 'kilo_token' },
  lifecycle: { version: 1, timestamp: 1 },
} satisfies FencedWrapperDispatchRequest['workspace']['metadata'];

const basePlan = {
  scope: { sessionId: 'agent_test', userId: 'user_test' },
  turn: {
    type: 'prompt',
    messageId: 'msg_018f1e2d3c4bOrchestratorAAAA',
    prompt: 'Review this change',
  },
  agent: { mode: 'code', model: 'test-model' },
  workspace: { sandboxId: 'sandbox_test', metadata: baseMetadata },
  wrapper: {
    kiloSessionId: 'kilo_existing',
    fence: { wrapperRunId: 'wr_test', wrapperGeneration: 1, wrapperConnectionId: 'conn_test' },
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
      message: { id: basePlan.turn.messageId, prompt: basePlan.turn.prompt },
      agent: { mode: 'code' },
      session,
    },
    ready,
    context: { workspacePath: '/workspace/test' },
  };
}

function createOrchestrator(options?: { sessionReady?: boolean; env?: Env }) {
  const ensureSessionReady = vi.fn().mockResolvedValue({ kiloSessionId: 'kilo_ready' });
  const prompt = vi.fn().mockResolvedValue({ messageId: basePlan.turn.messageId });
  const command = vi.fn().mockResolvedValue({});
  const wrapper = { ensureSessionReady, prompt, command };
  const ensureWrapper = vi.fn().mockResolvedValue(
    options?.sessionReady
      ? {
          status: 'session-ready',
          client: wrapper,
          ready: buildPreparedRequests().ready,
          kiloSessionId: 'kilo_devcontainer',
        }
      : { status: 'wrapper-running', client: wrapper }
  );
  const deleteSandbox = vi.fn().mockResolvedValue(undefined);
  const agentSandbox = {
    ensureWrapper,
    delete: deleteSandbox,
  } as unknown as AgentSandbox;
  const recordKiloServerActivity = vi.fn().mockResolvedValue(undefined);
  const orchestrator = new ExecutionOrchestrator({
    getAgentSandbox: vi.fn().mockReturnValue(agentSandbox),
    getSessionStub: vi.fn().mockReturnValue({ recordKiloServerActivity }),
    env: options?.env ?? ({} as Env),
  });
  return {
    orchestrator,
    ensureWrapper,
    deleteSandbox,
    ensureSessionReady,
    prompt,
    command,
  };
}

function codeReviewPlan(orgId: string): FencedWrapperDispatchRequest {
  return {
    ...basePlan,
    scope: { ...basePlan.scope, orgId },
    workspace: {
      ...basePlan.workspace,
      sandboxId: 'crv-test',
      metadata: {
        ...baseMetadata,
        identity: {
          ...baseMetadata.identity,
          orgId,
          createdOnPlatform: 'code-review',
        },
      },
    },
  };
}

describe('ExecutionOrchestrator AgentSandbox delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildWrapperSessionReadyAndPromptRequestsMock.mockResolvedValue(buildPreparedRequests());
  });

  it('readies a wrapper before dispatching its prompt', async () => {
    const { orchestrator, ensureWrapper, ensureSessionReady, prompt } = createOrchestrator();
    const onWorkspaceReady = vi.fn().mockResolvedValue(undefined);

    await expect(orchestrator.execute(basePlan, { onWorkspaceReady })).resolves.toEqual({
      kiloSessionId: 'kilo_ready',
    });

    expect(ensureWrapper).toHaveBeenCalledWith(
      expect.objectContaining({ plan: basePlan, prepared: buildPreparedRequests() })
    );
    expect(ensureSessionReady).toHaveBeenCalledWith(buildPreparedRequests().readyRequest);
    expect(ensureSessionReady.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.mock.invocationCallOrder[0]
    );
    expect(onWorkspaceReady).toHaveBeenCalledWith(buildPreparedRequests().ready);
  });

  it('passes an authorized physical lease through to wrapper startup', async () => {
    const { orchestrator, ensureWrapper } = createOrchestrator();
    const leasedInstance: WrapperInstanceLease = {
      instanceId: 'instance_orchestrator',
      instanceGeneration: 9,
    };

    await orchestrator.execute(basePlan, { leasedInstance });

    expect(ensureWrapper).toHaveBeenCalledWith(expect.objectContaining({ leasedInstance }));
  });

  it('uses already-ready devcontainer adapter output without a second ready request', async () => {
    const { orchestrator, ensureSessionReady, prompt } = createOrchestrator({ sessionReady: true });
    const onWorkspaceReady = vi.fn().mockResolvedValue(undefined);

    await expect(orchestrator.execute(basePlan, { onWorkspaceReady })).resolves.toEqual({
      kiloSessionId: 'kilo_devcontainer',
    });
    expect(ensureSessionReady).not.toHaveBeenCalled();
    expect(onWorkspaceReady).toHaveBeenCalledWith(buildPreparedRequests().ready);
    expect(prompt).toHaveBeenCalledWith(buildPreparedRequests().promptRequest);
  });

  it('disables interactive tools from current code-review session metadata', async () => {
    const { orchestrator, prompt } = createOrchestrator();
    const plan = {
      ...basePlan,
      workspace: {
        ...basePlan.workspace,
        metadata: {
          ...baseMetadata,
          identity: { ...baseMetadata.identity, createdOnPlatform: 'code-review' },
        },
      },
    } satisfies FencedWrapperDispatchRequest;

    await orchestrator.execute(plan);

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          tools: { question: false, plan_enter: false, plan_exit: false },
        }),
      })
    );
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
    const { orchestrator, command, prompt } = createOrchestrator();

    await orchestrator.execute(commandPlan);

    expect(command).toHaveBeenCalledWith(commandRequest);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('preserves non-retryable workspace setup failures from the wrapper', async () => {
    const { orchestrator, prompt } = createOrchestrator();
    prompt.mockRejectedValueOnce(
      new WrapperError('Requested repository branch was not found', 'WORKSPACE_SETUP_FAILED', 503, {
        workspaceFailureSubtype: 'git_branch_missing',
        safeDetail: 'Requested repository branch was not found',
        retryable: false,
      })
    );

    await expect(orchestrator.execute(basePlan)).rejects.toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      retryable: false,
      workspaceFailureSubtype: 'git_branch_missing',
      safeFailureMessage: 'Requested repository branch was not found',
    } satisfies Partial<ExecutionError>);
  });

  it('keeps ordinary wrapper bootstrap failure retryable', async () => {
    const { orchestrator, ensureWrapper } = createOrchestrator();
    ensureWrapper.mockRejectedValueOnce(new Error('wrapper unavailable'));

    await expect(orchestrator.execute(basePlan)).rejects.toMatchObject({
      code: 'WRAPPER_START_FAILED',
      retryable: true,
    } satisfies Partial<ExecutionError>);
  });

  it('destroys enabled Code Reviewer sandboxes after wrapper bootstrap failure', async () => {
    const orgId = 'org_crv_ephemeral';
    const { orchestrator, ensureWrapper, deleteSandbox } = createOrchestrator({
      env: { CODE_REVIEW_EPHEMERAL_SANDBOX_ORG_IDS: orgId } as Env,
    });
    ensureWrapper.mockRejectedValueOnce(new Error('wrapper unavailable'));

    await expect(orchestrator.execute(codeReviewPlan(orgId))).rejects.toMatchObject({
      code: 'WRAPPER_START_FAILED',
      retryable: true,
    } satisfies Partial<ExecutionError>);
    expect(deleteSandbox).toHaveBeenCalledWith('recovery');
  });

  it('does not destroy non-crv sandboxes when rollout policy changes after allocation', async () => {
    const orgId = 'org_crv_ephemeral';
    const { orchestrator, ensureWrapper, deleteSandbox } = createOrchestrator({
      env: { CODE_REVIEW_EPHEMERAL_SANDBOX_ORG_IDS: orgId } as Env,
    });
    const plan = codeReviewPlan(orgId);
    ensureWrapper.mockRejectedValueOnce(new Error('wrapper unavailable'));

    await expect(
      orchestrator.execute({
        ...plan,
        workspace: {
          ...plan.workspace,
          sandboxId: 'org-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      })
    ).rejects.toMatchObject({
      code: 'WRAPPER_START_FAILED',
      retryable: true,
    } satisfies Partial<ExecutionError>);
    expect(deleteSandbox).not.toHaveBeenCalled();
  });

  it('destroys crv-* sandbox after wrapper bootstrap failure even if rollout policy changed', async () => {
    const { orchestrator, ensureWrapper, deleteSandbox } = createOrchestrator({
      env: { CODE_REVIEW_EPHEMERAL_SANDBOX_ORG_IDS: 'org_other' } as Env,
    });
    ensureWrapper.mockRejectedValueOnce(new Error('wrapper unavailable'));

    await expect(orchestrator.execute(codeReviewPlan('org_crv_ephemeral'))).rejects.toMatchObject({
      code: 'WRAPPER_START_FAILED',
      retryable: true,
    } satisfies Partial<ExecutionError>);
    expect(deleteSandbox).toHaveBeenCalledWith('recovery');
  });

  it('preserves a finalizing error from wrapper startup', async () => {
    const { orchestrator, ensureWrapper } = createOrchestrator();
    const finalizingError = new WrapperError(
      'Wrapper batch is finalizing',
      'WRAPPER_FINALIZING',
      409
    );
    ensureWrapper.mockRejectedValueOnce(finalizingError);

    await expect(orchestrator.execute(basePlan)).rejects.toBe(finalizingError);
  });

  it('preserves a finalizing error from wrapper dispatch', async () => {
    const { orchestrator, prompt } = createOrchestrator();
    const finalizingError = new WrapperError(
      'Wrapper batch is finalizing',
      'WRAPPER_FINALIZING',
      409
    );
    prompt.mockRejectedValueOnce(finalizingError);

    await expect(orchestrator.execute(basePlan)).rejects.toBe(finalizingError);
  });

  it('does not recover the shared sandbox for plain capacity admission rejection', async () => {
    const { orchestrator, ensureWrapper, deleteSandbox } = createOrchestrator();
    ensureWrapper.mockRejectedValueOnce(
      new WorkspaceCapacityAdmissionRejectedError({
        availableMB: 1024,
        thresholdMB: 2048,
        cleaned: 0,
        skipped: 1,
      })
    );

    await expect(orchestrator.execute(basePlan)).rejects.toThrow('Failed to start wrapper');
    expect(deleteSandbox).not.toHaveBeenCalled();
  });

  it('requests provider-neutral recovery cleanup on unusable capacity inspection', async () => {
    const { orchestrator, ensureWrapper, deleteSandbox } = createOrchestrator();
    ensureWrapper.mockRejectedValueOnce(
      new SandboxCapacityInspectionError('Cannot inspect capacity', new Error('ENOSPC'))
    );

    await expect(orchestrator.execute(basePlan)).rejects.toThrow('Failed to start wrapper');
    expect(deleteSandbox).toHaveBeenCalledWith('recovery');
  });

  it('requests provider-neutral recovery cleanup on infrastructure preparation failure', async () => {
    const { orchestrator, ensureWrapper, deleteSandbox } = createOrchestrator();
    const sandboxError = Object.assign(new Error('HTTP Error! status: 500'), {
      name: 'SandboxError',
      httpStatus: 500,
    });
    ensureWrapper.mockRejectedValueOnce(sandboxError);

    await expect(orchestrator.execute(basePlan)).rejects.toThrow('Failed to start wrapper');
    expect(deleteSandbox).toHaveBeenCalledWith('recovery');
  });
});
