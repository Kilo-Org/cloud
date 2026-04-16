import { dirname } from 'node:path';
import type {
  ExecutionSession,
  SandboxInstance,
  SandboxId,
  SessionContext,
  SessionId,
  InterruptResult,
} from './types.js';
import type { ExecutionParams as _ExecutionParams } from './schema.js';
import { generateSandboxId } from './sandbox-id.js';
import {
  checkDiskAndCleanBeforeSetup,
  cloneGitHubRepo,
  cloneGitRepo,
  cleanupWorkspace,
  getSessionHomePath,
  getSessionWorkspacePath,
  GIT_COMMAND_TIMEOUT_MS,
  manageBranch,
  restoreWorkspace,
  setupWorkspace,
} from './workspace.js';
import { logger, WithLogTags } from './logger.js';
import { timedExec } from './sandbox-timeout-logging.js';
import type {
  PersistenceEnv,
  CloudAgentSessionState,
  MCPServerConfig,
} from './persistence/types.js';
import { MetadataSchema } from './persistence/schemas.js';
import { withDORetry } from './utils/do-retry.js';
import { mergeEnvVarsWithSecrets } from './utils/encryption.js';
import type { EncryptedSecrets } from './router/schemas.js';

const SETUP_COMMAND_TIMEOUT_SECONDS = 120; // 2 minutes
const SANDBOX_RETRY_DEFAULTS = {
  maxAttempts: 3,
  baseBackoffMs: 100,
  maxBackoffMs: 5000,
};

const DEFAULT_DENIED_COMMAND_PATTERNS = ['rm -rf', 'sudo rm', 'mkfs', 'dd if='];

// Keep in sync with: cloud-agent/src/workspace.ts, cloudflare-code-review-infra/src/code-review-orchestrator.ts
// mkdir and touch are intentionally allowed for agent scratch space during analysis
const CODE_REVIEW_ALLOWED_COMMANDS = [
  'ls',
  'cat',
  'echo',
  'pwd',
  'find',
  'grep',
  'git',
  'gh',
  'whoami',
  'date',
  'head',
  'tail',
  'cd',
  'mkdir',
  'touch',
];

const CODE_REVIEW_DENIED_COMMAND_PATTERNS = [
  'git add',
  'git commit',
  'git push',
  'git merge',
  'git rebase',
  'git cherry-pick',
  'git reset',
  'git checkout',
  'git switch',
  'git stash',
  'git tag',
  'git am',
  'git apply',
  'git remote set-url',
  'gh pr merge',
  'gh pr review',
  'gh pr create',
  'gh pr close',
  'gh pr edit',
  'gh issue',
  'gh repo create',
  'gh repo fork',
  'npm test',
  'pnpm test',
  'bun test',
  'yarn test',
  'pytest',
  'vitest',
];

type CommandGuardPolicy = {
  policyName: string;
  allowed: string[];
  denied: string[];
};

function getCommandGuardPolicy(createdOnPlatform?: string): CommandGuardPolicy | null {
  if (createdOnPlatform !== 'code-review') {
    return null;
  }

  return {
    policyName: 'code-review-read-only',
    allowed: CODE_REVIEW_ALLOWED_COMMANDS,
    denied: [...DEFAULT_DENIED_COMMAND_PATTERNS, ...CODE_REVIEW_DENIED_COMMAND_PATTERNS],
  };
}

class SessionSnapshotRestoreError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'SessionSnapshotRestoreError';
  }
}

