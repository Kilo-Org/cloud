/**
 * ExecutionOrchestrator - Handles prompt execution.
 *
 * This module handles workspace preparation and execution, called directly
 * from the DO when a client sends a prompt.
 *
 */

import type {
  Env,
  SandboxInstance,
  SandboxId as ServiceSandboxId,
  SessionId as ServiceSessionId,
  SessionContext,
} from '../types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { ExecutionPlan, ExecutionResult } from './types.js';
import { ExecutionError } from './errors.js';
import { SessionService, type PreparedSession } from '../session-service.js';
import { logger } from '../logger.js';
import { updateGitRemoteToken } from '../workspace.js';
import { WrapperClient } from '../kilo/wrapper-client.js';
import { withDORetry } from '../utils/do-retry.js';
import { normalizeAgentMode } from '../schema.js';

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
  /** Get the ingest URL for the session */
  getIngestUrl: (sessionId: string, userId: string) => string;
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
    plan: ExecutionPlan,
    options?: { onProgress?: (step: string, message: string) => void }
  ): Promise<ExecutionResult> {
    const { executionId, sessionId, userId, orgId, prompt, mode, workspace, wrapper } = plan;

    logger.setTags({
      executionId,
      sessionId,
      userId,
      orgId: orgId ?? '(personal)',
      mode,
      isInitialize: workspace.shouldPrepare,
    });

    logger.info('ExecutionOrchestrator starting execution');

    // 1. Get sandbox (may throw SANDBOX_CONNECT_FAILED)
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

    // 2. Workspace preparation (may throw WORKSPACE_SETUP_FAILED)
    const prepared = await this.prepareWorkspace(sandbox, plan, options?.onProgress);

    // 3. Update git remote token if needed (resume path with token overrides)
    if (!workspace.shouldPrepare) {
      const resumeContext = workspace.resumeContext;
      if (resumeContext.githubToken || resumeContext.gitToken) {
        await this.updateTokenOverrides(prepared, workspace);
      }
    }

    // 4. Ensure wrapper is running (starts kilo server in-process)
    let wrapperClient: WrapperClient;
    let kiloSessionId: string;
    try {
      const result = await WrapperClient.ensureWrapper(sandbox, prepared.session, {
        agentSessionId: sessionId,
        userId,
        workspacePath: prepared.context.workspacePath,
        sessionId: wrapper.kiloSessionId,
      });
      wrapperClient = result.client;
      kiloSessionId = result.sessionId;
    } catch (error) {
      throw ExecutionError.wrapperStartFailed(
        `Failed to start wrapper: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    // 5. Record activity for idle timeout tracking
    try {
      await withDORetry(
        () => this.deps.getSessionStub(userId, sessionId),
        stub => stub.recordKiloServerActivity(),
        'recordKiloServerActivity'
      );
    } catch {
      // Non-fatal - log but continue
      logger.warn('Failed to record kilo server activity');
    }

    // 6. Send prompt with execution binding (async - returns messageId immediately)
    const ingestUrl = this.deps.getIngestUrl(sessionId, userId);
    const ingestToken = executionId;
    const kilocodeToken = this.getKilocodeToken(plan);

    const execution = {
      executionId,
      ingestUrl,
      ingestToken,
      workerAuthToken: kilocodeToken,
      upstreamBranch: prepared.context.upstreamBranch,
    };

    // Normalize mode to internal mode (e.g., 'architect' -> 'plan', 'orchestrator' -> 'code')
    const normalizedMode = normalizeAgentMode(mode);
    try {
      const result = await wrapperClient.prompt({
        prompt,
        model: wrapper.model,
        variant: wrapper.variant,
        agent: normalizedMode,
        autoCommit: wrapper.autoCommit,
        condenseOnComplete: wrapper.condenseOnComplete,
        execution,
      });
      logger.withFields({ inflightId: result.messageId }).info('Prompt sent to wrapper');
    } catch (error) {
      throw ExecutionError.wrapperStartFailed(
        `Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    logger.info('ExecutionOrchestrator execution started successfully');
    return { kiloSessionId };
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Prepare workspace based on the workspace plan.
   * Handles three paths: resume, fast path (fully prepared), and full init.
   */
  private async prepareWorkspace(
    sandbox: SandboxInstance,
    plan: ExecutionPlan,
    onProgress?: (step: string, message: string) => void
  ): Promise<PreparedSession> {
    const { workspace, sessionId, userId, orgId } = plan;

    try {
      if (!workspace.shouldPrepare) {
        // Resume path - workspace already set up
        const resumeContext = workspace.resumeContext;

        if (!resumeContext.kilocodeToken) {
          throw new Error('Missing kilocodeToken in resume context');
        }

        return await this.sessionService.resume({
          sandbox,
          sandboxId: workspace.sandboxId as ServiceSandboxId,
          orgId,
          userId,
          sessionId: sessionId as ServiceSessionId,
          kilocodeToken: resumeContext.kilocodeToken,
          kilocodeModel: resumeContext.kilocodeModel ?? 'default',
          env: this.deps.env,
          githubToken: resumeContext.githubToken,
          gitToken: resumeContext.gitToken,
          onProgress,
        });
      }

      const initContext = workspace.initContext;
      if (!initContext) {
        throw new Error('Missing initContext in workspace plan');
      }

      const existingMetadata = workspace.existingMetadata;

      // Fast path: fully prepared via prepareSession
      // Fast path: fully prepared session with all required metadata
      if (
        initContext.isPreparedSession &&
        existingMetadata?.workspacePath &&
        existingMetadata?.sandboxId &&
        existingMetadata?.sessionHome &&
        existingMetadata?.branchName
      ) {
        logger.info('Using fast path for fully prepared session');

        const context: SessionContext = {
          sandboxId: existingMetadata.sandboxId as ServiceSandboxId,
          sessionId: sessionId as ServiceSessionId,
          sessionHome: existingMetadata.sessionHome,
          workspacePath: existingMetadata.workspacePath,
          branchName: existingMetadata.branchName,
          upstreamBranch: existingMetadata.upstreamBranch,
          orgId,
          userId,
          botId: initContext.botId,
          githubRepo: initContext.githubRepo,
          githubToken: initContext.githubToken,
          gitUrl: initContext.gitUrl,
          gitToken: initContext.gitToken,
          platform: initContext.platform,
          envVars: initContext.envVars,
        };

        const session = await this.sessionService.getOrCreateSession(
          sandbox,
          context,
          this.deps.env,
          initContext.kilocodeToken,
          initContext.kilocodeModel ?? 'default',
          orgId,
          initContext.encryptedSecrets,
          initContext.createdOnPlatform,
          existingMetadata.appendSystemPrompt
        );

        return {
          context,
          session,
        };
      }

      // Legacy prepared session path
      if (initContext.isPreparedSession && initContext.kiloSessionId) {
        logger.info('Using legacy prepared session path');

        const gitSource = initContext.githubRepo
          ? { githubRepo: initContext.githubRepo, githubToken: initContext.githubToken }
          : initContext.gitUrl
            ? { gitUrl: initContext.gitUrl, gitToken: initContext.gitToken }
            : null;

        if (!gitSource) {
          throw new Error('Prepared session is missing git source');
        }

        if (!initContext.kiloSessionId) {
          throw new Error('Prepared session is missing kiloSessionId');
        }

        return await this.sessionService.initiateFromKiloSessionWithRetry({
          getSandbox: () => this.deps.getSandbox(workspace.sandboxId ?? ''),
          sandboxId: (workspace.sandboxId ?? '') as ServiceSandboxId,
          orgId,
          userId,
          sessionId: sessionId as ServiceSessionId,
          kilocodeToken: initContext.kilocodeToken,
          kilocodeModel: initContext.kilocodeModel ?? 'default',
          kiloSessionId: initContext.kiloSessionId,
          env: this.deps.env,
          envVars: initContext.envVars,
          encryptedSecrets: initContext.encryptedSecrets,
          setupCommands: initContext.setupCommands,
          mcpServers: initContext.mcpServers,
          botId: initContext.botId,
          githubAppType: initContext.githubAppType,
          createdOnPlatform: initContext.createdOnPlatform,
          // Note: existingMetadata requires CloudAgentSessionState, not our simplified type
          ...gitSource,
        });
      }

      // Brand new session
      logger.info('Initializing new session');
      return await this.sessionService.initiateWithRetry({
        getSandbox: () => this.deps.getSandbox(workspace.sandboxId ?? ''),
        sandboxId: (workspace.sandboxId ?? '') as ServiceSandboxId,
        orgId,
        userId,
        sessionId: sessionId as ServiceSessionId,
        kilocodeToken: initContext.kilocodeToken,
        kilocodeModel: initContext.kilocodeModel ?? 'default',
        githubRepo: initContext.githubRepo,
        githubToken: initContext.githubToken,
        gitUrl: initContext.gitUrl,
        gitToken: initContext.gitToken,
        env: this.deps.env,
        envVars: initContext.envVars,
        encryptedSecrets: initContext.encryptedSecrets,
        setupCommands: initContext.setupCommands,
        mcpServers: initContext.mcpServers,
        upstreamBranch: initContext.upstreamBranch,
        botId: initContext.botId,
        githubAppType: initContext.githubAppType,
        platform: initContext.platform,
        createdOnPlatform: initContext.createdOnPlatform,
      });
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw ExecutionError.workspaceSetupFailed(
        `Failed to prepare workspace: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update git remote token for resume path with token overrides.
   */
  private async updateTokenOverrides(
    prepared: PreparedSession,
    workspace: ExecutionPlan['workspace']
  ): Promise<void> {
    if (workspace.shouldPrepare) return;

    const resumeContext = workspace.resumeContext;
    const existingMetadata = workspace.existingMetadata;

    if (!existingMetadata) {
      logger.warn('Missing metadata for token override update');
      return;
    }

    try {
      if (resumeContext.githubToken && existingMetadata.githubRepo) {
        const gitUrl = `https://github.com/${existingMetadata.githubRepo}.git`;
        await updateGitRemoteToken(
          prepared.session,
          prepared.context.workspacePath,
          gitUrl,
          resumeContext.githubToken
        );
      }

      if (resumeContext.gitToken && existingMetadata.gitUrl) {
        await updateGitRemoteToken(
          prepared.session,
          prepared.context.workspacePath,
          existingMetadata.gitUrl,
          resumeContext.gitToken,
          prepared.context.platform
        );
      }
    } catch (error) {
      throw ExecutionError.workspaceSetupFailed(
        `Failed to update git remote token: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Get the kilocode token from the plan.
   */
  private getKilocodeToken(plan: ExecutionPlan): string {
    const { workspace } = plan;

    if (!workspace.shouldPrepare) {
      return workspace.resumeContext.kilocodeToken;
    }

    const initContext = workspace.initContext;
    if (initContext?.kilocodeToken) {
      return initContext.kilocodeToken;
    }

    throw ExecutionError.invalidRequest('Missing kilocodeToken in execution plan');
  }
}
