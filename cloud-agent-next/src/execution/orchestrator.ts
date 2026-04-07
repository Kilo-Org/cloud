/**
 * ExecutionOrchestrator - Handles prompt execution.
 *
 * This module handles workspace preparation and execution, called directly
 * from the DO when a client sends a prompt.
 *
 */

import type {
  Env,
  ExecutionSession,
  SandboxInstance,
  SandboxId as ServiceSandboxId,
  SessionId as ServiceSessionId,
  SessionContext,
} from '../types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { ExecutionPlan, ExecutionResult } from './types.js';
import { ExecutionError } from './errors.js';
import { getGitCloneUrl, fromGitSource, getGithubRepo } from './git-source.js';
import { SessionService, determineBranchName, type PreparedSession } from '../session-service.js';
import { logger } from '../logger.js';
import { updateGitRemoteToken } from '../workspace.js';
import {
  WrapperClient,
  buildSupervisorPayload,
  type SupervisorInitPayload,
} from '../kilo/wrapper-client.js';
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

    // Per-session sandbox: supervisor mode
    if (sandboxId.startsWith('ses-')) {
      return this.executeSupervisor(sandbox, plan);
    }

    // Shared sandbox: existing path (unchanged)

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
        upstreamBranch: prepared.context.upstreamBranch,
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
  // Supervisor Mode
  // ---------------------------------------------------------------------------

  /**
   * Execute a prompt using supervisor mode (per-session sandboxes).
   * The supervisor wrapper runs at boot (container CMD) on port 5000.
   * Workspace setup + kilo startup happen inside the container via /job/init.
   */
  private async executeSupervisor(
    sandbox: SandboxInstance,
    plan: ExecutionPlan
  ): Promise<ExecutionResult> {
    const { executionId, sessionId, userId, prompt, mode, workspace, wrapper } = plan;

    // Create a session on the sandbox for exec operations (curl)
    const session = await sandbox.createSession();

    // Create supervisor-mode client (fixed port 5000)
    const wrapperClient = WrapperClient.forSupervisor(session);

    // Wait for the supervisor wrapper HTTP server to be ready
    try {
      await wrapperClient.waitForHealthy();
    } catch (error) {
      throw ExecutionError.wrapperStartFailed(
        `Supervisor wrapper not healthy: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    // Compute ingest details early — needed for init payload
    const ingestUrl = this.deps.getIngestUrl(sessionId, userId);
    const kilocodeToken = this.getKilocodeToken(plan);

    let kiloSessionId: string;

    if (workspace.shouldPrepare) {
      // First turn: build init payload (includes ingest details) and send /job/init
      const basePayload = this.buildSupervisorInitPayload(plan);
      const initPayload: SupervisorInitPayload = {
        ...basePayload,
        ingest: {
          url: ingestUrl,
          token: kilocodeToken,
          workerAuthToken: kilocodeToken,
        },
      };

      try {
        const initResponse = await wrapperClient.init(initPayload);
        if (initResponse.status !== 'ready' || !initResponse.kiloSessionId) {
          throw new Error(
            `Init failed at step ${initResponse.step ?? 'unknown'}: ${initResponse.message ?? 'unknown error'}`
          );
        }
        kiloSessionId = initResponse.kiloSessionId;
        logger.withFields({ kiloSessionId }).info('Supervisor init complete');
      } catch (error) {
        if (error instanceof ExecutionError) throw error;
        throw ExecutionError.workspaceSetupFailed(
          `Supervisor init failed: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }
    } else {
      // Resume: supervisor already initialized, reuse existing kiloSessionId
      const existingId = wrapper.kiloSessionId ?? workspace.existingMetadata?.kiloSessionId;
      if (!existingId) {
        throw ExecutionError.invalidRequest(
          'Cannot resume supervisor session: no kiloSessionId found in wrapper or existing metadata'
        );
      }
      kiloSessionId = existingId;
      logger
        .withFields({ kiloSessionId })
        .info('Supervisor resume, reusing existing kiloSessionId');

      if (workspace.resumeContext.githubToken || workspace.resumeContext.gitToken) {
        await this.updateSupervisorTokenOverrides(session, workspace);
      }
    }

    // Record activity for idle timeout tracking
    try {
      await withDORetry(
        () => this.deps.getSessionStub(userId, sessionId),
        stub => stub.recordKiloServerActivity(),
        'recordKiloServerActivity'
      );
    } catch {
      logger.warn('Failed to record kilo server activity');
    }

    // Send prompt with current ingest/auth binding so supervisor follow-up turns
    // refresh wrapper-side auth and log upload credentials just like shared mode.
    const normalizedMode = normalizeAgentMode(mode);
    try {
      const result = await wrapperClient.prompt({
        prompt,
        model: wrapper.model,
        variant: wrapper.variant,
        agent: normalizedMode,
        autoCommit: wrapper.autoCommit,
        condenseOnComplete: wrapper.condenseOnComplete,
        execution: {
          ingestUrl,
          ingestToken: kilocodeToken,
          workerAuthToken: kilocodeToken,
        },
        upstreamBranch: workspace.shouldPrepare
          ? workspace.initContext?.upstreamBranch
          : workspace.existingMetadata?.upstreamBranch,
      });
      logger.withFields({ inflightId: result.messageId }).info('Prompt sent to supervisor wrapper');
    } catch (error) {
      throw ExecutionError.wrapperStartFailed(
        `Failed to send prompt to supervisor: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    logger.info('Supervisor execution started successfully');
    return { kiloSessionId };
  }

  /**
   * Build the init payload for supervisor mode from the execution plan.
   */
  private buildSupervisorInitPayload(plan: ExecutionPlan): Omit<SupervisorInitPayload, 'ingest'> {
    const { sessionId, userId, orgId, workspace, wrapper } = plan;

    if (!workspace.shouldPrepare) {
      throw ExecutionError.invalidRequest(
        'Supervisor mode requires workspace preparation (shouldPrepare)'
      );
    }

    const initContext = workspace.initContext;
    if (!initContext) {
      throw ExecutionError.invalidRequest('Missing initContext for supervisor init');
    }

    if (!initContext.gitSource) {
      throw ExecutionError.invalidRequest('Missing git source in supervisor init');
    }

    const repoUrl = getGitCloneUrl(initContext.gitSource);
    const git = fromGitSource(initContext.gitSource);

    const branchName = determineBranchName(sessionId, initContext.upstreamBranch);
    const repoName = getGithubRepo(initContext.gitSource) ?? 'repo';
    const workspacePath = `/home/${sessionId}/workspace/${repoName}`;
    const sessionHome = `/home/${sessionId}`;

    const effectiveEnv = this.sessionService.getEffectiveSessionEnv({
      userEnvVars: initContext.envVars,
      sessionHome,
      sessionId,
      workspacePath,
      env: this.deps.env,
      kilocodeToken: initContext.kilocodeToken,
      kilocodeModel: initContext.kilocodeModel ?? 'default',
      orgId,
      githubToken: git.githubToken,
      githubRepo: git.githubRepo,
      encryptedSecrets: initContext.encryptedSecrets,
      createdOnPlatform: initContext.createdOnPlatform,
      appendSystemPrompt: workspace.existingMetadata?.appendSystemPrompt,
      gitUrl: git.gitUrl,
      gitToken: git.gitToken,
      platform: git.platform,
      mcpServers: initContext.mcpServers,
    });

    return buildSupervisorPayload({
      sessionId,
      userId,
      repoUrl,
      branchName,
      githubRepo: git.githubRepo,
      setupCommands: initContext.setupCommands,
      kilocodeToken: initContext.kilocodeToken,
      kiloSessionId: wrapper.kiloSessionId,
      env: effectiveEnv,
    });
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
      const git = fromGitSource(initContext.gitSource);

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
          githubRepo: git.githubRepo,
          githubToken: git.githubToken,
          gitUrl: git.gitUrl,
          gitToken: git.gitToken,
          platform: git.platform,
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

        if (!initContext.gitSource) {
          throw new Error('Prepared session is missing git source');
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
          ...git,
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
        ...git,
        env: this.deps.env,
        envVars: initContext.envVars,
        encryptedSecrets: initContext.encryptedSecrets,
        setupCommands: initContext.setupCommands,
        mcpServers: initContext.mcpServers,
        upstreamBranch: initContext.upstreamBranch,
        botId: initContext.botId,
        githubAppType: initContext.githubAppType,
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

    const metaGit = fromGitSource(existingMetadata.gitSource);

    try {
      if (resumeContext.githubToken && metaGit.githubRepo) {
        const gitUrl = `https://github.com/${metaGit.githubRepo}.git`;
        await updateGitRemoteToken(
          prepared.session,
          prepared.context.workspacePath,
          gitUrl,
          resumeContext.githubToken
        );
      }

      if (resumeContext.gitToken && metaGit.gitUrl) {
        await updateGitRemoteToken(
          prepared.session,
          prepared.context.workspacePath,
          metaGit.gitUrl,
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

  private async updateSupervisorTokenOverrides(
    session: ExecutionSession,
    workspace: ExecutionPlan['workspace']
  ): Promise<void> {
    if (workspace.shouldPrepare) return;

    const existingMetadata = workspace.existingMetadata;
    if (!existingMetadata?.workspacePath) {
      logger.warn('Missing workspacePath for supervisor token override update');
      return;
    }

    const metaGit = fromGitSource(existingMetadata.gitSource);

    try {
      if (workspace.resumeContext.githubToken && metaGit.githubRepo) {
        await updateGitRemoteToken(
          session,
          existingMetadata.workspacePath,
          `https://github.com/${metaGit.githubRepo}.git`,
          workspace.resumeContext.githubToken,
          'github'
        );
      }

      if (workspace.resumeContext.gitToken && metaGit.gitUrl) {
        await updateGitRemoteToken(
          session,
          existingMetadata.workspacePath,
          metaGit.gitUrl,
          workspace.resumeContext.gitToken,
          metaGit.platform
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
