/**
 * Core queue consumer logic without sandbox dependencies.
 *
 * This module provides the queue consumer implementation that can be used
 * in tests without requiring @cloudflare/sandbox imports. The actual
 * sandbox dependencies are injected via ConsumerDeps.
 *
 * @example
 * ```ts
 * // In tests:
 * import { createQueueConsumerWithDeps } from '../src/queue/consumer-core.js';
 *
 * const mockDeps = {
 *   getSandbox: async () => mockSandbox,
 *   getSessionStub: (userId, sessionId) => mockStub,
 * };
 *
 * const consumer = createQueueConsumerWithDeps(mockDeps);
 * await consumer(batch, env, ctx);
 * ```
 */

import type { ExecutionMessage } from './types.js';
import type {
  Env,
  SandboxInstance,
  SandboxId as ServiceSandboxId,
  SessionId as ServiceSessionId,
} from '../types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import { SessionService, type PreparedSession } from '../session-service.js';
import { logger } from '../logger.js';
import { updateGitRemoteToken } from '../workspace.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dependencies for the consumer (for testability via dependency injection).
 */
export type ConsumerDeps = {
  /** Get a sandbox instance by ID */
  getSandbox: (sandboxId: string) => Promise<SandboxInstance>;
  /** Get a Durable Object stub for a session */
  getSessionStub: (userId: string, sessionId: string) => DurableObjectStub<CloudAgentSession>;
};

/**
 * Maximum number of retry attempts before giving up.
 */
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Error codes that indicate a transient issue worth retrying.
 */
const RETRYABLE_ERROR_CODES = ['SANDBOX_CONNECT_FAILED', 'WORKSPACE_SETUP_FAILED'] as const;

// ---------------------------------------------------------------------------
// Core Queue Consumer Factory
// ---------------------------------------------------------------------------

/**
 * Create a queue consumer handler function with injected dependencies.
 *
 * This factory allows tests to provide mock dependencies without
 * importing @cloudflare/sandbox which can't be resolved in vitest.
 *
 * @param deps - Consumer dependencies for accessing session DOs and sandbox
 * @returns Queue handler function compatible with Cloudflare Workers
 *
 * @example
 * ```ts
 * const mockDeps = {
 *   getSandbox: async () => mockSandbox,
 *   getSessionStub: (userId, sessionId) => mockStub,
 * };
 *
 * const consumer = createQueueConsumerWithDeps(mockDeps);
 * await consumer(batch, env, ctx);
 * ```
 */
