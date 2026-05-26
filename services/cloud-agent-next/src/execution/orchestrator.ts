/**
 * ExecutionOrchestrator - Handles prompt execution.
 *
 * This module handles workspace preparation and execution, called directly
 * from the DO when a client sends a prompt.
 */

import type {
  Env,
  SandboxInstance,
  SandboxId as ServiceSandboxId,
  SessionId as ServiceSessionId,
} from '../types.js';
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
import {
  FAST_SANDBOX_COMMAND_TIMEOUT_MS,
  logSandboxOperationTimeout,
  timedExec,
} from '../sandbox-timeout-logging.js';
import { WrapperClient, WrapperError } from '../kilo/wrapper-client.js';
import { withDORetry } from '../utils/do-retry.js';
import { withTimeout } from '@kilocode/worker-utils';
import {
  SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE,
  withPreparationInfrastructureRecovery,
} from '../sandbox-recovery.js';
import { checkDiskAndCleanBeforeSetup } from '../workspace.js';

/** Maximum time allowed for workspace preparation (resume, init, fast path). */
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dependencies for the orchestrator (for testability via dependency injection).
 */
export type OrchestratorDeps = {
  /** Get a sandbox instance by ID */
  getSandbox: (sandboxId: string) => Promise<SandboxInstance>;
  /** Get a Durable Object stub for a session */
  getSessionStub: (userId: string, sessionId: string) => DurableObjectStub<CloudAgentSession>;
  /** Environment bindings */
  env: Env;
};

// ---------------------------------------------------------------------------
// ExecutionOrchestrator
// ---------------------------------------------------------------------------

