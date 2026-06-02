/**
 * ExecutionOrchestrator - Handles provider-neutral wrapper delivery.
 *
 * AgentSandbox obtains the usable runtime/wrapper. This module preserves the
 * business sequence: prepare requests, ready the session when required, then
 * hand the accepted prompt or command to the wrapper.
 */

import type { Env } from '../types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type {
  ExecutionResult,
  FencedLegacyExecutionRequest,
  FencedWrapperDispatchRequest,
  WorkspaceReady,
} from './types.js';
import { ExecutionError } from './errors.js';
import { SessionService } from '../session-service.js';
import { logger } from '../logger.js';
import { WrapperError } from '../kilo/wrapper-client.js';
import { withDORetry } from '../utils/do-retry.js';
import { withTimeout } from '@kilocode/worker-utils';
import { logSandboxOperationTimeout } from '../sandbox-timeout-logging.js';
import { withPreparationInfrastructureRecovery } from '../sandbox-recovery.js';
import type { AgentSandbox, WrapperInstanceLease } from '../agent-sandbox/protocol.js';

/** Maximum time allowed for wrapper readiness workspace preparation. */
const PREPARE_WORKSPACE_TIMEOUT_MS = 10 * 60 * 1000;

const CODE_REVIEW_DISABLED_TOOLS = {
  question: false,
  plan_enter: false,
  plan_exit: false,
} satisfies Record<string, boolean>;

function withWorkspacePreparationTimeout<T>(operation: Promise<T>, step: string): Promise<T> {
  return withTimeout(
    operation,
    PREPARE_WORKSPACE_TIMEOUT_MS,
    `Workspace preparation timed out during ${step} after ${PREPARE_WORKSPACE_TIMEOUT_MS / 1000}s`,
    () =>
      logSandboxOperationTimeout({
        operation: `workspace.prepare:${step}`,
        timeoutMs: PREPARE_WORKSPACE_TIMEOUT_MS,
        timeoutLayer: 'outer',
      })
  );
}

export type OrchestratorDeps = {
  getAgentSandbox: (
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest
  ) => AgentSandbox;
  getSessionStub: (userId: string, sessionId: string) => DurableObjectStub<CloudAgentSession>;
  env: Env;
};

export class ExecutionOrchestrator {
  private readonly sessionService: SessionService;

  constructor(private readonly deps: OrchestratorDeps) {
    this.sessionService = new SessionService();
  }

  async execute(
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest,
    options?: {
      onProgress?: (step: string, message: string) => void;
      onWorkspaceReady?: (ready: WorkspaceReady) => Promise<void>;
      leasedInstance?: WrapperInstanceLease;
    }
  ): Promise<ExecutionResult> {
    const executionId = 'executionId' in plan ? plan.executionId : undefined;
    const { sessionId, userId, orgId } = plan.scope;
    const { workspace, agent, turn } = plan;

    logger.setTags({
      executionId,
      sessionId,
      userId,
      orgId: orgId ?? '(personal)',
      mode: agent.mode,
    });
    logger
      .withFields({
        messageId: turn.messageId,
        hasLegacyExecutionId: executionId !== undefined,
        sandboxId: workspace.sandboxId,
        hasAttachments: turn.type === 'prompt' && turn.attachments !== undefined,
        attachmentCount: turn.type === 'prompt' ? (turn.attachments?.files.length ?? 0) : 0,
        wrapperHasKiloSessionId: plan.wrapper.kiloSessionId !== undefined,
      })
      .info('ExecutionOrchestrator starting execution');

    if (!workspace.sandboxId) {
      throw ExecutionError.invalidRequest('Missing sandboxId in workspace plan');
    }

    const sandbox = this.deps.getAgentSandbox(plan);
    return withPreparationInfrastructureRecovery(
      {
        deleteSandbox: reason => sandbox.delete(reason),
        sandboxId: workspace.sandboxId,
        sessionId,
        phase: 'executionWorkspacePreparation',
      },
      () => this.executeThroughAgentSandbox(sandbox, plan, options)
    );
  }