export function createQueueConsumerWithDeps(deps: ConsumerDeps) {
  return async function queue(
    batch: MessageBatch<ExecutionMessage>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message.body, env, deps);
        message.ack();
      } catch (error) {
        const errorCode = error instanceof ConsumerError ? error.code : 'UNKNOWN';
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger
          .withFields({
            executionId: message.body.executionId,
            errorCode,
            error: errorMessage,
          })
          .error('Error processing message');

        // Check if error is retryable
        if (isRetryableError(errorCode) && message.attempts < MAX_RETRY_ATTEMPTS) {
          const delaySeconds = Math.pow(2, message.attempts);
          message.retry({ delaySeconds });
        } else {
          // Terminal error or max retries reached - ack to prevent infinite loop
          // Also notify DO of failure
          try {
            const sessionStub = deps.getSessionStub(message.body.userId, message.body.sessionId);
            await sessionStub.onExecutionComplete(message.body.executionId, 'failed', errorMessage);
          } catch {
            // Ignore DO update failures
          }
          message.ack();
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Message Processing
// ---------------------------------------------------------------------------

/**
 * Process a single execution message.
 *
 * This function handles workspace preparation and wrapper startup.
 * The wrapper process handles all streaming, event capture, and cleanup.
 */
async function processMessage(msg: ExecutionMessage, env: Env, deps: ConsumerDeps): Promise<void> {
  const { executionId, sessionId, sandboxId, userId, orgId, prompt, mode, appendSystemPrompt } =
    msg;
  if (!msg.launchPlan) {
    throw new ConsumerError('WORKSPACE_SETUP_FAILED', 'Missing launch plan for V2 execution');
  }
  const plan = msg.launchPlan;
  const resolvedSandboxId = plan.sandboxId ?? sandboxId;

  logger.setTags({
    executionId,
    sessionId,
    userId,
    sandboxId: resolvedSandboxId,
    orgId: orgId ?? '(personal)',
    mode,
    isInitialize: plan.workspace.shouldPrepare,
  });

  logger.info('Queue consumer processing message');

  // 1. Get sandbox instance
  let sandbox: SandboxInstance;
  try {
    sandbox = await deps.getSandbox(resolvedSandboxId);
  } catch (error) {
    throw new ConsumerError(
      'SANDBOX_CONNECT_FAILED',
      `Failed to connect to sandbox: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 2. Prepare workspace if this is initialization
  let prepared: PreparedSession | null = null;
  const sessionService = new SessionService();

  if (typeof plan.workspace.shouldPrepare !== 'boolean') {
    throw new ConsumerError('WORKSPACE_SETUP_FAILED', 'Invalid launch plan for V2 execution');
  }

  const shouldPrepare = plan.workspace.shouldPrepare;
  const initContext = plan.workspace.initContext;
  const resumeContext = plan.workspace.resumeContext;

  const planMetadata = plan.workspace.existingMetadata;
  let resumeTokenOverrides: { githubToken?: string; gitToken?: string } | null = null;

  if (shouldPrepare) {
    const ctx = initContext;
    if (!ctx) {
      throw new ConsumerError('WORKSPACE_SETUP_FAILED', 'Missing initializeContext');
    }
    logger.info('Preparing workspace for initialization');

    try {
      // Check if this is a prepared session (via prepareSession flow)
      if (ctx.isPreparedSession && ctx.kiloSessionId) {
        let existingMetadata = plan.workspace.existingMetadata;
        if (!existingMetadata?.initiatedAt) {
          const sessionStub = deps.getSessionStub(userId, sessionId);
          existingMetadata = (await sessionStub.getMetadata()) ?? existingMetadata;
        }

        // Build git source options
        const gitSource = ctx.githubRepo
          ? { githubRepo: ctx.githubRepo, githubToken: ctx.githubToken }
          : ctx.gitUrl
            ? { gitUrl: ctx.gitUrl, gitToken: ctx.gitToken }
            : null;

        if (!gitSource) {
          throw new ConsumerError(
            'WORKSPACE_SETUP_FAILED',
            'Prepared session is missing git source (githubRepo or gitUrl)'
          );
        }

        prepared = await sessionService.initiateFromKiloSessionWithRetry({
          getSandbox: () => deps.getSandbox(resolvedSandboxId),
          sandboxId: resolvedSandboxId as ServiceSandboxId,
          orgId,
          userId,
          sessionId: sessionId as ServiceSessionId,
          kilocodeToken: ctx.kilocodeToken,
          kilocodeModel: ctx.kilocodeModel ?? 'default',
          kiloSessionId: ctx.kiloSessionId,
          env,
          envVars: ctx.envVars,
          encryptedSecrets: ctx.encryptedSecrets,
          setupCommands: ctx.setupCommands,
          mcpServers: ctx.mcpServers,
          botId: ctx.botId,
          skipLinking: true,
          githubAppType: ctx.githubAppType,
          existingMetadata,
          ...gitSource,
        });
      } else {
        // Brand new session - use initiate()
        prepared = await sessionService.initiateWithRetry({
          getSandbox: () => deps.getSandbox(resolvedSandboxId),
          sandboxId: resolvedSandboxId as ServiceSandboxId,
          orgId,
          userId,
          sessionId: sessionId as ServiceSessionId,
          kilocodeToken: ctx.kilocodeToken,
          kilocodeModel: ctx.kilocodeModel ?? 'default',
          githubRepo: ctx.githubRepo,
          githubToken: ctx.githubToken,
          gitUrl: ctx.gitUrl,
          gitToken: ctx.gitToken,
          platform: ctx.platform,
          env,
          envVars: ctx.envVars,
          encryptedSecrets: ctx.encryptedSecrets,
          setupCommands: ctx.setupCommands,
          mcpServers: ctx.mcpServers,
          upstreamBranch: ctx.upstreamBranch,
          botId: ctx.botId,
          githubAppType: ctx.githubAppType,
        });
      }
    } catch (error) {
      if (error instanceof ConsumerError) throw error;
      throw new ConsumerError(
        'WORKSPACE_SETUP_FAILED',
        `Failed to prepare workspace: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    if (!resumeContext) {
      throw new ConsumerError('WORKSPACE_SETUP_FAILED', 'Missing resume context for V2 execution');
    }

    if (!resumeContext.kilocodeToken) {
      throw new ConsumerError(
        'WORKSPACE_SETUP_FAILED',
        'Missing kilocodeToken in session metadata'
      );
    }

    if (resumeContext.githubToken || resumeContext.gitToken) {
      resumeTokenOverrides = {
        githubToken: resumeContext.githubToken,
        gitToken: resumeContext.gitToken,
      };
    }

    try {
      prepared = await sessionService.resume({
        sandbox,
        sandboxId: resolvedSandboxId as ServiceSandboxId,
        orgId,
        userId,
        sessionId: sessionId as ServiceSessionId,
        kilocodeToken: resumeContext.kilocodeToken,
        kilocodeModel: resumeContext.kilocodeModel ?? 'default',
        configure: true,
        env,
        githubToken: resumeContext.githubToken,
        gitToken: resumeContext.gitToken,
      });
    } catch (error) {
      throw new ConsumerError(
        'WORKSPACE_SETUP_FAILED',
        `Failed to resume session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (resumeTokenOverrides && (resumeTokenOverrides.githubToken || resumeTokenOverrides.gitToken)) {
    if (!planMetadata) {
      logger.warn('Missing metadata in launch plan for token override update');
    } else {
      try {
        if (resumeTokenOverrides.githubToken) {
          if (planMetadata.githubRepo) {
            const gitUrl = `https://github.com/${planMetadata.githubRepo}.git`;
            await updateGitRemoteToken(
              prepared.session,
              prepared.context.workspacePath,
              gitUrl,
              resumeTokenOverrides.githubToken
            );
          } else {
            logger.warn('githubToken override provided but session is not GitHub-based');
          }
        }

        if (resumeTokenOverrides.gitToken) {
          if (planMetadata.gitUrl) {
            await updateGitRemoteToken(
              prepared.session,
              prepared.context.workspacePath,
              planMetadata.gitUrl,
              resumeTokenOverrides.gitToken
            );
          } else {
            logger.warn('gitToken override provided but session is not gitUrl-based');
          }
        }
      } catch (error) {
        throw new ConsumerError(
          'WORKSPACE_SETUP_FAILED',
          `Failed to update git remote token: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  // 3. Determine wrapper launch inputs
  const wrapperEnvBase = plan.wrapper.env;
  const promptFile = plan.promptFile;
  const appendSystemPromptFile = plan.appendSystemPromptFile;
  const wrapperArgs = plan.wrapper.args;

  if (!wrapperEnvBase || !wrapperArgs) {
    throw new ConsumerError('WORKSPACE_SETUP_FAILED', 'Missing wrapper plan for V2 execution');
  }

  // 4. Write prompt to temp file
  await prepared.session.writeFile(promptFile, prompt);

  // 4b. Write appendSystemPrompt to temp file if provided (avoids command injection)
  if (appendSystemPromptFile && appendSystemPrompt) {
    await prepared.session.writeFile(appendSystemPromptFile, appendSystemPrompt);
  }

  // 5. Build DO URL for ingest endpoint
  const workerUrl =
    (env as { WORKER_URL?: string }).WORKER_URL ?? 'https://cloud-agent.kilocode.ai';
  // Encode userId to handle OAuth IDs like "oauth/google:123" that contain slashes
  const doUrl = `${workerUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/sessions/${encodeURIComponent(userId)}/${sessionId}/ingest`;

  // 6. Start wrapper process (returns immediately - wrapper runs async)
  const upstreamBranch = wrapperEnvBase.UPSTREAM_BRANCH || prepared.context.upstreamBranch || '';

  const wrapperEnv: Record<string, string> = {
    ...wrapperEnvBase,
    UPSTREAM_BRANCH: upstreamBranch,
    INGEST_URL: doUrl,
    WORKSPACE_PATH: prepared.context.workspacePath,
  };

  logger.withFields({ promptFile }).info('Starting wrapper process');

  await prepared.session.startProcess(`bun ${wrapperArgs.join(' ')}`, {
    env: wrapperEnv,
    cwd: prepared.context.workspacePath,
  });

  // Done - wrapper handles the rest
  logger.info('Wrapper started successfully');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if an error code indicates a retryable condition.
 */
function isRetryableError(code: string): boolean {
  return (RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Custom error class for consumer errors with error codes.
 */
class ConsumerError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ConsumerError';
  }
}
