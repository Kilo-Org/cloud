import type {
  ExecutionSession,
  SandboxInstance,
  SandboxId,
  SessionContext,
  SessionId,
  StreamEvent,
  InterruptResult,
} from './types.js';
import type { ExecutionParams as _ExecutionParams } from './schema.js';
import { DEFAULT_BACKEND_URL } from './constants.js';
import { generateSandboxId } from './sandbox-id.js';
import {
  checkDiskSpace,
  cloneGitHubRepo,
  cloneGitRepo,
  cleanupWorkspace,
  configureKilocode,
  getKilocodeCliDir,
  getKilocodeLogsDir,
  getKilocodeTasksDir,
  getSessionHomePath,
  getSessionWorkspacePath,
  manageBranch,
  setupWorkspace,
} from './workspace.js';
import { logger, WithLogTags } from './logger.js';
import { streamKilocodeExecution } from './streaming.js';
import type {
  PersistenceEnv,
  CloudAgentSessionState,
  MCPServerConfig,
} from './persistence/types.js';
import { MetadataSchema } from './persistence/schemas.js';
import { withDORetry } from './utils/do-retry.js';
import { mergeEnvVarsWithSecrets } from './utils/encryption.js';
import type { EncryptedSecrets, Images } from './router/schemas.js';

const SETUP_COMMAND_TIMEOUT_SECONDS = 120; // 2 minutes
const SANDBOX_RETRY_DEFAULTS = {
  maxAttempts: 3,
  baseBackoffMs: 100,
  maxBackoffMs: 5000,
};

function determineBranchName(sessionId: string, upstreamBranch?: string): string {
  return upstreamBranch ?? `session/${sessionId}`;
}

type SandboxRetryConfig = {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
};

type RetryableSandboxError = Error & { retryable?: boolean; overloaded?: boolean };

function isRetryableSandboxError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sandboxError = error as RetryableSandboxError;
  if (sandboxError.overloaded === true) return false;
  return sandboxError.retryable === true;
}

function getSandboxErrorFlags(error: unknown): {
  retryable?: boolean;
  overloaded?: boolean;
} {
  if (!(error instanceof Error)) {
    return {};
  }
  const sandboxError = error as RetryableSandboxError;
  return {
    retryable: sandboxError.retryable,
    overloaded: sandboxError.overloaded,
  };
}

function calculateSandboxBackoff(attempt: number, config: SandboxRetryConfig): number {
  const exponentialBackoff = config.baseBackoffMs * Math.pow(2, attempt);
  const jitteredBackoff = exponentialBackoff * Math.random();
  return Math.min(config.maxBackoffMs, jitteredBackoff);
}

async function cleanupSandboxAttempt(
  getSandbox: () => Promise<SandboxInstance>,
  sessionId: string,
  workspacePath: string,
  sessionHome: string
): Promise<void> {
  try {
    const sandbox = await getSandbox();
    const session = await sandbox.getSession(sessionId);
    await cleanupWorkspace(session, workspacePath, sessionHome);
    await sandbox.deleteSession(sessionId);
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error), sessionId })
      .warn('Failed to cleanup sandbox after retryable error');
  }
}

async function withSandboxRetry<T>(
  getSandbox: () => Promise<SandboxInstance>,
  operation: (sandbox: SandboxInstance) => Promise<T>,
  operationName: string,
  cleanup: () => Promise<void>,
  config: SandboxRetryConfig = SANDBOX_RETRY_DEFAULTS
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      const sandbox = await getSandbox();
      return await operation(sandbox);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errorFlags = getSandboxErrorFlags(error);

      if (!isRetryableSandboxError(error)) {
        logger
          .withFields({
            operation: operationName,
            attempt: attempt + 1,
            error: lastError.message,
            retryable: false,
            retryableFlag: errorFlags.retryable,
            overloadedFlag: errorFlags.overloaded,
          })
          .warn('Sandbox operation failed with non-retryable error');
        throw lastError;
      }

      if (attempt + 1 >= config.maxAttempts) {
        logger
          .withFields({
            operation: operationName,
            attempts: attempt + 1,
            error: lastError.message,
          })
          .error('Sandbox operation failed after all retry attempts');
        throw lastError;
      }

      await cleanup();

      const backoffMs = calculateSandboxBackoff(attempt, config);
      logger
        .withFields({
          operation: operationName,
          attempt: attempt + 1,
          backoffMs: Math.round(backoffMs),
          error: lastError.message,
          retryableFlag: errorFlags.retryable,
          overloadedFlag: errorFlags.overloaded,
        })
        .warn('Sandbox operation failed, retrying');

      await scheduler.wait(backoffMs);
    }
  }

  throw lastError ?? new Error('Unexpected sandbox retry loop exit');
}

export class SetupCommandFailedError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stderr: string
  ) {
    super(`Setup command failed: ${command}`);
    this.name = 'SetupCommandFailedError';
  }
}

export class InvalidSessionMetadataError extends Error {
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
    public readonly details?: string
  ) {
    super(`Invalid session metadata for session ${sessionId}`);
    this.name = 'InvalidSessionMetadataError';
  }
}

/**
 * Execute setup commands in the sandbox session.
 * Commands run in the workspace directory with access to env vars.
 *
 * @param session - ExecutionSession to run commands in
 * @param context - Session context (paths, IDs)
 * @param setupCommands - Array of setup commands to execute
 * @param failFast - Whether to stop on first failure (default: false)
 */