  private async executeThroughAgentSandbox(
    sandbox: AgentSandbox,
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest,
    options?: {
      onProgress?: (step: string, message: string) => void;
      onWorkspaceReady?: (ready: WorkspaceReady) => Promise<void>;
      leasedInstance?: WrapperInstanceLease;
    }
  ): Promise<ExecutionResult> {
    const { sessionId, userId } = plan.scope;
    const { turn } = plan;
    const prepared = await this.sessionService.buildWrapperSessionReadyAndPromptRequests({
      env: this.deps.env,
      plan,
    });
    const toolOverrides = this.getToolOverrides(plan);
    if (toolOverrides && prepared.type === 'prompt') {
      prepared.promptRequest.agent = {
        ...prepared.promptRequest.agent,
        tools: toolOverrides,
      };
    }

    let ensured;
    try {
      ensured = await sandbox.ensureWrapper({
        plan,
        prepared,
        onProgress: options?.onProgress,
        ...(options?.leasedInstance ? { leasedInstance: options.leasedInstance } : {}),
      });
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw ExecutionError.wrapperStartFailed(
        `Failed to start wrapper: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    let kiloSessionId: string;
    try {
      if (ensured.status === 'session-ready') {
        kiloSessionId = ensured.kiloSessionId;
        await options?.onWorkspaceReady?.(ensured.ready);
      } else {
        const readyResult = await withWorkspacePreparationTimeout(
          ensured.client.ensureSessionReady(prepared.readyRequest),
          'wrapper readiness'
        );
        kiloSessionId = readyResult.kiloSessionId;
        await options?.onWorkspaceReady?.(
          readyResult.workspaceReady
            ? { ...prepared.ready, ...readyResult.workspaceReady }
            : prepared.ready
        );
      }

      if (prepared.type === 'command') {
        await ensured.client.command(prepared.commandRequest);
        logger
          .withFields({
            sessionId,
            messageId: turn.messageId,
            command: prepared.commandRequest.command,
          })
          .info('Wrapper accepted command dispatch');
      } else {
        await ensured.client.prompt(prepared.promptRequest);
        logger
          .withFields({ sessionId, messageId: turn.messageId })
          .info('Wrapper accepted prompt dispatch');
      }

      try {
        await withDORetry(
          () => this.deps.getSessionStub(userId, sessionId),
          stub => stub.recordKiloServerActivity(),
          'recordKiloServerActivity'
        );
      } catch {
        logger
          .withFields({ sessionId, messageId: turn.messageId })
          .warn('Failed to record kilo server activity');
      }
      logger.info('ExecutionOrchestrator wrapper execution started successfully');
      return { kiloSessionId };
    } catch (error) {
      logger
        .withFields({
          sessionId,
          messageId: turn.messageId,
          errorClass: error instanceof Error ? error.name : 'UnknownError',
          wrapperErrorCode: error instanceof WrapperError ? error.code : undefined,
        })
        .warn('ExecutionOrchestrator wrapper dispatch failed');
      if (error instanceof WrapperError) {
        if (error.code === 'WORKSPACE_SETUP_FAILED') {
          throw ExecutionError.workspaceSetupFailed(error.message, error);
        }
        if (error.code === 'KILO_SERVER_FAILED') {
          throw ExecutionError.kiloServerFailed(error.message, error);
        }
      }
      if (error instanceof ExecutionError) throw error;
      throw ExecutionError.wrapperStartFailed(
        `Failed to execute wrapper bootstrap: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  private getToolOverrides(
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest
  ): Record<string, boolean> | undefined {
    return plan.workspace.metadata.identity?.createdOnPlatform === 'code-review'
      ? CODE_REVIEW_DISABLED_TOOLS
      : undefined;
  }
}