export function determineBranchName(sessionId: string, upstreamBranch?: string): string {
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
    const details = [`exit code ${exitCode}`, ...(stderr ? [stderr.trim()] : [])].join(': ');
    super(`Setup command failed: ${command} (${details})`);
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
export async function runSetupCommands(
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
      const result = await timedExec(session, command, 'session.runSetupCommand', {
        timeoutMs: SETUP_COMMAND_TIMEOUT_SECONDS * 1000,
        cwd: context.workspacePath,
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

// Write Kilo auth file so the CLI's KiloSessions can call session ingest.
// The CLI reads ~/.local/share/kilo/auth.json via Auth.get("kilo") but we
// never run `kilo auth login` — credentials are injected purely via env vars
// for config (KILO_CONFIG_CONTENT). The session ingest code path ignores the
// provider config and only reads the auth file.
export async function writeAuthFile(
  sandbox: SandboxInstance,
  sessionHome: string,
  kilocodeToken: string
): Promise<void> {
  const authDir = `${sessionHome}/.local/share/kilo`;
  const authPath = `${authDir}/auth.json`;

  await timedExec(sandbox, `mkdir -p ${authDir}`, 'session.writeAuthFile.mkdir');

  const authContent = JSON.stringify({ kilo: { type: 'api', key: kilocodeToken } }, null, 2);
  await sandbox.writeFile(authPath, authContent);

  logger.info('Wrote kilo auth file for session ingest');
}

// Write global rules file so the CLI injects cloud-agent-specific instructions.
// The CLI's RulesMigrator discovers ~/.kilocode/rules/*.md and appends them
// to the system prompt automatically.
export async function writeGlobalRules(
  sandbox: SandboxInstance,
  sessionHome: string,
  sessionId: string
): Promise<void> {
  const rulesDir = `${sessionHome}/.kilocode/rules`;
  const rulesPath = `${rulesDir}/cloud-agent.md`;

  await timedExec(sandbox, `mkdir -p ${rulesDir}`, 'session.writeGlobalRules.mkdir');

  const content = [
    '# Cloud Agent Environment',
    '',
    "You are running inside a sandboxed cloud container, not on the user's local machine.",
    'The filesystem is ephemeral and will not persist after the session ends.',
    "Do not assume access to the user's local files, browsers, or desktop environment.",
    '',
    '## Temporary Files',
    '',
    `When you need to create temporary or scratch files, use \`/tmp/${sessionId}/\` as your scratch directory.`,
    'This path is pre-approved for file access and will not trigger permission prompts.',
    '',
  ].join('\n');

  await sandbox.writeFile(rulesPath, content);
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

    // Use the stored sandboxId when available (handles per-session sandboxes).
    // Fall back to generating from orgId/userId/botId for old sessions that
    // predate sandboxId storage.
    const sandboxId: SandboxId =
      this._metadata.sandboxId ??
      (await generateSandboxId(
        env.PER_SESSION_SANDBOX_ORG_IDS,
        this._metadata.orgId,
        userId,
        sessionId,
        this._metadata.botId
      ));

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
    platform?: 'github' | 'gitlab';
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
      platform: options.platform,
    };
  }

  private getSaferEnvVars(
    userEnvVars: Record<string, string> | undefined,
    sessionHome: string,
    sessionId: string,
    workspacePath: string,
    env: PersistenceEnv,
    originalToken: string,
    kilocodeModel: string | undefined,
    originalOrgId?: string,
    githubToken?: string,
    githubRepo?: string,
    encryptedSecrets?: EncryptedSecrets,
    createdOnPlatform?: string,
    appendSystemPrompt?: string,
    gitUrl?: string,
    gitToken?: string,
    platform?: 'github' | 'gitlab',
    mcpServers?: Record<string, MCPServerConfig>
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
      KILO_DISABLE_AUTOUPDATE: 'true',
      // Feature attribution for microdollar usage tracking
      KILOCODE_FEATURE: createdOnPlatform ?? 'cloud-agent',
    };

    const providerOptions: Record<string, string> = {
      apiKey: kilocodeToken,
      kilocodeToken: kilocodeToken,
    };
    if (kilocodeOrganizationId) {
      providerOptions.kilocodeOrganizationId = kilocodeOrganizationId;
    }
    if (env.KILO_OPENROUTER_BASE) {
      providerOptions.baseURL = env.KILO_OPENROUTER_BASE;
    }
    const isInteractive = createdOnPlatform == 'cloud-agent-web';
    const commandGuardPolicy = getCommandGuardPolicy(createdOnPlatform);

    const permission: Record<string, unknown> = {
      external_directory: {
        '*': 'deny',
        [`/tmp/${sessionId}/**`]: 'allow',
        [`${workspacePath}/**`]: 'allow',
      },
      ...(!isInteractive && { question: 'deny' }),
      read: 'allow',
      edit: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      bash: 'allow',
      task: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      codesearch: 'allow',
      lsp: 'allow',
      skill: 'allow',
      todowrite: 'allow',
      todoread: 'allow',
    };

    if (commandGuardPolicy) {
      // Build bash permission rules from guard policy.
      // Denied patterns (e.g. "git add *") are more specific than allowed patterns
      // (e.g. "git *"); the CLI resolves overlapping globs most-specific-first,
      // so denied sub-commands correctly override broader allows.
      const bashPermissions: Record<string, string> = {};
      for (const cmd of commandGuardPolicy.denied) {
        bashPermissions[`${cmd} *`] = 'deny';
      }
      for (const cmd of commandGuardPolicy.allowed) {
        bashPermissions[`${cmd} *`] = 'allow';
      }

      // Parity with old autoApproval config:
      //   read: allow  (was read.enabled: true)
      //   edit: deny   (was write.enabled: false)
      //   webfetch/websearch/codesearch: deny  (was browser.enabled: false)
      //   MCP: allowed by default (was mcp.enabled: true)
      //   question: handled above (line 564) for non-interactive sessions
      Object.assign(permission, {
        read: 'allow',
        edit: 'deny',
        bash: bashPermissions,
        webfetch: 'deny',
        websearch: 'deny',
        codesearch: 'deny',
        todowrite: 'allow',
        todoread: 'allow',
      });

      logger
        .withFields({
          createdOnPlatform,
          commandPolicy: commandGuardPolicy.policyName,
          deniedCommandPatterns: commandGuardPolicy.denied.length,
        })
        .info('Enabled read-only command guard policy');
    }

    const configContent: Record<string, unknown> = {
      permission,
      provider: {
        kilo: {
          options: providerOptions,
        },
      },
      autoupdate: false,
    };
    // MCP configs are already in CLI-native format — pass through directly
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      configContent.mcp = mcpServers;
      logger.info('MCP config merged into KILO_CONFIG_CONTENT', {
        mcpServerNames: Object.keys(mcpServers),
        mcpServerCount: Object.keys(mcpServers).length,
      });
    }
    if (kilocodeModel && kilocodeModel.trim()) {
      const normalizedModel = kilocodeModel.startsWith('kilo/')
        ? kilocodeModel
        : `kilo/${kilocodeModel}`;
      configContent.model = normalizedModel;
    }
    // Add custom agent config if appendSystemPrompt is provided (from prepareSession)
    if (appendSystemPrompt && appendSystemPrompt.trim()) {
      configContent.agent = {
        custom: {
          prompt: appendSystemPrompt,
        },
      };
    }
    const configJson = JSON.stringify(configContent);
    envVars.OPENCODE_CONFIG_CONTENT = configJson;
    envVars.KILO_CONFIG_CONTENT = configJson;
    // Set GH_TOKEN for GitHub repos only, respecting user overrides
    if (githubToken && githubRepo && !baseEnvVars.GH_TOKEN) {
      envVars.GH_TOKEN = githubToken;
    }

    // Determine effective platform: use explicit platform param, or infer from gitUrl as fallback
    const effectivePlatform = platform ?? (gitUrl?.includes('gitlab') ? 'gitlab' : undefined);

    // Set GITLAB_TOKEN for GitLab repos, respecting user overrides
    if (gitToken && effectivePlatform === 'gitlab' && !baseEnvVars.GITLAB_TOKEN) {
      envVars.GITLAB_TOKEN = gitToken;
      if (!baseEnvVars.GITLAB_HOST) {
        if (gitUrl) {
          try {
            const url = new URL(gitUrl);
            envVars.GITLAB_HOST = url.host;
          } catch {
            envVars.GITLAB_HOST = 'gitlab.com';
          }
        } else {
          envVars.GITLAB_HOST = 'gitlab.com';
        }
      }
      logger
        .withFields({
          gitUrl,
          gitlabHost: envVars.GITLAB_HOST,
          gitTokenLength: gitToken.length,
        })
        .info('[GITLAB] Setting GITLAB_TOKEN and GITLAB_HOST for GitLab session');
    }

    // Only add KILOCODE_ORG_ID if we have an org (personal accounts don't have one)
    if (kilocodeOrganizationId) {
      envVars.KILOCODE_ORGANIZATION_ID = kilocodeOrganizationId;
    }

    if (env.KILOCODE_BACKEND_BASE_URL) {
      envVars.KILOCODE_BACKEND_BASE_URL = env.KILOCODE_BACKEND_BASE_URL;
      // Used by kilo server to check user auth to send to ingest
      envVars.KILO_API_URL = env.KILOCODE_BACKEND_BASE_URL;
    }

    if (env.KILO_SESSION_INGEST_URL) {
      envVars.KILO_SESSION_INGEST_URL = env.KILO_SESSION_INGEST_URL;
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
    kilocodeModel: string | undefined,
    originalOrgId?: string,
    encryptedSecrets?: EncryptedSecrets,
    createdOnPlatform?: string,
    appendSystemPrompt?: string,
    mcpServers?: Record<string, MCPServerConfig>
  ) {
    const { sessionId, sessionHome, workspacePath, envVars } = context;

    // Decrypt secrets and merge with env vars (just-in-time decryption)
    const saferEnvVars = this.getSaferEnvVars(
      envVars,
      sessionHome,
      sessionId,
      workspacePath,
      env,
      originalToken,
      kilocodeModel,
      originalOrgId,
      context.githubToken,
      context.githubRepo,
      encryptedSecrets,
      createdOnPlatform,
      appendSystemPrompt,
      context.gitUrl,
      context.gitToken,
      context.platform,
      mcpServers
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

    // Check disk space before creating any directories; clean stale workspaces if low
    await checkDiskAndCleanBeforeSetup(sandbox, orgId, userId, sessionId);

    const { workspacePath, sessionHome } = await setupWorkspace(sandbox, userId, orgId, sessionId);

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
      platform: options.platform,
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
      kilocodeModel,
      orgId,
      encryptedSecrets,
      createdOnPlatform,
      undefined, // appendSystemPrompt
      mcpServers
    );

    // Clone repository using appropriate method
    // Shallow clone (depth: 1) can be enabled for faster checkout and reduced disk usage
    const cloneOptions = shallow ? { shallow: true } : undefined;
    if (gitUrl) {
      await cloneGitRepo(session, workspacePath, gitUrl, gitToken, undefined, {
        ...cloneOptions,
        platform: context.platform,
      });
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
      const result = await timedExec(
        session,
        `cd ${context.workspacePath} && git checkout -b '${context.branchName}'`,
        'session.initiate.createBranch'
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

    // Write auth file for session ingest
    await writeAuthFile(sandbox, context.sessionHome, kilocodeToken);
    await writeGlobalRules(sandbox, context.sessionHome, context.sessionId);

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

    return {
      context,
      session,
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

    // Check disk space before creating any directories; clean stale workspaces if low
    await checkDiskAndCleanBeforeSetup(sandbox, orgId, userId, sessionId);

    // Setup workspace (same as initiate)
    const { workspacePath, sessionHome } = await setupWorkspace(sandbox, userId, orgId, sessionId);

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
      platform: existingMetadata?.platform,
    });

    if (envVars) {
      context.envVars = envVars;
    }

    const session = await this.getOrCreateSession(
      sandbox,
      context,
      env,
      kilocodeToken,
      kilocodeModel,
      orgId,
      encryptedSecrets,
      options.createdOnPlatform ?? existingMetadata?.createdOnPlatform,
      existingMetadata?.appendSystemPrompt,
      mcpServers
    );

    // Clone repository using appropriate method
    if (gitUrl) {
      await cloneGitRepo(session, workspacePath, gitUrl, gitToken, undefined, {
        platform: context.platform,
      });
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
        const result = await timedExec(
          session,
          `cd ${context.workspacePath} && git checkout -b '${context.branchName}'`,
          'session.initiateFromKiloSession.createBranch'
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

    // Write auth file for session ingest
    await writeAuthFile(sandbox, context.sessionHome, kilocodeToken);
    await writeGlobalRules(sandbox, context.sessionHome, sessionId);

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

    return {
      context,
      session,
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

    // Check disk space before creating any directories; clean stale workspaces if low
    await checkDiskAndCleanBeforeSetup(sandbox, orgId, userId, sessionId);

    const workspacePath = getSessionWorkspacePath(orgId, userId, sessionId);
    const sessionHome = getSessionHomePath(sessionId);

    // Ensure workspace directories exist before creating session
    await sandbox.mkdir(workspacePath, { recursive: true });
    await sandbox.mkdir(sessionHome, { recursive: true });

    // Session home directory

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
      platform: metadata?.platform,
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
      kilocodeModel,
      orgId,
      metadata?.encryptedSecrets,
      metadata?.createdOnPlatform,
      metadata?.appendSystemPrompt,
      metadata?.mcpServers
    );

    // Check if workspace repo exists - if not, we may need to reclone
    const repoCheck = await timedExec(
      session,
      `test -d ${workspacePath}/.git && echo exists`,
      'session.resume.repoExists'
    );
    const repoExists = repoCheck.stdout?.includes('exists') ?? false;
    const isColdStart = !repoExists;

    // Only re-run setup if we had to reclone (cold start)
    if (isColdStart) {
      await this.handleColdStartResume({
        session,
        sessionId,
        userId,
        sandbox,
        context,
        metadata,
        env,
        kilocodeToken,
        freshGithubToken,
        freshGitToken,
        onProgress: options.onProgress,
      });
    }

    return {
      context,
      session,
    };
  }

  private async handleColdStartResume({
    session,
    sessionId,
    userId,
    sandbox,
    context,
    metadata,
    env,
    kilocodeToken,
    freshGithubToken,
    freshGitToken,
    onProgress,
  }: {
    session: ExecutionSession;
    sessionId: string;
    userId: string;
    sandbox: SandboxInstance;
    context: SessionContext;
    metadata: CloudAgentSessionState | null;
    env: PersistenceEnv;
    kilocodeToken: string;
    freshGithubToken?: string;
    freshGitToken?: string;
    onProgress?: (step: string, message: string) => void;
  }): Promise<void> {
    if (!metadata) {
      throw new Error(
        `Session ${sessionId} workspace is missing and metadata could not be retrieved. Please re-initiate the session.`
      );
    }

    // Cold-start resume must restore snapshot or fail.
    if (!metadata.kiloSessionId) {
      throw new Error(
        `Session ${sessionId} has no kiloSessionId in metadata. Cannot restore snapshot.`
      );
    }
    // Wrap clone and all post-clone steps so that any failure removes the
    // workspace directory. Without this, `.git` survives and the next retry
    // sees `isColdStart = false`, skipping the full restore flow — leaving
    // the session in a broken half-initialized state.
    try {
      // Clone first so .git exists when `kilo import` runs — the CLI derives
      // the project ID from the repo's root commit hash; without a repo the
      // FK on session.project_id fails.
      onProgress?.('cloning', 'Cloning repository…');
      await restoreWorkspace(session, context.workspacePath, context.branchName, {
        githubRepo: metadata.githubRepo,
        githubToken: freshGithubToken ?? metadata.githubToken,
        gitUrl: metadata.gitUrl,
        gitToken: freshGitToken ?? metadata.gitToken,
        gitAuthorEnv: getGitAuthorEnv(env, metadata.githubAppType),
        lastSeenBranch: metadata.upstreamBranch,
        platform: context.platform,
      });
      // Write auth file BEFORE kilo import so KiloSessions.bootstrap() can authenticate
      onProgress?.('workspace_setup', 'Setting up workspace…');
      await writeAuthFile(sandbox, context.sessionHome, kilocodeToken);
      await writeGlobalRules(sandbox, context.sessionHome, sessionId);

      // Single restore script handles download, import, and diff application inside
      // the sandbox — the snapshot never enters worker memory.
      onProgress?.('kilo_session', 'Restoring session…');
      logger.info('Starting cold-start session restore');

      const escapedId = metadata.kiloSessionId.replaceAll("'", "'\\''");
      const escapedWorkspace = context.workspacePath.replaceAll("'", "'\\''");
      const restoreResult = await timedExec(
        session,
        `bun /usr/local/bin/kilo-restore-session.js '${escapedId}' '${escapedWorkspace}'`,
        'session.coldStart.restore',
        { timeoutMs: GIT_COMMAND_TIMEOUT_MS, cwd: dirname(context.workspacePath) }
      );

      if (restoreResult.exitCode !== 0) {
        logger
          .withFields({
            sessionId,
            userId,
            exitCode: restoreResult.exitCode,
            stderr: restoreResult.stderr,
            stdout: restoreResult.stdout,
          })
          .error('Cold-start session restore failed');

        // Parse stdout JSON for structured error info
        let code: number | undefined;
        let step: string | undefined;
        let restoreError: string | undefined;
        try {
          const parsed = JSON.parse(restoreResult.stdout?.trim() ?? '{}') as Record<
            string,
            unknown
          >;
          if (typeof parsed.code === 'number') {
            code = parsed.code;
          }
          if (typeof parsed.step === 'string') {
            step = parsed.step;
          }
          if (typeof parsed.error === 'string') {
            restoreError = parsed.error;
          }
        } catch {
          // non-JSON stdout, ignore
        }

        if (code === 404) {
          throw new SessionSnapshotRestoreError(
            'Session snapshot restore failed: session not found',
            404
          );
        }

        const detail = [
          `exit ${restoreResult.exitCode}`,
          step && `step=${step}`,
          restoreError && `error=${restoreError}`,
        ]
          .filter(Boolean)
          .join(', ');
        throw new SessionSnapshotRestoreError(`Cold-start session restore failed: ${detail}`, code);
      }

      // Log structured summary from restore script
      try {
        const summary = JSON.parse(restoreResult.stdout?.trim() ?? '{}') as Record<string, unknown>;
        logger
          .withFields({ sessionId, userId, ...summary })
          .info('Cold-start session restore completed');
      } catch {
        // non-JSON stdout, non-fatal
      }

      // Re-run setup commands (fresh clone, need to reinstall)
      if (metadata.setupCommands && metadata.setupCommands.length > 0) {
        onProgress?.('setup_commands', 'Running setup commands…');
        logger.info('Re-running setup commands after fresh clone');
        await runSetupCommands(session, context, metadata.setupCommands, false); // lenient
      }

      // Wrapper will be (re)started by the orchestrator after we return
      onProgress?.('kilo_server', 'Starting Kilo…');
    } catch (error) {
      // Remove the workspace and sessionHome so the next retry sees a true
      // cold start and re-runs the full restore from scratch.
      logger
        .withFields({
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
        .warn('Cold-start resume step failed; removing workspace for clean retry');
      await cleanupWorkspace(session, context.workspacePath, context.sessionHome);

      throw error;
    }
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
        return session.exec(`pkill -f -- '${pattern}'`);
      };

      let execIdError: string | null = null;

      if (executionId) {
        // Prefer the wrapper execution ID for v2 sessions.
        // pkill -f matches against the full command line.
        const execResult = await attemptPkill(`--execution-id=${executionId}`, 'executionId');
        if (execResult.exitCode === 0) {
          return {
            success: true,
            message: 'Interrupted execution using pkill (executionId)',
            processesFound: true,
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
          message: execIdError
            ? `Interrupted execution using pkill (sessionId fallback). ${execIdError}`
            : 'Interrupted execution using pkill',
          processesFound: true,
        };
      }
      if (sessionResult.exitCode === 1) {
        logger.info('No matching processes found for pkill', {
          sessionId,
          elapsedMs: elapsed,
        });

        return {
          success: true,
          message: execIdError
            ? `No running processes found for this session. ${execIdError}`
            : 'No running processes found for this session',
          processesFound: false,
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
        message: execIdError
          ? `${execIdError}; sessionId pkill failed with exit code ${sessionResult.exitCode}: ${sessionResult.stderr}`
          : `pkill failed with exit code ${sessionResult.exitCode}: ${sessionResult.stderr}`,
        processesFound: false,
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
          message: 'No running kilocode processes found for this session',
          processesFound: false,
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
        message:
          killed.length > 0
            ? `Interrupted execution: killed ${killed.length} process(es)${failed.length > 0 ? `, ${failed.length} failed` : ''}`
            : `Failed to kill any processes (${failed.length} attempts failed)`,
        processesFound: true,
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
    const { orgId, userId, sessionId, botId, platform, sandboxId } = context;
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
      platform,
      sandboxId,
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
   * Create a cli_sessions_v2 record via session-ingest RPC.
   * Called during session preparation so the DB record exists before execution.
   */
  async createCliSessionViaSessionIngest(
    kiloSessionId: string,
    cloudAgentSessionId: string,
    kiloUserId: string,
    env: PersistenceEnv,
    organizationId: string | undefined,
    createdOnPlatform: string,
    title?: string
  ): Promise<void> {
    try {
      await env.SESSION_INGEST.createSessionForCloudAgent({
        sessionId: kiloSessionId,
        kiloUserId,
        cloudAgentSessionId,
        organizationId,
        createdOnPlatform,
        title,
      });
    } catch (error) {
      logger
        .withFields({
          kiloSessionId,
          cloudAgentSessionId,
          kiloUserId,
          error: error instanceof Error ? error.message : String(error),
        })
        .error('session-ingest RPC createSessionForCloudAgent failed');
      throw error;
    }
  }

  /**
   * Delete a cli_sessions_v2 record via session-ingest RPC.
   * Used for rollback when DO prepare() fails after the record was created.
   */
  async deleteCliSessionViaSessionIngest(
    kiloSessionId: string,
    kiloUserId: string,
    env: PersistenceEnv,
    opts?: { onlyIfEmpty?: boolean }
  ): Promise<void> {
    try {
      await env.SESSION_INGEST.deleteSessionForCloudAgent({
        sessionId: kiloSessionId,
        kiloUserId,
        onlyIfEmpty: opts?.onlyIfEmpty,
      });
    } catch (error) {
      logger
        .withFields({
          kiloSessionId,
          kiloUserId,
          error: error instanceof Error ? error.message : String(error),
        })
        .error('session-ingest RPC deleteSessionForCloudAgent failed');
      throw error;
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
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab';
}

export interface ResumeOptions {
  sandbox: SandboxInstance;
  sandboxId: SessionContext['sandboxId'];
  orgId?: string;
  userId: string;
  sessionId: SessionId;
  kilocodeToken: string;
  kilocodeModel: string;
  env: PersistenceEnv;
  githubToken?: string;
  gitToken?: string;
  onProgress?: (step: string, message: string) => void;
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
  /** GitHub App type for selecting correct slug/bot identity */
  githubAppType?: 'standard' | 'lite';
  createdOnPlatform?: string;
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