async function runSetupCommands(
  session: ExecutionSession,
  context: SessionContext,
  setupCommands: string[],
  failFast: boolean = false
): Promise<void> {
  if (!setupCommands || setupCommands.length === 0) {
    return;
  }

  logger.setTags({ setupCommandsCount: setupCommands.length });
  logger.info('Running setup commands');

  for (const command of setupCommands) {
    try {
      // Run command in workspace directory
      const result = await session.exec(command, {
        cwd: context.workspacePath,
        timeout: SETUP_COMMAND_TIMEOUT_SECONDS * 1000, // Convert to milliseconds
      });

      if (result.exitCode !== 0) {
        logger
          .withFields({
            command,
            exitCode: result.exitCode,
            stderr: result.stderr,
          })
          .warn('Setup command failed');

        if (failFast) {
          throw new SetupCommandFailedError(command, result.exitCode, result.stderr);
        }
      }
    } catch (error) {
      logger
        .withFields({
          command,
          error: error instanceof Error ? error.message : String(error),
        })
        .error('Error executing setup command');

      if (failFast) {
        if (error instanceof SetupCommandFailedError) {
          throw error;
        }
        throw new SetupCommandFailedError(
          command,
          -1,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  logger.info('Setup commands completed');
}

// Write MCP server config to global settings file in the session home.
async function writeMCPSettings(
  sandbox: SandboxInstance,
  sessionHome: string,
  mcpServers: Record<string, MCPServerConfig>
): Promise<void> {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return;
  }

  const settingsDir = `${sessionHome}/.kilocode/cli/global/settings`;
  const settingsPath = `${settingsDir}/mcp_settings.json`;

  // Ensure directory exists
  await sandbox.exec(`mkdir -p ${settingsDir}`);

  // Generate settings JSON inline (no need for separate function)
  const settingsJSON = JSON.stringify({ mcpServers }, null, 2);

  // Write settings file
  await sandbox.writeFile(settingsPath, settingsJSON);

  const serverNames = Object.keys(mcpServers);
  logger
    .withTags({
      serverCount: serverNames.length,
      serverNames: serverNames.join(', '),
    })
    .info('Configured MCP servers');
}

/**
 * Fetch session metadata from Durable Object using RPC with retry logic.
 * Creates a fresh stub for each retry attempt as recommended by Cloudflare.
 * @returns CloudAgentSessionState if found, null otherwise
 */
export async function fetchSessionMetadata(
  env: PersistenceEnv,
  userId: string,
  sessionId: string
): Promise<CloudAgentSessionState | null> {
  const doKey = `${userId}:${sessionId}`;

  const metadata = await withDORetry(
    () => env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey)),
    stub => stub.getMetadata(),
    'getMetadata'
  );

  if (!metadata) {
    return null;
  }

  const parsed = MetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    const reason = JSON.stringify(parsed.error.format());
    logger
      .withFields({
        userId,
        sessionId,
        reason,
      })
      .error('Invalid session metadata shape');
    throw new InvalidSessionMetadataError(userId, sessionId, reason);
  }

  return parsed.data;
}

/**
 * Generate a unique session ID with the agent_ prefix.
 */
export function generateSessionId(): SessionId {
  return `agent_${crypto.randomUUID()}`;
}

/**
 * Manages Cloudflare sessions within sandboxes.
 * Sessions are bash shell execution contexts within a sandbox (like terminal tabs).
 */
export class SessionService {
  private _metadata?: CloudAgentSessionState;

  /**
   * Get the cached metadata (available after getSandboxIdForSession is called)
   */
  get metadata(): CloudAgentSessionState | undefined {
    return this._metadata;
  }