export class ExecutionOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly sessionService: SessionService;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.sessionService = new SessionService();
  }

  /**
   * Execute a prompt. Handles all setup and returns immediately after prompt is sent.
   * Events stream asynchronously via wrapper -> ingest WS.
   *
   * @throws ExecutionError with appropriate code on failure (no internal retry)
   */
  async execute(
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest,
    options?: {
      onProgress?: (step: string, message: string) => void;
      onWorkspaceReady?: (ready: WorkspaceReady) => Promise<void>;
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
        hasImages: turn.type === 'prompt' && turn.images !== undefined,
        imageCount: turn.type === 'prompt' ? (turn.images?.files.length ?? 0) : 0,
        wrapperHasKiloSessionId: plan.wrapper.kiloSessionId !== undefined,
      })
      .info('ExecutionOrchestrator starting execution');

    const sandboxId = workspace.sandboxId;
    if (!sandboxId) {
      throw ExecutionError.invalidRequest('Missing sandboxId in workspace plan');
    }

    let sandbox: SandboxInstance;
    try {
      sandbox = await this.deps.getSandbox(sandboxId);
    } catch (error) {
      throw ExecutionError.sandboxConnectFailed(
        `Failed to connect to sandbox: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    return withPreparationInfrastructureRecovery(
      {
        sandbox,
        sandboxId,
        sessionId,
        phase: 'executionWorkspacePreparation',
      },
      () => this.executeWithWrapperBootstrap(sandbox, plan, options)
    );
  }

  private requiresPreparedDevcontainerRuntime(
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest
  ): boolean {
    return (
      plan.workspace.metadata.workspace?.devcontainerRequested === true ||
      plan.workspace.metadata.devcontainer !== undefined
    );
  }

  private async executeWithPreparedDevcontainerWorkspace(
    sandbox: SandboxInstance,
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest,
    prepared: Awaited<ReturnType<SessionService['buildWrapperSessionReadyAndPromptRequests']>>,
    options?: {
      onProgress?: (step: string, message: string) => void;
      onWorkspaceReady?: (ready: WorkspaceReady) => Promise<void>;
    }
  ): Promise<ExecutionResult> {
    const { sessionId, userId, orgId } = plan.scope;
    const { turn, workspace, agent } = plan;
    const preparedWorkspace = await withWorkspacePreparationTimeout(
      this.sessionService.prepareWorkspace({
        sandbox,
        sandboxId: workspace.sandboxId as ServiceSandboxId,
        orgId,
        userId,
        sessionId: sessionId as ServiceSessionId,
        kilocodeModel: agent.model,
        env: this.deps.env,
        metadata: workspace.metadata,
        onProgress: options?.onProgress,
      }),
      'devcontainer workspace preparation'
    );

    if (!preparedWorkspace.devcontainer || !preparedWorkspace.ready.devcontainer) {
      throw ExecutionError.workspaceSetupFailed(
        'Devcontainer workspace preparation did not resolve runtime metadata'
      );
    }

    let wrapperClient: WrapperClient;
    let kiloSessionId: string;
    try {
      const wrapper = await WrapperClient.ensureWrapper(sandbox, preparedWorkspace.session, {
        agentSessionId: sessionId,
        userId,
        workspacePath: preparedWorkspace.context.workspacePath,
        sessionId: plan.wrapper.kiloSessionId,
        runtimeEnv: preparedWorkspace.runtimeEnv,
        devcontainer: preparedWorkspace.devcontainer,
        fixedPort: preparedWorkspace.ready.devcontainer.wrapperPort,
      });
      wrapperClient = wrapper.client;
      kiloSessionId = wrapper.sessionId;
    } catch (error) {
      throw ExecutionError.wrapperStartFailed(
        `Failed to start devcontainer wrapper: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    await options?.onWorkspaceReady?.(preparedWorkspace.ready);

    if (prepared.type === 'command') {
      await wrapperClient.command(prepared.commandRequest);
    } else {
      await wrapperClient.prompt(prepared.promptRequest);
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

    logger
      .withFields({ sessionId, messageId: turn.messageId })
      .info('ExecutionOrchestrator devcontainer execution started successfully');
    return { kiloSessionId };
  }

  private async workspaceHasGit(sandbox: SandboxInstance, workspacePath: string): Promise<boolean> {
    const timeoutMs = FAST_SANDBOX_COMMAND_TIMEOUT_MS;
    const result = await withTimeout(
      timedExec(
        sandbox,
        `test -d '${workspacePath}/.git' && echo exists`,
        'execution.wrapperBootstrap.repoExists'
      ),
      timeoutMs,
      `${SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE} after ${timeoutMs}ms`,
      () =>
        logSandboxOperationTimeout({
          operation: 'execution.wrapperBootstrap.repoExists',
          timeoutMs,
          timeoutLayer: 'outer',
        })
    );
    return result.stdout?.includes('exists') ?? false;
  }

  private async executeWithWrapperBootstrap(
    sandbox: SandboxInstance,
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest,
    options?: {
      onProgress?: (step: string, message: string) => void;
      onWorkspaceReady?: (ready: WorkspaceReady) => Promise<void>;
    }
  ): Promise<ExecutionResult> {
    const { sessionId, userId, orgId } = plan.scope;
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

    if (this.requiresPreparedDevcontainerRuntime(plan)) {
      return this.executeWithPreparedDevcontainerWorkspace(sandbox, plan, prepared, options);
    }

    const workspaceWarm = await this.workspaceHasGit(sandbox, prepared.context.workspacePath);
    logger
      .withFields({
        sessionId,
        messageId: turn.messageId,
        workspacePath: prepared.context.workspacePath,
        workspaceWarm,
      })
      .info('Workspace warmth probe completed');
    if (!workspaceWarm) {
      options?.onProgress?.('disk_check', 'Checking disk space...');
      await checkDiskAndCleanBeforeSetup(sandbox, orgId, userId, sessionId);
    }

    const bootstrapSession = await sandbox.createSession({
      name: `${sessionId}-bootstrap`,
      env: {},
      cwd: '/',
    });

    let wrapperClient: WrapperClient;
    try {
      if (!workspaceWarm) {
        options?.onProgress?.('kilo_server', 'Starting Kilo...');
      }
      const result = await WrapperClient.ensureBootstrapWrapper(sandbox, bootstrapSession, {
        agentSessionId: sessionId,
        userId,
      });
      wrapperClient = result.client;
      logger
        .withFields({ sessionId, messageId: turn.messageId, workspaceWarm })
        .info('Bootstrap wrapper ready');
    } catch (error) {
      throw ExecutionError.wrapperStartFailed(
        `Failed to start wrapper: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    try {
      const readyResult = await withWorkspacePreparationTimeout(
        wrapperClient.ensureSessionReady(prepared.readyRequest),
        'wrapper readiness'
      );
      logger
        .withFields({
          sessionId,
          messageId: turn.messageId,
          kiloSessionId: readyResult.kiloSessionId,
        })
        .info('Wrapper session readiness completed');

      if (options?.onWorkspaceReady) {
        await options.onWorkspaceReady(
          readyResult.workspaceReady
            ? { ...prepared.ready, ...readyResult.workspaceReady }
            : prepared.ready
        );
      }

      if (prepared.type === 'command') {
        await wrapperClient.command(prepared.commandRequest);
        logger
          .withFields({
            sessionId,
            messageId: turn.messageId,
            command: prepared.commandRequest.command,
          })
          .info('Wrapper accepted command dispatch');
      } else {
        await wrapperClient.prompt(prepared.promptRequest);
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

      logger.info('ExecutionOrchestrator wrapper bootstrap execution started successfully');
      return { kiloSessionId: readyResult.kiloSessionId };
    } catch (error) {
      logger
        .withFields({
          sessionId,
          messageId: turn.messageId,
          errorClass: error instanceof Error ? error.name : 'UnknownError',
          wrapperErrorCode: error instanceof WrapperError ? error.code : undefined,
        })
        .warn('ExecutionOrchestrator wrapper bootstrap path failed');
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

  private getCreatedOnPlatform(
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest
  ): string | undefined {
    return plan.workspace.metadata?.identity?.createdOnPlatform;
  }

  private getToolOverrides(
    plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest
  ): Record<string, boolean> | undefined {
    return this.getCreatedOnPlatform(plan) === 'code-review'
      ? CODE_REVIEW_DISABLED_TOOLS
      : undefined;
  }
}