  /**
   * Get the sandboxId for a session by fetching and caching its metadata.
   * This method should be called before resume() to avoid double-fetching metadata.
   * @throws TRPCError with code 'NOT_FOUND' if session doesn't exist
   */
  async getSandboxIdForSession(
    env: PersistenceEnv,
    userId: string,
    sessionId: SessionId
  ): Promise<SandboxId> {
    // Fetch and store metadata
    const fetchedMetadata = await fetchSessionMetadata(env, userId, sessionId);

    if (!fetchedMetadata) {
      const { TRPCError } = await import('@trpc/server');
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Session ${sessionId} not found. Please initiate a new session.`,
      });
    }

    this._metadata = fetchedMetadata;

    // Reconstruct sandboxId using the hash-based format
    const sandboxId: SandboxId = await generateSandboxId(
      this._metadata.orgId,
      userId,
      this._metadata.botId
    );

    return sandboxId;
  }

  /**
   * Derive a SessionContext from the provided metadata.
   */
  buildContext(options: {
    sandboxId: SessionContext['sandboxId'];
    orgId?: string;
    userId: string;
    sessionId: SessionId;
    workspacePath?: string;
    sessionHome?: string;
    githubRepo?: string;
    githubToken?: string;
    gitUrl?: string;
    gitToken?: string;
    upstreamBranch?: string;
    botId?: string;
  }): SessionContext {
    const sessionHome = options.sessionHome ?? getSessionHomePath(options.sessionId);
    const workspacePath =
      options.workspacePath ??
      getSessionWorkspacePath(options.orgId, options.userId, options.sessionId);

    const branchName = determineBranchName(options.sessionId, options.upstreamBranch);

    return {
      sandboxId: options.sandboxId,
      sessionId: options.sessionId,
      sessionHome,
      workspacePath,
      branchName,
      upstreamBranch: options.upstreamBranch,
      orgId: options.orgId,
      userId: options.userId,
      botId: options.botId,
      githubRepo: options.githubRepo,
      githubToken: options.githubToken,
      gitUrl: options.gitUrl,
      gitToken: options.gitToken,
    };
  }

  private getSaferEnvVars(
    userEnvVars: Record<string, string> | undefined,
    sessionHome: string,
    sessionId: string,
    env: PersistenceEnv,
    originalToken: string,
    originalOrgId?: string,
    githubToken?: string,
    githubRepo?: string,
    encryptedSecrets?: EncryptedSecrets,
    createdOnPlatform?: string,
    gitUrl?: string,
    gitToken?: string
  ): Record<string, string> {
    // Use override if available, otherwise use original values from API
    const kilocodeToken = env.KILOCODE_TOKEN_OVERRIDE ?? originalToken;
    const kilocodeOrganizationId = env.KILOCODE_ORG_ID_OVERRIDE ?? originalOrgId;

    // Start with user env vars
    let baseEnvVars = userEnvVars || {};

    // Decrypt and merge encrypted secrets if present
    if (encryptedSecrets && Object.keys(encryptedSecrets).length > 0) {
      const privateKey = env.AGENT_ENV_VARS_PRIVATE_KEY;
      if (!privateKey) {
        throw new Error(
          'Encrypted secrets provided but AGENT_ENV_VARS_PRIVATE_KEY is not configured on the worker'
        );
      }
      baseEnvVars = mergeEnvVarsWithSecrets(baseEnvVars, encryptedSecrets, privateKey);
      logger
        .withTags({ secretCount: Object.keys(encryptedSecrets).length })
        .info('Decrypted and merged encrypted secrets');
    }

    const envVars: Record<string, string> = {
      // Spread user-provided env vars (including decrypted secrets) first
      ...baseEnvVars,
      // Then set reserved variables to ensure they always take precedence
      HOME: sessionHome,
      SESSION_ID: sessionId,
      SESSION_HOME: sessionHome,
      // Inject Kilocode credentials (with override support)
      KILOCODE_TOKEN: kilocodeToken,
      // Platform identifier - defaults to 'cloud-agent' if not specified
      KILO_PLATFORM: createdOnPlatform ?? 'cloud-agent',
    };

    // Set GH_TOKEN for GitHub repos only, respecting user overrides
    if (githubToken && githubRepo && !baseEnvVars.GH_TOKEN) {
      envVars.GH_TOKEN = githubToken;
    }

    // Set GITLAB_TOKEN for GitLab repos (detected by gitUrl containing gitlab), respecting user overrides
    // This is used by the glab CLI and Kilocode for GitLab operations
    if (gitToken && gitUrl && gitUrl.includes('gitlab') && !baseEnvVars.GITLAB_TOKEN) {
      envVars.GITLAB_TOKEN = gitToken;

      // Set GLAB_IS_OAUTH2=true for glab CLI to properly authenticate with OAuth2 tokens
      // This is required because our GitLab tokens are OAuth2 tokens, not personal access tokens
      if (!baseEnvVars.GLAB_IS_OAUTH2) {
        envVars.GLAB_IS_OAUTH2 = 'true';
      }

      // Also set GITLAB_HOST for the glab CLI to know which instance to authenticate against
      // Extract host from gitUrl (e.g., "https://gitlab.example.com/owner/repo.git" -> "gitlab.example.com")
      if (!baseEnvVars.GITLAB_HOST) {
        try {
          const url = new URL(gitUrl);
          envVars.GITLAB_HOST = url.host;
        } catch {
          // If URL parsing fails, default to gitlab.com
          envVars.GITLAB_HOST = 'gitlab.com';
        }
      }

      // Debug logging for GitLab token setup - FULL TOKEN for debugging
      logger
        .withFields({
          gitUrl,
          gitlabHost: envVars.GITLAB_HOST,
          gitToken: gitToken, // FULL TOKEN for debugging
          gitTokenLength: gitToken.length,
        })
        .info(
          '[GITLAB-DEBUG] Setting GITLAB_TOKEN, GLAB_IS_OAUTH2, and GITLAB_HOST for GitLab session'
        );
    }

    // Only add KILOCODE_ORG_ID if we have an org (personal accounts don't have one)
    if (kilocodeOrganizationId) {
      envVars.KILOCODE_ORGANIZATION_ID = kilocodeOrganizationId;
    }

    if (env.KILOCODE_BACKEND_BASE_URL) {
      envVars.KILOCODE_BACKEND_BASE_URL = env.KILOCODE_BACKEND_BASE_URL;
    }

    return envVars;
  }

  /**
   * Get an existing session or create a new one.
   *
   * Sessions within a sandbox maintain isolated shell state (environment variables,
   * working directory) but share the filesystem.
   */
  async getOrCreateSession(
    sandbox: SandboxInstance,
    context: SessionContext,
    env: PersistenceEnv,
    originalToken: string,
    originalOrgId?: string,
    encryptedSecrets?: EncryptedSecrets,
    createdOnPlatform?: string
  ) {
    const { sessionId, sessionHome, workspacePath, envVars } = context;

    // Decrypt secrets and merge with env vars (just-in-time decryption)
    const saferEnvVars = this.getSaferEnvVars(
      envVars,
      sessionHome,
      sessionId,
      env,
      originalToken,
      originalOrgId,
      context.githubToken,
      context.githubRepo,
      encryptedSecrets,
      createdOnPlatform,
      context.gitUrl,
      context.gitToken
    );

    const session = await sandbox.createSession({
      name: sessionId,
      env: saferEnvVars,
      cwd: workspacePath,
    });
    return session;
  }

  async initiateWithRetry(
    options: Omit<InitiateOptions, 'sandbox'> & {
      getSandbox: () => Promise<SandboxInstance>;
      retryConfig?: SandboxRetryConfig;
    }
  ): Promise<PreparedSession> {
    const { getSandbox, retryConfig, ...rest } = options;
    const workspacePath = getSessionWorkspacePath(rest.orgId, rest.userId, rest.sessionId);
    const sessionHome = getSessionHomePath(rest.sessionId);

    return withSandboxRetry(
      getSandbox,
      sandbox => this.initiate({ ...rest, sandbox }),
      'initiateSession',
      () => cleanupSandboxAttempt(getSandbox, rest.sessionId, workspacePath, sessionHome),
      retryConfig
    );
  }

  /** Initialize a net-new session with the given options */
  @WithLogTags('SessionService.initiate')
  async initiate(options: InitiateOptions): Promise<PreparedSession> {
    const {
      sandbox,
      sandboxId,
      orgId,
      userId,
      sessionId,
      kilocodeToken,
      kilocodeModel,
      githubRepo,
      githubToken,
      gitUrl,
      gitToken,
      env,
      envVars,
      encryptedSecrets,
      setupCommands,
      mcpServers,
      upstreamBranch,
      botId,
      githubAppType,
      createdOnPlatform,
      shallow,
    } = options;

    logger.setTags({
      sessionId,
      sandboxId,
      orgId,
      userId,
      botId,
      githubRepo,
      gitUrl,
    });

    logger.info('Initiating session');

    const { workspacePath, sessionHome } = await setupWorkspace(
      sandbox,
      userId,
      orgId,
      kilocodeToken,
      kilocodeModel,
      sessionId,
      env.KILOCODE_TOKEN_OVERRIDE,
      env.KILOCODE_ORG_ID_OVERRIDE
    );

    const context = this.buildContext({
      sandboxId,
      orgId,
      userId,
      sessionId,
      workspacePath,
      sessionHome,
      githubRepo,
      githubToken,
      gitUrl,
      gitToken,
      upstreamBranch,
      botId,
    });

    // Inject env vars into context for session creation
    if (envVars) {
      context.envVars = envVars;
    }

    const session = await this.getOrCreateSession(
      sandbox,
      context,
      env,
      kilocodeToken,
      orgId,
      encryptedSecrets,
      createdOnPlatform
    );

    // Check disk space before clone for observability (logs warning if low)
    await checkDiskSpace(session);

    // Clone repository using appropriate method
    // Shallow clone (depth: 1) can be enabled for faster checkout and reduced disk usage
    const cloneOptions = shallow ? { shallow: true } : undefined;
    if (gitUrl) {
      await cloneGitRepo(session, workspacePath, gitUrl, gitToken, undefined, cloneOptions);
    } else if (githubRepo) {
      await cloneGitHubRepo(
        session,
        workspacePath,
        githubRepo,
        githubToken,
        getGitAuthorEnv(env, githubAppType),
        cloneOptions
      );
    }

    // Checkout branch before running setup commands
    if (upstreamBranch) {
      // For upstream branches, use manageBranch (need to verify exists remotely)
      await manageBranch(session, context.workspacePath, context.branchName, true);
    } else {
      // For session branches on initiate, create directly (can't exist remotely with UUID-based name)
      logger.withTags({ branchName: context.branchName }).info('Creating session branch');
      const result = await session.exec(
        `cd ${context.workspacePath} && git checkout -b '${context.branchName}'`
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to create session branch ${context.branchName}: ${result.stderr || result.stdout}`
        );
      }
      logger.withTags({ branchName: context.branchName }).info('Successfully created branch');
    }

    // Run setup commands after branch checkout
    if (setupCommands && setupCommands.length > 0) {
      await runSetupCommands(session, context, setupCommands, true); // fail-fast
    }

    // Write MCP server settings
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      await writeMCPSettings(sandbox, context.sessionHome, mcpServers);
    }

    // Save metadata to Durable Object
    const existingMetadata = await this.loadSessionMetadata(env, context);
    await this.saveSessionMetadata(
      env,
      context,
      {
        githubRepo,
        githubToken,
        gitUrl,
        gitToken,
        envVars,
        setupCommands,
        mcpServers,
        upstreamBranch,
      },
      existingMetadata ?? undefined
    );

    // Track first execution to optimize DO fetch and store captured kiloSessionId
    let isFirstCall = true;
    let capturedKiloSessionId: string | undefined = undefined;

    const linkKiloSessionInBackend = this.linkKiloSessionInBackend.bind(this);
    const captureAndStoreBranch = this.captureAndStoreBranch.bind(this);

    return {
      context,
      session,
      streamKilocodeExec: async function* (
        mode: string,
        prompt: string,
        options?: { sessionId?: string; skipInterruptPolling?: boolean; images?: Images }
      ) {
        const currentIsFirst = isFirstCall;
        isFirstCall = false;

        // Use captured kiloSessionId if available for subsequent calls
        const kiloSessionId = capturedKiloSessionId;

        for await (const event of streamKilocodeExecution(
          sandbox,
          session,
          context,
          mode,
          prompt,
          { ...options, isFirstExecution: currentIsFirst, kiloSessionId, images: options?.images },
          env
        )) {
          // Capture kiloSessionId from session_created event for subsequent calls
          if (
            event.streamEventType === 'kilocode' &&
            event.payload?.event === 'session_created' &&
            event.payload?.sessionId &&
            !capturedKiloSessionId
          ) {
            capturedKiloSessionId = String(event.payload.sessionId);
            logger.setTags({ kiloSessionId: capturedKiloSessionId });
            void linkKiloSessionInBackend(
              capturedKiloSessionId,
              sessionId,
              kilocodeToken,
              env
            ).catch((error: unknown) => {
              logger
                .withFields({ error: error instanceof Error ? error.message : String(error) })
                .error('Failed to link sessions in backend');
            });
          }
          yield event;
        }

        await captureAndStoreBranch(session, context, env);
      },
    };
  }

  /**
   * Initialize a cloud-agent session by resuming an existing kilo session.
   *
   * Client provides both kiloSessionId and githubRepo (parsed from git_url).
   *
   * Branch management strategy:
   * - Clone repo (any branch, default is fine)
   * - Kilo session handles its own branch state (knows which branch it was on)
   * - After execution, we observe and capture the branch via `git branch --show-current`
   * - Store captured branch in metadata for future warm starts
   *
   * @param options.existingMetadata - Optional existing metadata to merge with new values.
   *   When provided, skips the DO fetch and uses this directly for preserving fields like
   *   preparedAt, initiatedAt, prompt, mode, model, autoCommit. If not provided, metadata
   *   is fetched from the DO automatically to ensure no fields are lost. Passing this is
   *   an optimization when the caller already has the metadata.
   */
  @WithLogTags('SessionService.initiateFromKiloSession')
  async initiateFromKiloSession(options: InitiateFromKiloSessionOptions): Promise<PreparedSession> {
    const {
      sandbox,
      sandboxId,
      orgId,
      userId,
      sessionId,
      kilocodeToken,
      kilocodeModel,
      kiloSessionId,
      githubRepo,
      githubToken,
      gitUrl,
      gitToken,
      env,
      envVars,
      encryptedSecrets,
      setupCommands,
      mcpServers,
      botId,
      skipLinking,
      githubAppType,
      existingMetadata,
    } = options;

    logger.setTags({
      sessionId,
      sandboxId,
      orgId,
      userId,
      botId,
      kiloSessionId,
      githubRepo,
      gitUrl,
    });

    logger.info('Initiating session from existing kilo session');

    // Setup workspace (same as initiate)
    const { workspacePath, sessionHome } = await setupWorkspace(
      sandbox,
      userId,
      orgId,
      kilocodeToken,
      kilocodeModel,
      sessionId,
      env.KILOCODE_TOKEN_OVERRIDE,
      env.KILOCODE_ORG_ID_OVERRIDE
    );

    // For prepared sessions, we may have an upstreamBranch to use
    // For legacy CLI resumes, the CLI manages its own branch state
    const isPreparedSession = existingMetadata?.preparedAt !== undefined;

    const context = this.buildContext({
      sandboxId,
      orgId,
      userId,
      sessionId,
      workspacePath,
      sessionHome,
      githubRepo,
      githubToken,
      gitUrl,
      gitToken,
      // For prepared sessions, use the upstreamBranch from metadata if provided
      // For legacy CLI resumes, let the CLI manage its own branch state (undefined)
      upstreamBranch: isPreparedSession ? existingMetadata?.upstreamBranch : undefined,
      botId,
    });

    if (envVars) {
      context.envVars = envVars;
    }

    const session = await this.getOrCreateSession(
      sandbox,
      context,
      env,
      kilocodeToken,
      orgId,
      encryptedSecrets
    );

    // Check disk space before clone for observability (logs warning if low)
    await checkDiskSpace(session);

    // Clone repository using appropriate method
    if (gitUrl) {
      await cloneGitRepo(session, workspacePath, gitUrl, gitToken);
    } else if (githubRepo) {
      await cloneGitHubRepo(
        session,
        workspacePath,
        githubRepo,
        githubToken,
        getGitAuthorEnv(env, githubAppType)
      );
    } else {
      throw new Error('Either githubRepo or gitUrl must be provided');
    }

    // Branch management depends on whether this is a prepared session or CLI resume:
    // - Prepared sessions (existingMetadata.preparedAt exists): Checkout branch (like initiateSessionStream)
    // - CLI resumes (no preparedAt): Skip branch ops (CLI manages its own branch state)
    if (isPreparedSession) {
      // Use the upstreamBranch from prepared session metadata if present
      const upstreamBranch = existingMetadata?.upstreamBranch;

      if (upstreamBranch) {
        // For upstream branches, use manageBranch (need to verify exists remotely)
        await manageBranch(session, context.workspacePath, context.branchName, true);
      } else {
        // For session branches on initiate, create directly (can't exist remotely with UUID-based name)
        logger.withTags({ branchName: context.branchName }).info('Creating session branch');
        const result = await session.exec(
          `cd ${context.workspacePath} && git checkout -b '${context.branchName}'`
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to create session branch ${context.branchName}: ${result.stderr || result.stdout}`
          );
        }
        logger.withTags({ branchName: context.branchName }).info('Successfully created branch');
      }
    } else {
      logger.info('Skipping branch operations - CLI session will manage its own branch state');
    }

    // Run setup commands (lenient mode since resuming)
    if (setupCommands && setupCommands.length > 0) {
      await runSetupCommands(session, context, setupCommands, false);
    }

    // Write MCP settings
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      await writeMCPSettings(sandbox, context.sessionHome, mcpServers);
    }

    // Fetch metadata from DO if not provided, to ensure we preserve existing fields
    const metadataToPreserve =
      existingMetadata ?? (await this.loadSessionMetadata(env, context)) ?? undefined;

    // Save metadata with kiloSessionId, preserving existing prepared session fields
    await this.saveSessionMetadata(
      env,
      context,
      {
        githubRepo,
        githubToken,
        gitUrl,
        gitToken,
        envVars,
        setupCommands,
        mcpServers,
        kiloSessionId,
      },
      metadataToPreserve
    );

    // Skip linking if requested (e.g., for prepared sessions where backend already linked)
    if (!skipLinking) {
      try {
        await this.linkKiloSessionInBackend(kiloSessionId, sessionId, kilocodeToken, env);
        logger.info('Linked cloud-agent session to kilo session in backend');
      } catch (error) {
        logger
          .withFields({ error: error instanceof Error ? error.message : String(error) })
          .warn('Failed to link sessions in backend');
      }
    } else {
      logger.debug('Skipping backend linking (prepared session mode)');
    }

    const captureAndStoreBranch = this.captureAndStoreBranch.bind(this);

    return {
      context,
      session,
      streamKilocodeExec: async function* (
        mode: string,
        prompt: string,
        execOptions?: { sessionId?: string; skipInterruptPolling?: boolean; images?: Images }
      ) {
        for await (const event of streamKilocodeExecution(
          sandbox,
          session,
          context,
          mode,
          prompt,
          { ...execOptions, isFirstExecution: false, kiloSessionId, images: execOptions?.images },
          env
        )) {
          yield event;
        }

        await captureAndStoreBranch(session, context, env);
      },
    };
  }

  async initiateFromKiloSessionWithRetry<T extends InitiateFromKiloSessionOptions>(
    options: Omit<T, 'sandbox'> & {
      getSandbox: () => Promise<SandboxInstance>;
      retryConfig?: SandboxRetryConfig;
    }
  ): Promise<PreparedSession> {
    const { getSandbox, retryConfig, ...rest } = options;
    const initiateOptions = rest as unknown as Omit<T, 'sandbox'>;
    const workspacePath = getSessionWorkspacePath(
      initiateOptions.orgId,
      initiateOptions.userId,
      initiateOptions.sessionId
    );
    const sessionHome = getSessionHomePath(initiateOptions.sessionId);

    return withSandboxRetry(
      getSandbox,
      sandbox => this.initiateFromKiloSession({ ...initiateOptions, sandbox } as T),
      'initiateFromKiloSession',
      () =>
        cleanupSandboxAttempt(getSandbox, initiateOptions.sessionId, workspacePath, sessionHome),
      retryConfig
    );
  }

  /** Resume an existing session with the given options */
  @WithLogTags('SessionService.resume')
  async resume(options: ResumeOptions): Promise<PreparedSession> {
    const {
      sandbox,
      sandboxId,
      orgId,
      userId,
      sessionId,
      kilocodeToken,
      kilocodeModel,
      configure = true,
      env,
      githubToken: freshGithubToken,
      gitToken: freshGitToken,
    } = options;

    logger.setTags({
      sessionId,
      sandboxId,
      orgId,
      userId,
    });

    logger.info('Resuming session');

    const workspacePath = getSessionWorkspacePath(orgId, userId, sessionId);
    const sessionHome = getSessionHomePath(sessionId);

    // Ensure workspace directories exist before creating session
    await sandbox.mkdir(workspacePath, { recursive: true });
    await sandbox.mkdir(sessionHome, { recursive: true });

    // Create Kilocode CLI subdirectories (needed before configureKilocode)
    await sandbox.mkdir(getKilocodeCliDir(sessionHome), { recursive: true });
    await sandbox.mkdir(getKilocodeTasksDir(sessionHome), { recursive: true });
    await sandbox.mkdir(getKilocodeLogsDir(sessionHome), { recursive: true });

    const metadata = await this.loadSessionMetadata(env, { userId, sessionId } as SessionContext);

    const context = this.buildContext({
      sandboxId,
      orgId,
      userId,
      sessionId,
      workspacePath,
      sessionHome,
      upstreamBranch: metadata?.upstreamBranch,
      botId: metadata?.botId,
      githubRepo: metadata?.githubRepo,
      githubToken: metadata?.githubToken,
      gitUrl: metadata?.gitUrl,
      gitToken: metadata?.gitToken,
    });

    // Inject env vars from metadata into context (before creating session)
    if (metadata?.envVars) {
      context.envVars = metadata.envVars;
    }

    // Create session first so we can use it for all operations
    // Note: encryptedSecrets come from metadata for resume - they were stored during prepare/initiate
    const session = await this.getOrCreateSession(
      sandbox,
      context,
      env,
      kilocodeToken,
      orgId,
      metadata?.encryptedSecrets
    );

    // Check if workspace repo exists - if not, we may need to reclone
    const repoCheck = await session.exec(`test -d ${workspacePath}/.git && echo exists`);
    const repoExists = repoCheck.stdout?.includes('exists') ?? false;

    // Check disk space for observability (logs warning if low)
    await checkDiskSpace(session);

    if (!repoExists) {
      if (metadata) {
        if (metadata?.gitUrl) {
          const effectiveGitToken = freshGitToken ?? metadata.gitToken;
          logger
            .withTags({ gitUrl: metadata.gitUrl, hasFreshToken: !!freshGitToken })
            .info('Recloning missing repository (generic git)');

          // Reclone the repository using generic git
          await cloneGitRepo(session, workspacePath, metadata.gitUrl, effectiveGitToken);
        } else if (metadata?.githubRepo) {
          const effectiveGithubToken = freshGithubToken ?? metadata.githubToken;
          logger
            .withTags({ githubRepo: metadata.githubRepo, hasFreshToken: !!freshGithubToken })
            .info('Recloning missing repository');

          // Reclone the repository
          await cloneGitHubRepo(
            session,
            workspacePath,
            metadata.githubRepo,
            effectiveGithubToken,
            getGitAuthorEnv(env, metadata.githubAppType)
          );
        } else {
          throw new Error(
            `Session ${sessionId} workspace is missing and no repository metadata found. Please re-initiate the session.`
          );
        }
      } else {
        throw new Error(
          `Session ${sessionId} workspace is missing and metadata could not be retrieved. Please re-initiate the session.`
        );
      }
    }

    if (configure) {
      await configureKilocode(
        session,
        context.sessionHome,
        orgId,
        kilocodeToken,
        kilocodeModel,
        env.KILOCODE_TOKEN_OVERRIDE,
        env.KILOCODE_ORG_ID_OVERRIDE
      );
    }

    // Only re-run setup if we had to reclone (cold start)
    // Note: We don't checkout branch here - kilocode CLI will restore workspace state when it runs
    if (!repoExists) {
      // Re-run setup commands (fresh clone, need to reinstall)
      if (metadata?.setupCommands && metadata.setupCommands.length > 0) {
        logger.info('Re-running setup commands after fresh clone');
        await runSetupCommands(session, context, metadata.setupCommands, false); // lenient
      }

      // Re-write MCP settings (fresh clone)
      if (metadata?.mcpServers && Object.keys(metadata.mcpServers).length > 0) {
        await writeMCPSettings(sandbox, context.sessionHome, metadata.mcpServers);
      }
    }

    return {
      context,
      session,
      streamKilocodeExec: (
        mode: string,
        prompt: string,
        options?: { sessionId?: string; skipInterruptPolling?: boolean; images?: Images }
      ) =>
        streamKilocodeExecution(
          sandbox,
          session,
          context,
          mode,
          prompt,
          {
            ...options,
            isFirstExecution: false,
            kiloSessionId: metadata?.kiloSessionId,
            images: options?.images,
          },
          env
        ),
    };
  }

  /**
   * Identifies and kills all kilocode processes running in a specific session's workspace.
   * This allows clients to stop running executions in a session without deleting the session itself.
   *
   * @param usePkill - If true, uses `pkill -f` with sessionId pattern instead of sandbox.listProcesses/killProcess.
   *                   This is a temporary workaround for environments where sandbox process APIs are unreliable.
   */
  static async interrupt(
    sandbox: SandboxInstance,
    session: ExecutionSession,
    sessionContext: SessionContext,
    usePkill: boolean = false,
    executionId?: string
  ): Promise<InterruptResult> {
    if (usePkill) {
      return SessionService.interruptWithPkill(session, sessionContext, executionId);
    }
    return SessionService.interruptWithSandboxApi(sandbox, session, sessionContext);
  }

  /**
   * Interrupt using pkill -f with the sessionId as the pattern.
   * This kills any process whose command line contains the sessionId.
   */
  private static async interruptWithPkill(
    session: ExecutionSession,
    sessionContext: SessionContext,
    executionId?: string
  ): Promise<InterruptResult> {
    const startTime = Date.now();
    const { sessionId } = sessionContext;

    try {
      const attemptPkill = async (pattern: string, label: string) => {
        logger.info('Interrupting session using pkill', {
          sessionId,
          label,
          pattern,
        });
        return session.exec(`pkill -f '${pattern}'`);
      };

      let execIdError: string | null = null;

      if (executionId) {
        // Prefer the wrapper execution ID for v2 sessions.
        // pkill -f matches against the full command line.
        const execResult = await attemptPkill(`--execution-id=${executionId}`, 'executionId');
        if (execResult.exitCode === 0) {
          return {
            success: true,
            killedProcessIds: [], // pkill doesn't report individual PIDs
            failedProcessIds: [],
            message: 'Interrupted execution using pkill (executionId)',
          };
        }
        if (execResult.exitCode !== 1) {
          execIdError = `pkill failed with exit code ${execResult.exitCode}: ${execResult.stderr}`;
          logger.error('pkill command failed for executionId', {
            sessionId,
            executionId,
            exitCode: execResult.exitCode,
            stderr: execResult.stderr,
          });
        }
      }

      // Fall back to sessionId for legacy sessions.
      const sessionResult = await attemptPkill(sessionId, 'sessionId');
      const elapsed = Date.now() - startTime;

      if (sessionResult.exitCode === 0) {
        logger.info('pkill successfully killed processes', {
          sessionId,
          elapsedMs: elapsed,
        });

        return {
          success: true,
          killedProcessIds: [], // pkill doesn't report individual PIDs
          failedProcessIds: [],
          message: execIdError
            ? `Interrupted execution using pkill (sessionId fallback). ${execIdError}`
            : 'Interrupted execution using pkill',
        };
      }
      if (sessionResult.exitCode === 1) {
        logger.info('No matching processes found for pkill', {
          sessionId,
          elapsedMs: elapsed,
        });

        return {
          success: true,
          killedProcessIds: [],
          failedProcessIds: [],
          message: execIdError
            ? `No running processes found for this session. ${execIdError}`
            : 'No running processes found for this session',
        };
      }

      logger.error('pkill command failed for sessionId', {
        sessionId,
        exitCode: sessionResult.exitCode,
        stderr: sessionResult.stderr,
        elapsedMs: elapsed,
      });

      return {
        success: false,
        killedProcessIds: [],
        failedProcessIds: [],
        message: execIdError
          ? `${execIdError}; sessionId pkill failed with exit code ${sessionResult.exitCode}: ${sessionResult.stderr}`
          : `pkill failed with exit code ${sessionResult.exitCode}: ${sessionResult.stderr}`,
      };
    } catch (error) {
      logger.error('Interrupt with pkill failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Interrupt using sandbox.listProcesses and session.killProcess APIs.
   * This is the original implementation that enumerates and kills processes individually.
   */
  private static async interruptWithSandboxApi(
    sandbox: SandboxInstance,
    session: ExecutionSession,
    sessionContext: SessionContext
  ): Promise<InterruptResult> {
    type ProcessInfo = {
      id: string;
      status: string;
      command: string;
    };

    const startTime = Date.now();

    try {
      // List all processes in the sandbox
      const processes = await sandbox.listProcesses();

      // Filter for kilocode processes in this session's workspace
      const targetProcesses = processes.filter((proc: ProcessInfo) => {
        const isRunning = proc.status === 'running';
        const isKilocode = proc.command.includes('kilocode');
        const isInWorkspace = proc.command.includes(`--workspace=${sessionContext.workspacePath}`);

        return isRunning && isKilocode && isInWorkspace;
      });

      if (targetProcesses.length === 0) {
        logger.info('No matching kilocode processes found to interrupt', {
          sessionId: sessionContext.sessionId,
          workspacePath: sessionContext.workspacePath,
        });

        return {
          success: true,
          killedProcessIds: [],
          failedProcessIds: [],
          message: 'No running kilocode processes found for this session',
        };
      }

      // Kill each target process
      const killed: string[] = [];
      const failed: string[] = [];

      for (const proc of targetProcesses) {
        try {
          // Send SIGTERM for graceful termination (exit code 143)
          // This allows the SSE stream to properly close with an expected exit code
          await session.killProcess(proc.id, 'SIGTERM');
          killed.push(proc.id);
          logger.info('Successfully killed process', {
            processId: proc.id,
            command: proc.command,
          });
        } catch (error) {
          failed.push(proc.id);
          logger.error('Failed to kill process', {
            processId: proc.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const elapsed = Date.now() - startTime;
      logger.info('Interrupt operation completed', {
        sessionId: sessionContext.sessionId,
        killedCount: killed.length,
        failedCount: failed.length,
        elapsedMs: elapsed,
      });

      return {
        success: killed.length > 0,
        killedProcessIds: killed,
        failedProcessIds: failed,
        message:
          killed.length > 0
            ? `Interrupted execution: killed ${killed.length} process(es)${failed.length > 0 ? `, ${failed.length} failed` : ''}`
            : `Failed to kill any processes (${failed.length} attempts failed)`,
      };
    } catch (error) {
      logger.error('Interrupt operation failed', {
        sessionId: sessionContext.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Save session metadata to Durable Object.
   *
   * When `existing` is provided (e.g., from prepared session flow), merges with it
   * to preserve fields like preparedAt, initiatedAt, prompt, mode, model, autoCommit.
   * This avoids an extra DO read and prevents data loss.
   */
  private async saveSessionMetadata(
    env: PersistenceEnv,
    context: SessionContext,
    data: {
      githubRepo?: string;
      githubToken?: string;
      gitUrl?: string;
      gitToken?: string;
      envVars?: Record<string, string>;
      setupCommands?: string[];
      mcpServers?: Record<string, MCPServerConfig>;
      upstreamBranch?: string;
      kiloSessionId?: string;
    },
    existing?: CloudAgentSessionState
  ): Promise<void> {
    const { orgId, userId, sessionId, botId } = context;
    const doKey = `${userId}:${sessionId}`;

    // Build metadata, preserving prepared session fields from existing if provided
    const metadata: CloudAgentSessionState = {
      // Start with existing metadata if provided (preserves preparedAt, initiatedAt, prompt, mode, model, autoCommit)
      ...(existing ?? {}),
      // Always update these core fields
      version: Date.now(),
      sessionId,
      orgId,
      userId,
      botId,
      timestamp: Date.now(),
      // Apply the new data (may override some existing fields, which is intentional)
      githubRepo: data.githubRepo,
      githubToken: data.githubToken,
      gitUrl: data.gitUrl,
      gitToken: data.gitToken,
      envVars: data.envVars,
      setupCommands: data.setupCommands,
      mcpServers: data.mcpServers,
      upstreamBranch: data.upstreamBranch,
      kiloSessionId: data.kiloSessionId,
    };

    // Validate before writing
    const parseResult = MetadataSchema.safeParse(metadata);
    if (!parseResult.success) {
      logger
        .withFields({ errors: parseResult.error.format() })
        .error('Invalid metadata in saveSessionMetadata');
      throw new Error(`Invalid metadata: ${JSON.stringify(parseResult.error.format())}`);
    }

    await withDORetry(
      () => env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey)),
      stub => stub.updateMetadata(parseResult.data),
      'updateMetadata'
    );
  }

  private async loadSessionMetadata(
    env: PersistenceEnv,
    context: SessionContext
  ): Promise<CloudAgentSessionState | null> {
    const { userId, sessionId } = context;
    const metadata = await fetchSessionMetadata(env, userId, sessionId);
    if (!metadata) {
      logger.info('No metadata found');
      return null;
    }

    return metadata;
  }

  /**
   * Create a minimal cliSession in kilocode-backend.
   * Uses the customer's auth token (forwarded from the original request).
   * Returns the generated kiloSessionId.
   */
  async createKiloSessionInBackend(
    cloudAgentSessionId: string,
    authToken: string,
    env: PersistenceEnv,
    organizationId?: string,
    lastMode?: string,
    lastModel?: string,
    gitUrl?: string
  ): Promise<string> {
    const backendUrl = env.KILOCODE_BACKEND_BASE_URL || DEFAULT_BACKEND_URL;

    const input = {
      created_on_platform: 'cloud-agent',
      organization_id: organizationId ?? null,
      cloud_agent_session_id: cloudAgentSessionId,
      version: 2,
      last_mode: lastMode,
      last_model: lastModel,
      git_url: gitUrl,
    };

    const response = await fetch(`${backendUrl}/api/trpc/cliSessions.createV2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[createKiloSessionInBackend] Backend error:', {
        status: response.status,
        statusText: response.statusText,
        body: '[redacted]',
        backendUrl,
        organizationId,
        cloudAgentSessionId,
      });
      throw new Error(
        `Failed to create kilo session: ${response.status} - ${text.substring(0, 200)}`
      );
    }

    const result = await response.json();

    type TrpcResponse = { result?: { data?: { session_id?: string } } };
    const typedResult = result as TrpcResponse;

    const sessionId = typedResult.result?.data?.session_id;
    if (!sessionId) {
      throw new Error('Backend did not return session_id');
    }

    return sessionId;
  }

  /**
   * Delete a cliSession in kilocode-backend.
   * Used for rollback when DO prepare() fails after backend session was created.
   */
  async deleteKiloSessionInBackend(
    kiloSessionId: string,
    authToken: string,
    env: PersistenceEnv
  ): Promise<void> {
    const backendUrl = env.KILOCODE_BACKEND_BASE_URL || DEFAULT_BACKEND_URL;

    const input = {
      session_id: kiloSessionId,
    };

    const response = await fetch(`${backendUrl}/api/trpc/cliSessions.delete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to delete kilo session: ${response.status} ${text}`);
    }

    const result = await response.json();

    type TrpcResponse = { result?: { data?: { success?: boolean } } };
    const typedResult = result as TrpcResponse;

    if (!typedResult.result?.data?.success) {
      throw new Error('Backend did not confirm successful deletion');
    }
  }

  /**
   * Helper to link sessions in backend using tRPC wire format
   */
  private async linkKiloSessionInBackend(
    kiloSessionId: string,
    cloudAgentSessionId: string,
    authToken: string,
    env: PersistenceEnv
  ): Promise<void> {
    const backendUrl = env.KILOCODE_BACKEND_BASE_URL || DEFAULT_BACKEND_URL;

    const input = {
      kilo_session_id: kiloSessionId,
      cloud_agent_session_id: cloudAgentSessionId,
    };

    const response = await fetch(`${backendUrl}/api/trpc/cliSessions.linkCloudAgent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to link sessions: ${response.status} ${text}`);
    }

    const result = await response.json();

    type TrpcResponse = { result?: { data?: { success?: boolean } } };
    const typedResult = result as TrpcResponse;

    if (!typedResult.result?.data?.success) {
      throw new Error('Backend did not confirm successful link');
    }
  }

  /**
   * Capture the current git branch after kilo execution and update metadata.
   */
  private async captureAndStoreBranch(
    session: ExecutionSession,
    context: SessionContext,
    env: PersistenceEnv
  ): Promise<void> {
    try {
      const branchResult = await session.exec(
        `cd ${context.workspacePath} && git branch --show-current`
      );

      if (branchResult.exitCode !== 0) {
        logger.warn('git branch --show-current failed, branch not captured');
        return;
      }

      const currentBranch = branchResult.stdout.trim();
      if (!currentBranch) {
        logger.warn('No branch name returned from git, branch not captured');
        return;
      }

      logger.withTags({ currentBranch }).info('Captured branch after kilo execution');

      // Update only the upstreamBranch field using dedicated DO method
      // This is atomic and preserves all other metadata fields
      const doKey = `${context.userId}:${context.sessionId}`;
      await withDORetry(
        () => env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(doKey)),
        stub => stub.updateUpstreamBranch(currentBranch),
        'updateUpstreamBranch'
      );

      logger.withTags({ currentBranch }).info('Stored branch in metadata for future warm starts');
    } catch (error) {
      // Non-critical - log but don't fail
      logger
        .withFields({ error: error instanceof Error ? error.message : String(error) })
        .warn('Failed to capture current branch after execution');
    }
  }
}

/**
 * Returns the correct GitHub App slug and bot user ID for git author attribution,
 * based on whether this is a standard or lite app session.
 */
function getGitAuthorEnv(
  env: PersistenceEnv,
  githubAppType?: 'standard' | 'lite'
): { GITHUB_APP_SLUG?: string; GITHUB_APP_BOT_USER_ID?: string } {
  if (githubAppType === 'lite') {
    return {
      GITHUB_APP_SLUG: env.GITHUB_LITE_APP_SLUG || env.GITHUB_APP_SLUG,
      GITHUB_APP_BOT_USER_ID: env.GITHUB_LITE_APP_BOT_USER_ID || env.GITHUB_APP_BOT_USER_ID,
    };
  }
  return {
    GITHUB_APP_SLUG: env.GITHUB_APP_SLUG,
    GITHUB_APP_BOT_USER_ID: env.GITHUB_APP_BOT_USER_ID,
  };
}

export interface PreparedSession {
  context: SessionContext;
  session: Awaited<ReturnType<SessionService['getOrCreateSession']>>;
  streamKilocodeExec: (
    mode: string,
    prompt: string,
    options?: { sessionId?: string; skipInterruptPolling?: boolean; images?: Images }
  ) => AsyncGenerator<StreamEvent>;
}

export interface InitiateOptions {
  sandbox: SandboxInstance;
  sandboxId: SessionContext['sandboxId'];
  orgId?: string;
  userId: string;
  sessionId: SessionId;
  kilocodeToken: string;
  kilocodeModel: string;
  githubRepo?: string;
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;
  env: PersistenceEnv;
  envVars?: Record<string, string>;
  encryptedSecrets?: EncryptedSecrets;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  upstreamBranch?: string;
  botId?: string;
  /** GitHub App type for selecting correct slug/bot identity */
  githubAppType?: 'standard' | 'lite';
  /**
   * Platform identifier for session creation (e.g., "slack", "cloud-agent").
   * Used to set KILO_PLATFORM env var and ultimately the session's created_on_platform.
   * Defaults to "cloud-agent" if not specified.
   */
  createdOnPlatform?: string;
  /**
   * Whether to perform a shallow clone (depth: 1) for faster checkout and reduced disk usage.
   * Useful for fire-and-forget scenarios like code reviews where full history isn't needed.
   */
  shallow?: boolean;
}

export interface ResumeOptions {
  sandbox: SandboxInstance;
  sandboxId: SessionContext['sandboxId'];
  orgId?: string;
  userId: string;
  sessionId: SessionId;
  kilocodeToken: string;
  kilocodeModel: string;
  configure?: boolean;
  env: PersistenceEnv;
  githubToken?: string;
  gitToken?: string;
}

/**
 * Base options for initiateFromKiloSession (without git source).
 */
type InitiateFromKiloSessionBaseOptions = {
  sandbox: SandboxInstance;
  sandboxId: SessionContext['sandboxId'];
  orgId?: string;
  userId: string;
  sessionId: SessionId;
  kilocodeToken: string;
  kilocodeModel: string;
  kiloSessionId: string;
  env: PersistenceEnv;
  envVars?: Record<string, string>;
  encryptedSecrets?: EncryptedSecrets;
  setupCommands?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  botId?: string;
  skipLinking?: boolean;
  /** GitHub App type for selecting correct slug/bot identity */
  githubAppType?: 'standard' | 'lite';
  /**
   * Existing metadata from prepared session flow.
   * When provided, saveSessionMetadata will merge with it to preserve
   * preparedAt, initiatedAt, prompt, mode, model, autoCommit fields.
   */
  existingMetadata?: CloudAgentSessionState;
};

/**
 * GitHub repository source - requires githubRepo, optional githubToken.
 * Explicitly excludes gitUrl/gitToken to enforce mutual exclusivity.
 */
type GitHubSource = {
  githubRepo: string;
  githubToken?: string;
  gitUrl?: undefined;
  gitToken?: undefined;
};

/**
 * Generic Git URL source - requires gitUrl, optional gitToken.
 * Explicitly excludes githubRepo/githubToken to enforce mutual exclusivity.
 */
type GitUrlSource = {
  gitUrl: string;
  gitToken?: string;
  githubRepo?: undefined;
  githubToken?: undefined;
};

/**
 * Options for initiateFromKiloSession.
 * Requires exactly one of: GitHub repo (with optional token) OR Git URL (with optional token).
 * TypeScript enforces this at compile time via the union type.
 */
export type InitiateFromKiloSessionOptions = InitiateFromKiloSessionBaseOptions &
  (GitHubSource | GitUrlSource);
