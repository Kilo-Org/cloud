import { dirname } from 'node:path';
import type {
  ExecutionSession,
  SandboxInstance,
  SandboxId,
  SessionContext,
  SessionId,
  InterruptResult,
} from './types.js';
import { generateSandboxId } from './sandbox-id.js';
import { normalizeKilocodeModel } from './persistence/model-utils.js';
import {
  resolveGitHubTokenForRepo,
  resolveManagedGitLabToken,
} from './services/git-token-service-client.js';
import { ExecutionError } from './execution/errors.js';
import {
  checkDiskAndCleanBeforeSetup,
  cloneGitHubRepo,
  cloneGitRepo,
  cleanupWorkspace,
  getSessionHomePath,
  getSessionWorkspacePath,
  GIT_COMMAND_TIMEOUT_MS,
  manageBranch,
  setupWorkspace,
  updateGitRemoteToken,
} from './workspace.js';
import { logger, WithLogTags } from './logger.js';
import { timedExec } from './sandbox-timeout-logging.js';
import type {
  PersistenceEnv,
  CloudAgentSessionState,
  MCPServerConfig,
  RuntimeSkill,
  RuntimeAgent,
} from './persistence/types.js';
import { parseSessionMetadata } from './persistence/session-metadata.js';
import { withDORetry } from './utils/do-retry.js';
import { decryptWithPrivateKey, mergeEnvVarsWithSecrets } from './utils/encryption.js';
import type { MCPSecretValue } from './router/schemas.js';
import type { SessionProfileBundle } from './session-profile.js';
import { readProfileBundle } from './session-profile.js';
import {
  bringUpDevContainer,
  buildRestoreCommand,
  detectDevContainer,
  KILO_AGENT_SESSION_LABEL,
  KILO_CLI_VERSION,
  type DevContainerHandle,
} from './kilo/devcontainer.js';
import { randomPort } from './kilo/ports.js';
import {
  buildKiloSessionXdgEnv,
  dockerSocketEnv,
  resolveDockerSocketPath,
} from './kilo/sandbox-runtime.js';
import { shellQuote, validShellEnvEntries } from './kilo/utils.js';
import { buildSignedImagePromptAttachments } from './execution/image-prompt-parts.js';
import {
  type WrapperBootstrapRepoSource,
  type WrapperCommandRequest,
  type WrapperPromptRequest,
  type WrapperSessionReadyRequest,
  type WrapperWorkspaceReady,
} from './shared/wrapper-bootstrap.js';
import type {
  FencedLegacyExecutionRequest,
  FencedWrapperDispatchRequest,
} from './execution/types.js';
import { normalizeAgentMode } from './schema.js';

const SETUP_COMMAND_TIMEOUT_SECONDS = 300; // 5 minutes
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
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'jq',
  'git',
  'gh',
  'whoami',
  'date',
  'stat',
  'file',
  'head',
  'tail',
  'sed',
  'cd',
  'mkdir',
  'touch',
];

const CODE_REVIEW_DENIED_COMMAND_PATTERNS = [
  'bash',
  'sh',
  'zsh',
  'fish',
  'sed -i',
  'sed -*i',
  'sed --in-place',
  'sed --in-place*',
  'sed * -i',
  'sed * -*i',
  'sed * --in-place',
  'sed * --in-place*',
  'sort -o',
  'sort -o*',
  'sort -*o',
  'sort --output',
  'sort --output*',
  'sort * -o',
  'sort * -o*',
  'sort * -*o',
  'sort * --output',
  'sort * --output*',
  'uniq * *',
  'python',
  'python3',
  'node',
  'irb',
  'php -a',
  'rails console',
  'vi',
  'vim',
  'nvim',
  'nano',
  'emacs',
  'less',
  'more',
  'top',
  'htop',
  'watch',
  'tail -f',
  'ssh',
  'tmux',
  'screen',
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
  'gh pr checkout',
  'gh auth login',
  'gh auth refresh',
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

export function backendUrlForSandbox(workerBackendUrl: string): string {
  try {
    const url = new URL(workerBackendUrl);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = 'host.docker.internal';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // Non-URL value: leave untouched.
  }
  return workerBackendUrl;
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

export type ResolvedWorkspaceTokens = {
  githubToken?: string;
  githubInstallationId?: string;
  githubAppType?: 'standard' | 'lite';
  gitToken?: string;
  gitlabTokenManaged?: boolean;
};

function parseRestoreScriptOutput(stdout: string | undefined): {
  code?: number;
  step?: string;
  error?: string;
} | null {
  try {
    const parsed = JSON.parse(stdout?.trim() ?? '{}') as Record<string, unknown>;
    return {
      code: typeof parsed.code === 'number' ? parsed.code : undefined,
      step: typeof parsed.step === 'string' ? parsed.step : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
    };
  } catch {
    return null;
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
type RunSetupCommandsOptions = {
  devcontainer?: DevContainerHandle;
  dockerEnv?: Record<string, string>;
  runtimeEnv?: Record<string, string | undefined>;
};

function buildSetupEnvFileContent(env: Record<string, string | undefined>): string {
  return `${validShellEnvEntries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n')}\n`;
}

function buildDevContainerSetupCommand(
  devcontainer: DevContainerHandle,
  command: string,
  envFilePath: string | undefined
): string {
  const workspaceCommand = `cd ${shellQuote(devcontainer.innerWorkspaceFolder)} && ${command}`;
  const innerCommand = envFilePath
    ? `. ${shellQuote(envFilePath)} && ${workspaceCommand}`
    : workspaceCommand;
  return [
    'devcontainer exec',
    `--workspace-folder ${shellQuote(devcontainer.workspacePath)}`,
    `--config ${shellQuote(devcontainer.overrideConfigPath)}`,
    `--id-label ${shellQuote(`${KILO_AGENT_SESSION_LABEL}=${devcontainer.agentSessionId}`)}`,
    '--',
    'sh -c',
    shellQuote(innerCommand),
  ].join(' ');
}

export async function runSetupCommands(
  session: ExecutionSession,
  context: SessionContext,
  setupCommands: string[],
  failFast: boolean = false,
  options: RunSetupCommandsOptions = {}
): Promise<void> {
  if (!setupCommands || setupCommands.length === 0) {
    return;
  }

  const dockerEnv = options.devcontainer
    ? (options.dockerEnv ?? dockerSocketEnv(await resolveDockerSocketPath(session)))
    : undefined;
  const setupEnvFilePath =
    options.devcontainer && options.runtimeEnv
      ? `${context.sessionHome}/tmp/kilo-setup-env-${options.devcontainer.agentSessionId}-${Date.now()}.sh`
      : undefined;

  if (setupEnvFilePath && options.runtimeEnv) {
    await session.writeFile(setupEnvFilePath, buildSetupEnvFileContent(options.runtimeEnv));
  }

  logger.setTags({ setupCommandsCount: setupCommands.length });
  logger.info('Running setup commands');

  try {
    for (const command of setupCommands) {
      try {
        const setupCommand = options.devcontainer
          ? buildDevContainerSetupCommand(options.devcontainer, command, setupEnvFilePath)
          : command;
        const result = await timedExec(session, setupCommand, 'session.runSetupCommand', {
          timeoutMs: SETUP_COMMAND_TIMEOUT_SECONDS * 1000,
          cwd: context.workspacePath,
          env: dockerEnv,
        });

        if (result.exitCode !== 0) {
          logger
            .withFields({
              command,
              exitCode: result.exitCode,
              stdout: result.stdout,
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
  } finally {
    if (setupEnvFilePath) {
      try {
        await timedExec(
          session,
          `rm -f ${shellQuote(setupEnvFilePath)}`,
          'session.runSetupCommand.cleanup'
        );
      } catch (error) {
        logger
          .withFields({
            setupEnvFilePath,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Failed to clean up setup command env file');
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

function getRestoreTokenFilePath(sessionHome: string): string {
  return `${sessionHome}/.local/share/kilo/session-restore-token`;
}

async function writeRestoreTokenFile(
  sandbox: SandboxInstance,
  session: ExecutionSession,
  sessionHome: string,
  kilocodeToken: string
): Promise<string> {
  const tokenPath = getRestoreTokenFilePath(sessionHome);
  const tokenDir = dirname(tokenPath);

  await timedExec(session, `mkdir -p ${shellQuote(tokenDir)}`, 'session.restoreTokenFile.mkdir');
  await sandbox.writeFile(tokenPath, kilocodeToken);
  await timedExec(session, `chmod 600 ${shellQuote(tokenPath)}`, 'session.restoreTokenFile.chmod');

  return tokenPath;
}

async function cleanupRestoreTokenFile(
  session: ExecutionSession,
  tokenPath: string,
  sessionId: string
): Promise<void> {
  try {
    await timedExec(session, `rm -f ${shellQuote(tokenPath)}`, 'session.restoreTokenFile.cleanup');
  } catch (error) {
    logger
      .withFields({
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      .warn('Failed to clean up restore token file');
  }
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
 * CLI-native MCP config shape (env/header values as plain strings), ready to
 * JSON-encode into KILO_CONFIG_CONTENT.mcp.
 */
type CliMcpServer =
  | {
      type: 'local';
      command: string[];
      environment?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
    }
  | {
      type: 'remote';
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
    };

function materializeSecretValueRecord(
  values: Record<string, MCPSecretValue> | undefined,
  privateKey: string | undefined,
  label: string
): Record<string, string> | undefined {
  if (!values || Object.keys(values).length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    if (!privateKey) {
      throw new Error(
        `${label} contains encrypted values but AGENT_ENV_VARS_PRIVATE_KEY is not configured on the worker`
      );
    }
    out[key] = decryptWithPrivateKey(value, privateKey);
  }
  return out;
}

/** Materialize each MCP env/header value into its plaintext form for the CLI. */
function materializeMcpServers(
  mcpServers: Record<string, MCPServerConfig>,
  privateKey: string | undefined
): Record<string, CliMcpServer> {
  const out: Record<string, CliMcpServer> = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.type === 'local') {
      const environment = materializeSecretValueRecord(
        server.environment,
        privateKey,
        `MCP server "${name}" environment`
      );
      out[name] = {
        type: 'local',
        command: server.command,
        ...(environment !== undefined && { environment }),
        ...(server.enabled !== undefined && { enabled: server.enabled }),
        ...(server.timeout !== undefined && { timeout: server.timeout }),
      };
    } else {
      const headers = materializeSecretValueRecord(
        server.headers,
        privateKey,
        `MCP server "${name}" headers`
      );
      out[name] = {
        type: 'remote',
        url: server.url,
        ...(headers !== undefined && { headers }),
        ...(server.enabled !== undefined && { enabled: server.enabled }),
        ...(server.timeout !== undefined && { timeout: server.timeout }),
      };
    }
  }
  return out;
}

function shortHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

export function buildAgentEntryFromRuntimeAgent(agent: RuntimeAgent): Record<string, unknown> {
  const { config } = agent;
  const entry: Record<string, unknown> = {
    mode: config.mode ?? 'primary',
  };
  if (config.prompt !== undefined) entry.prompt = config.prompt;
  if (config.description !== undefined) entry.description = config.description;
  if (config.model != null) entry.model = normalizeKilocodeModel(config.model);
  if (config.variant !== undefined) entry.variant = config.variant;
  if (config.temperature !== undefined) entry.temperature = config.temperature;
  if (config.top_p !== undefined) entry.top_p = config.top_p;
  if (config.steps !== undefined) entry.steps = config.steps;
  if (config.hidden !== undefined) entry.hidden = config.hidden;
  if (config.disable !== undefined) entry.disable = config.disable;
  if (config.color !== undefined) entry.color = config.color;
  if (config.permission !== undefined) entry.permission = config.permission;
  if (config.options !== undefined) entry.options = config.options;
  return entry;
}

function isSafeSkillFilePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.length > 200) return false;
  if (relativePath.startsWith('/')) return false;
  if (relativePath.includes('..')) return false;
  if (relativePath.includes('\\') || relativePath.includes('\0')) return false;
  if (relativePath.toLowerCase() === 'skill.md') return false;
  return /^[a-zA-Z0-9._\-/]+$/.test(relativePath);
}

/** Write each runtime skill to `${sessionHome}/.kilocode/skills/<name>/SKILL.md`. */
export async function writeRuntimeSkills(
  sandbox: SandboxInstance,
  sessionHome: string,
  skills: readonly RuntimeSkill[] | undefined
): Promise<void> {
  if (!skills || skills.length === 0) return;

  const baseDir = `${sessionHome}/.kilocode/skills`;
  await timedExec(sandbox, `mkdir -p ${baseDir}`, 'session.writeRuntimeSkills.mkdir');

  const summaries: { name: string; bytes: number; hash: string; fileCount: number }[] = [];
  for (const skill of skills) {
    const skillDir = `${baseDir}/${skill.name}`;
    const skillPath = `${skillDir}/SKILL.md`;
    await timedExec(sandbox, `mkdir -p ${skillDir}`, 'session.writeRuntimeSkills.mkdir');
    await sandbox.writeFile(skillPath, skill.rawMarkdown);

    let fileCount = 0;
    if (skill.files) {
      for (const [relativePath, content] of Object.entries(skill.files)) {
        if (!isSafeSkillFilePath(relativePath)) {
          logger.withFields({ skill: skill.name, relativePath }).warn('Rejected unsafe skill file');
          continue;
        }
        const filePath = `${skillDir}/${relativePath}`;
        const parent = filePath.substring(0, filePath.lastIndexOf('/'));
        if (parent && parent !== skillDir) {
          await timedExec(sandbox, `mkdir -p ${parent}`, 'session.writeRuntimeSkills.mkdir');
        }
        await sandbox.writeFile(filePath, content);
        fileCount += 1;
      }
    }

    summaries.push({
      name: skill.name,
      bytes: skill.rawMarkdown.length,
      hash: shortHash(skill.rawMarkdown),
      fileCount,
    });
  }

  logger
    .withFields({ skillCount: summaries.length, skills: summaries })
    .info('Wrote runtime skills');
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

  try {
    return parseSessionMetadata(metadata);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger
      .withFields({
        userId,
        sessionId,
        reason,
      })
      .error('Invalid session metadata shape');
    throw new InvalidSessionMetadataError(userId, sessionId, reason);
  }
}

/**
 * Generate a unique session ID with the agent_ prefix.
 */
export function generateSessionId(): SessionId {
  return `agent_${crypto.randomUUID()}`;
}

function githubRepository(metadata: CloudAgentSessionState) {
  return metadata.repository?.type === 'github' ? metadata.repository : undefined;
}

function gitRepository(metadata: CloudAgentSessionState) {
  const repository = metadata.repository;
  return repository?.type === 'git' || repository?.type === 'gitlab' ? repository : undefined;
}

function repositoryPlatform(metadata: CloudAgentSessionState): 'github' | 'gitlab' | undefined {
  const repository = metadata.repository;
  if (!repository) return undefined;
  if (repository.platform) return repository.platform;
  if (repository.type === 'github') return 'github';
  if (repository.type === 'gitlab') return 'gitlab';
  return undefined;
}

function repositoryShallow(metadata: CloudAgentSessionState): boolean | undefined {
  return metadata.workspace?.shallow;
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
      this._metadata.workspace?.sandboxId ??
      (await generateSandboxId(
        env.PER_SESSION_SANDBOX_ORG_IDS,
        this._metadata.identity.orgId,
        userId,
        sessionId,
        this._metadata.identity.botId
      ));

    return sandboxId;
  }

  /**
   * Derive a SessionContext from the provided metadata.
   *
   * `branchName` defaults to the upstream branch (or a generated
   * `session/<sessionId>` name) via {@link determineBranchName}; callers that
   * have a previously-recorded session branch (e.g. cold-evicted resume) may
   * pass it through explicitly.
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
    branchName?: string;
    envVars?: Record<string, string>;
    botId?: string;
    platform?: 'github' | 'gitlab';
  }): SessionContext {
    const sessionHome = options.sessionHome ?? getSessionHomePath(options.sessionId);
    const workspacePath =
      options.workspacePath ??
      getSessionWorkspacePath(options.orgId, options.userId, options.sessionId);

    const branchName =
      options.branchName ?? determineBranchName(options.sessionId, options.upstreamBranch);

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
      envVars: options.envVars,
    };
  }

  buildRuntimeEnv(opts: BuildRuntimeEnvOptions): Record<string, string> {
    const { context, profile } = opts;
    const { sessionId, sessionHome, workspacePath, envVars: contextEnvVars } = context;

    const effectiveProfile: SessionProfileBundle | undefined =
      profile === undefined && contextEnvVars === undefined
        ? undefined
        : { ...profile, envVars: profile?.envVars ?? contextEnvVars };

    return this.getSaferEnvVars({
      sessionHome,
      sessionId,
      workspacePath,
      env: opts.env,
      originalToken: opts.originalToken,
      kilocodeModel: opts.kilocodeModel,
      originalOrgId: opts.originalOrgId,
      githubToken: context.githubToken,
      githubRepo: context.githubRepo,
      createdOnPlatform: opts.createdOnPlatform,
      appendSystemPrompt: opts.appendSystemPrompt,
      gitUrl: context.gitUrl,
      gitToken: context.gitToken,
      platform: context.platform,
      profile: effectiveProfile,
    });
  }

  private getSaferEnvVars(opts: GetSaferEnvVarsOptions): Record<string, string> {
    const {
      sessionHome,
      sessionId,
      workspacePath,
      env,
      originalToken,
      kilocodeModel,
      originalOrgId,
      githubToken,
      githubRepo,
      createdOnPlatform,
      appendSystemPrompt,
      gitUrl,
      gitToken,
      platform,
      profile,
    } = opts;
    const userEnvVars = profile?.envVars;
    const encryptedSecrets = profile?.encryptedSecrets;
    const mcpServers = profile?.mcpServers;
    const runtimeAgents = profile?.runtimeAgents;
    const kiloCommands = profile?.kiloCommands;

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
      providerOptions.baseURL = backendUrlForSandbox(env.KILO_OPENROUTER_BASE);
    }
    const isInteractive = createdOnPlatform == 'cloud-agent-web';
    const commandGuardPolicy = getCommandGuardPolicy(createdOnPlatform);

    if (commandGuardPolicy) {
      Object.assign(envVars, {
        CI: 'true',
        GIT_TERMINAL_PROMPT: '0',
        GH_PROMPT_DISABLED: '1',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        TERM: 'dumb',
      });
    }

    const permission: Record<string, unknown> = {
      external_directory: {
        '*': 'deny',
        [`/tmp/${sessionId}/**`]: 'allow',
        [`${workspacePath}/**`]: 'allow',
        [`${sessionHome}/.kilocode/skills/**`]: 'allow',
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
      suggest: 'deny',
    };

    if (commandGuardPolicy) {
      // Build bash permission rules from guard policy. Denies are inserted after
      // allows so exact duplicates still fail closed; more-specific denied
      // sub-commands also override broader allowed commands in the CLI matcher.
      const bashPermissions: Record<string, string> = {};
      for (const cmd of commandGuardPolicy.allowed) {
        bashPermissions[cmd] = 'allow';
        bashPermissions[`${cmd} *`] = 'allow';
      }
      for (const cmd of commandGuardPolicy.denied) {
        bashPermissions[cmd] = 'deny';
        bashPermissions[`${cmd} *`] = 'deny';
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
      snapshot: false,
    };
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      const materialized = materializeMcpServers(mcpServers, env.AGENT_ENV_VARS_PRIVATE_KEY);
      configContent.mcp = materialized;
      logger.info('MCP config merged into KILO_CONFIG_CONTENT', {
        mcpServerNames: Object.keys(materialized),
        mcpServerCount: Object.keys(materialized).length,
      });
    }
    if (kilocodeModel && kilocodeModel.trim()) {
      configContent.model = normalizeKilocodeModel(kilocodeModel);
    }
    const agentConfig: Record<string, unknown> = {};
    if (appendSystemPrompt && appendSystemPrompt.trim()) {
      agentConfig.custom = { prompt: appendSystemPrompt };
    }
    if (runtimeAgents && runtimeAgents.length > 0) {
      for (const agent of runtimeAgents) {
        agentConfig[agent.slug] = buildAgentEntryFromRuntimeAgent(agent);
      }
      logger.info('Runtime agents merged into KILO_CONFIG_CONTENT', {
        agentSlugs: runtimeAgents.map(a => a.slug),
        agentCount: runtimeAgents.length,
      });
    }
    if (Object.keys(agentConfig).length > 0) {
      configContent.agent = agentConfig;
    }
    if (kiloCommands && kiloCommands.length > 0) {
      configContent.command = Object.fromEntries(
        kiloCommands.map(cmd => [
          cmd.name,
          {
            template: cmd.template,
            ...(cmd.description && { description: cmd.description }),
            ...(cmd.agent && { agent: cmd.agent }),
            ...(cmd.model && { model: normalizeKilocodeModel(cmd.model) }),
            subtask: cmd.subtask ?? false,
          },
        ])
      );
      logger.info('Kilo commands merged into KILO_CONFIG_CONTENT', {
        kiloCommandNames: kiloCommands.map(c => c.name),
        kiloCommandCount: kiloCommands.length,
      });
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
      const sandboxUrl = backendUrlForSandbox(env.KILOCODE_BACKEND_BASE_URL);
      envVars.KILOCODE_BACKEND_BASE_URL = sandboxUrl;
      // Used by kilo server to check user auth to send to ingest
      envVars.KILO_API_URL = sandboxUrl;
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
  async getOrCreateSession(opts: GetOrCreateSessionOptions) {
    const {
      sandbox,
      context,
      env,
      originalToken,
      kilocodeModel,
      originalOrgId,
      createdOnPlatform,
      appendSystemPrompt,
      profile,
    } = opts;
    const { sessionId, sessionHome, workspacePath, envVars: contextEnvVars } = context;

    const effectiveProfile: SessionProfileBundle | undefined =
      profile === undefined && contextEnvVars === undefined
        ? undefined
        : { ...profile, envVars: profile?.envVars ?? contextEnvVars };

    const saferEnvVars = this.buildRuntimeEnv({
      context,
      env,
      originalToken,
      kilocodeModel,
      originalOrgId,
      createdOnPlatform,
      appendSystemPrompt,
      profile: effectiveProfile,
    });

    const session = await sandbox.createSession({
      name: sessionId,
      env: saferEnvVars,
      cwd: workspacePath,
    });

    const runtimeSkills = effectiveProfile?.runtimeSkills;
    if (runtimeSkills && runtimeSkills.length > 0) {
      await writeRuntimeSkills(sandbox, sessionHome, runtimeSkills);
    }

    return session;
  }

  async resolveWorkspaceTokens(
    env: PersistenceEnv,
    metadata: CloudAgentSessionState
  ): Promise<ResolvedWorkspaceTokens> {
    const github = githubRepository(metadata);
    const git = gitRepository(metadata);
    let githubToken: string | undefined;
    let githubInstallationId = github?.githubInstallationId;
    let githubAppType = github?.githubAppType;

    if (github) {
      if (githubInstallationId) {
        if (!env.GIT_TOKEN_SERVICE) {
          throw ExecutionError.invalidRequest('Git token service is not configured');
        }
        githubAppType = githubAppType ?? 'standard';
        githubToken = await env.GIT_TOKEN_SERVICE.getToken(githubInstallationId, githubAppType);
      } else {
        const result = await resolveGitHubTokenForRepo(env, {
          githubRepo: github.repo,
          userId: metadata.identity.userId,
          orgId: metadata.identity.orgId,
        });
        if (result.success) {
          githubToken = result.value.token;
          githubInstallationId = result.value.installationId;
          githubAppType = result.value.appType;
        } else {
          throw ExecutionError.invalidRequest(
            `GitHub token or active app installation required for this repository (${result.error.reason})`
          );
        }
      }
    }

    if (github && !githubToken) {
      throw ExecutionError.invalidRequest('GitHub authentication required for this repository');
    }

    let gitToken = repositoryPlatform(metadata) === 'gitlab' ? undefined : git?.token;
    let gitlabTokenManaged = git?.type === 'gitlab' ? git.gitlabTokenManaged : undefined;
    if (git?.url && repositoryPlatform(metadata) === 'gitlab') {
      if (!env.GIT_TOKEN_SERVICE) {
        throw ExecutionError.invalidRequest('Git token service is not configured');
      }
      const result = await resolveManagedGitLabToken(env, {
        userId: metadata.identity.userId,
        orgId: metadata.identity.orgId,
      });
      if (result.success) {
        gitToken = result.token;
        gitlabTokenManaged = true;
      } else if (result.reason === 'no_integration_found' || result.reason === 'invalid_org_id') {
        throw ExecutionError.invalidRequest(
          'No GitLab integration found. Please connect your GitLab account first.'
        );
      } else {
        throw ExecutionError.invalidRequest(
          `GitLab token lookup failed (${result.reason}). Please reconnect your GitLab account.`
        );
      }
    }

    if (git?.url && repositoryPlatform(metadata) === 'gitlab' && !gitToken) {
      throw ExecutionError.invalidRequest(
        'No GitLab integration found. Please connect your GitLab account first.'
      );
    }

    return { githubToken, githubInstallationId, githubAppType, gitToken, gitlabTokenManaged };
  }

  async buildWrapperSessionReadyAndPromptRequests(
    options: BuildWrapperSessionReadyAndPromptRequestsOptions
  ): Promise<
    {
      readyRequest: WrapperSessionReadyRequest;
      ready: WrapperWorkspaceReady;
      context: SessionContext;
    } & (
      | { type: 'prompt'; promptRequest: WrapperPromptRequest }
      | { type: 'command'; commandRequest: WrapperCommandRequest }
    )
  > {
    const { env, plan } = options;
    const { scope, turn, agent, finalization, workspace, wrapper } = plan;
    const { sessionId, userId, orgId } = scope;
    const { sandboxId, metadata } = workspace;

    if (!metadata.auth.kilocodeToken) {
      throw ExecutionError.invalidRequest('Missing kilocodeToken in session metadata');
    }
    if (!metadata.auth.kiloSessionId) {
      throw ExecutionError.invalidRequest('Missing kiloSessionId in session metadata');
    }

    const resolvedTokens = await this.resolveWorkspaceTokens(env, metadata);
    const workspacePath = getSessionWorkspacePath(orgId, userId, sessionId);
    const sessionHome = getSessionHomePath(sessionId);
    const branchName =
      metadata.workspace?.branchName ??
      determineBranchName(sessionId, metadata.repository?.upstreamBranch);
    const profile = readProfileBundle(metadata);
    const github = githubRepository(metadata);
    const git = gitRepository(metadata);
    const platform = repositoryPlatform(metadata);
    const devcontainerRequested =
      metadata.workspace?.devcontainerRequested === true || metadata.devcontainer !== undefined;
    const context = this.buildContext({
      sandboxId: sandboxId as SandboxId,
      orgId,
      userId,
      sessionId: sessionId as SessionId,
      workspacePath,
      sessionHome,
      githubRepo: github?.repo,
      githubToken: resolvedTokens.githubToken,
      gitUrl: git?.url,
      gitToken: resolvedTokens.gitToken,
      upstreamBranch: metadata.repository?.upstreamBranch,
      branchName,
      envVars: profile.envVars,
      botId: metadata.identity.botId,
      platform,
    });

    const materializedEnv = this.getSaferEnvVars({
      sessionHome,
      sessionId,
      workspacePath,
      env,
      originalToken: metadata.auth.kilocodeToken,
      kilocodeModel: agent.model,
      originalOrgId: orgId,
      githubToken: resolvedTokens.githubToken,
      githubRepo: github?.repo,
      createdOnPlatform: metadata.identity.createdOnPlatform,
      appendSystemPrompt: metadata.agent?.appendSystemPrompt,
      gitUrl: git?.url,
      gitToken: resolvedTokens.gitToken,
      platform,
      profile,
    });

    const ready = {
      workspacePath,
      sandboxId,
      sessionHome,
      branchName,
      kiloSessionId: metadata.auth.kiloSessionId,
      githubInstallationId: resolvedTokens.githubInstallationId,
      githubAppType: resolvedTokens.githubAppType,
      gitToken: resolvedTokens.gitToken,
      gitlabTokenManaged: resolvedTokens.gitlabTokenManaged,
      ...(metadata.devcontainer ? { devcontainer: metadata.devcontainer } : {}),
    } satisfies WrapperWorkspaceReady;

    const repo = this.buildWrapperRepoSource(env, metadata, resolvedTokens);
    const session = buildWrapperSessionBinding({
      workerUrl: env.WORKER_URL,
      kilocodeToken: metadata.auth.kilocodeToken,
      userId,
      sessionId,
      wrapper,
      upstreamBranch: metadata.repository?.upstreamBranch,
    });

    const attachments =
      turn.type === 'prompt'
        ? await buildSignedImagePromptAttachments({
            env,
            userId,
            sessionId,
            images: turn.images,
            createdOnPlatform: metadata.identity.createdOnPlatform,
          })
        : [];

    const promptAgent = normalizeAgentMode(agent.mode);
    const readyRequest: WrapperSessionReadyRequest = {
      agentSessionId: sessionId,
      userId,
      ...(orgId ? { orgId } : {}),
      sandboxId,
      kiloSessionId: metadata.auth.kiloSessionId,
      workspace: {
        workspacePath,
        sessionHome,
        branchName,
        ...(metadata.repository?.upstreamBranch
          ? { upstreamBranch: metadata.repository.upstreamBranch }
          : {}),
        strictBranch: Boolean(
          metadata.repository?.upstreamBranch && !metadata.lifecycle.preparedAt
        ),
        preferSnapshot: metadata.lifecycle.preparedAt !== undefined,
      },
      ...(repo ? { repo } : {}),
      ...(devcontainerRequested
        ? {
            devcontainer: {
              requested: true,
              ...(metadata.devcontainer ? { resolved: metadata.devcontainer } : {}),
            },
          }
        : {}),
      materialized: {
        env: materializedEnv,
        ...(profile.setupCommands?.length ? { setupCommands: profile.setupCommands } : {}),
        ...(profile.runtimeSkills?.length ? { runtimeSkills: profile.runtimeSkills } : {}),
      },
      session,
    };

    if (turn.type === 'command') {
      const commandRequest: WrapperCommandRequest = {
        command: turn.command,
        ...(turn.arguments.length > 0 ? { args: turn.arguments } : {}),
        messageId: turn.messageId,
        ...(finalization?.autoCommit !== undefined ? { autoCommit: finalization.autoCommit } : {}),
        ...(finalization?.condenseOnComplete !== undefined
          ? { condenseOnComplete: finalization.condenseOnComplete }
          : {}),
        session,
      };
      return { type: 'command', readyRequest, commandRequest, ready, context };
    }

    const promptRequest: WrapperPromptRequest = {
      message: {
        id: turn.messageId,
        prompt: turn.prompt,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      agent: {
        mode: promptAgent,
        model: { modelID: agent.model },
        ...(agent.variant ? { variant: agent.variant } : {}),
      },
      ...(finalization?.autoCommit !== undefined || finalization?.condenseOnComplete !== undefined
        ? {
            finalization: {
              ...(finalization.autoCommit !== undefined
                ? { autoCommit: finalization.autoCommit }
                : {}),
              ...(finalization.condenseOnComplete !== undefined
                ? { condenseOnComplete: finalization.condenseOnComplete }
                : {}),
            },
          }
        : {}),
      session,
    };

    return { type: 'prompt', readyRequest, promptRequest, ready, context };
  }

  private buildWrapperRepoSource(
    env: PersistenceEnv,
    metadata: CloudAgentSessionState,
    tokens: ResolvedWorkspaceTokens
  ): WrapperBootstrapRepoSource | undefined {
    const git = gitRepository(metadata);
    if (git) {
      return {
        kind: 'git',
        url: git.url,
        ...(tokens.gitToken ? { token: tokens.gitToken } : {}),
        ...(repositoryPlatform(metadata) ? { platform: repositoryPlatform(metadata) } : {}),
        ...(repositoryShallow(metadata) !== undefined
          ? { shallow: repositoryShallow(metadata) }
          : {}),
        refreshRemote: tokens.gitlabTokenManaged === true,
      };
    }

    const github = githubRepository(metadata);
    if (github) {
      const authorEnv = getGitAuthorEnv(env, tokens.githubAppType ?? github.githubAppType);
      const gitAuthor =
        authorEnv.GITHUB_APP_SLUG && authorEnv.GITHUB_APP_BOT_USER_ID
          ? {
              name: `${authorEnv.GITHUB_APP_SLUG}[bot]`,
              email: `${authorEnv.GITHUB_APP_BOT_USER_ID}+${authorEnv.GITHUB_APP_SLUG}[bot]@users.noreply.github.com`,
            }
          : undefined;
      return {
        kind: 'github',
        repo: github.repo,
        ...(tokens.githubToken ? { token: tokens.githubToken } : {}),
        ...(repositoryShallow(metadata) !== undefined
          ? { shallow: repositoryShallow(metadata) }
          : {}),
        ...(gitAuthor ? { gitAuthor } : {}),
        refreshRemote: tokens.githubInstallationId !== undefined,
      };
    }

    return undefined;
  }

  @WithLogTags('SessionService.prepareWorkspace')
  async prepareWorkspace(options: PrepareWorkspaceOptions): Promise<PreparedWorkspace> {
    const { sandbox, sandboxId, userId, sessionId, env, metadata, onProgress } = options;
    const orgId = options.orgId;

    if (!metadata.auth.kilocodeToken) {
      throw ExecutionError.invalidRequest('Missing kilocodeToken in session metadata');
    }
    if (!metadata.auth.kiloSessionId) {
      throw ExecutionError.invalidRequest('Missing kiloSessionId in session metadata');
    }

    const resolvedTokens = await this.resolveWorkspaceTokens(env, metadata);
    const github = githubRepository(metadata);
    const git = gitRepository(metadata);
    const platform = repositoryPlatform(metadata);

    logger.setTags({ sessionId, sandboxId, orgId, userId, botId: metadata.identity.botId });
    logger.info('Preparing workspace');

    const workspacePath = getSessionWorkspacePath(orgId, userId, sessionId);
    const sessionHome = getSessionHomePath(sessionId);
    const branchName =
      metadata.workspace?.branchName ??
      determineBranchName(sessionId, metadata.repository?.upstreamBranch);
    const context = this.buildContext({
      sandboxId,
      orgId,
      userId,
      sessionId,
      workspacePath,
      sessionHome,
      githubRepo: github?.repo,
      githubToken: resolvedTokens.githubToken,
      gitUrl: git?.url,
      gitToken: resolvedTokens.gitToken,
      upstreamBranch: metadata.repository?.upstreamBranch,
      branchName,
      envVars: readProfileBundle(metadata).envVars,
      botId: metadata.identity.botId,
      platform,
    });

    const ready = {
      workspacePath,
      sandboxId,
      sessionHome,
      branchName,
      kiloSessionId: metadata.auth.kiloSessionId,
      githubInstallationId: resolvedTokens.githubInstallationId,
      githubAppType: resolvedTokens.githubAppType,
      gitToken: resolvedTokens.gitToken,
      gitlabTokenManaged: resolvedTokens.gitlabTokenManaged,
      devcontainer: metadata.devcontainer,
    } satisfies PreparedWorkspace['ready'];
    const runtimeEnv = this.buildRuntimeEnv({
      context,
      env,
      originalToken: metadata.auth.kilocodeToken,
      kilocodeModel: options.kilocodeModel,
      originalOrgId: orgId,
      createdOnPlatform: metadata.identity.createdOnPlatform,
      appendSystemPrompt: metadata.agent?.appendSystemPrompt,
      profile: readProfileBundle(metadata),
    });

    // Warm fast path: probe for an existing .git before touching disk. The
    // probe uses the sandbox-wide executor because the per-session shell
    // hasn't been created yet — shells need a valid cwd, and that directory
    // may not exist on a cold sandbox. Once we know the workspace is warm,
    // mkdir-idempotent setup + createSession is still required to hand back a
    // usable ExecutionSession to the caller.
    if (await this.workspaceHasGit(sandbox, workspacePath)) {
      await setupWorkspace(sandbox, userId, orgId, sessionId);
      const session = await this.buildSessionForContext(
        sandbox,
        context,
        env,
        metadata,
        options.kilocodeModel,
        orgId
      );
      await this.refreshGitRemoteToken(session, context, metadata, resolvedTokens);

      const detectedDevcontainer =
        metadata.workspace?.devcontainerRequested && !metadata.devcontainer
          ? await detectDevContainer(session, workspacePath)
          : null;
      if (
        metadata.workspace?.devcontainerRequested &&
        !metadata.devcontainer &&
        !detectedDevcontainer
      ) {
        throw ExecutionError.invalidRequest(
          'Devcontainer runtime was requested, but the repository has no devcontainer config'
        );
      }
      const devcontainerPlan =
        metadata.devcontainer ??
        (detectedDevcontainer
          ? {
              workspacePath,
              wrapperPort: randomPort(),
              configPath: detectedDevcontainer.configPath,
            }
          : undefined);
      if (!devcontainerPlan) {
        return { context, session, runtimeEnv, ready };
      }

      const devcontainer = await bringUpDevContainer(session, {
        workspacePath: devcontainerPlan.workspacePath,
        sessionHome,
        agentSessionId: sessionId,
        wrapperPort: devcontainerPlan.wrapperPort,
        kiloCliVersion: KILO_CLI_VERSION,
        configPath: devcontainerPlan.configPath,
        onProgress: message => onProgress?.('devcontainer_setup', message),
      });
      ready.devcontainer = {
        workspacePath: devcontainerPlan.workspacePath,
        innerWorkspaceFolder: devcontainer.innerWorkspaceFolder,
        wrapperPort: devcontainerPlan.wrapperPort,
        configPath: devcontainerPlan.configPath,
      };
      return { context, session, runtimeEnv, devcontainer, ready };
    }

    onProgress?.('disk_check', 'Checking disk space…');
    await checkDiskAndCleanBeforeSetup(sandbox, orgId, userId, sessionId);

    onProgress?.('workspace_setup', 'Setting up workspace…');
    await setupWorkspace(sandbox, userId, orgId, sessionId);

    const session = await this.buildSessionForContext(
      sandbox,
      context,
      env,
      metadata,
      options.kilocodeModel,
      orgId
    );

    let devcontainer: DevContainerHandle | undefined;
    let dockerEnv: Record<string, string> | undefined;
    try {
      onProgress?.('cloning', 'Cloning repository…');
      await this.cloneRepository(env, session, workspacePath, metadata, resolvedTokens);

      onProgress?.('branch', 'Setting up branch…');
      await this.prepareBranch(session, workspacePath, branchName, metadata);

      await writeAuthFile(sandbox, sessionHome, metadata.auth.kilocodeToken);
      await writeGlobalRules(sandbox, sessionHome, sessionId);

      const detectedDevcontainer = metadata.workspace?.devcontainerRequested
        ? await detectDevContainer(session, workspacePath)
        : null;
      if (
        metadata.workspace?.devcontainerRequested &&
        !metadata.devcontainer &&
        !detectedDevcontainer
      ) {
        throw ExecutionError.invalidRequest(
          'Devcontainer runtime was requested, but the repository has no devcontainer config'
        );
      }
      const devcontainerPlan =
        metadata.devcontainer ??
        (detectedDevcontainer
          ? {
              workspacePath,
              wrapperPort: randomPort(),
              configPath: detectedDevcontainer.configPath,
            }
          : undefined);
      if (devcontainerPlan) {
        dockerEnv = dockerSocketEnv(await resolveDockerSocketPath(session));
        devcontainer = await bringUpDevContainer(session, {
          workspacePath: devcontainerPlan.workspacePath,
          sessionHome,
          agentSessionId: sessionId,
          wrapperPort: devcontainerPlan.wrapperPort,
          kiloCliVersion: KILO_CLI_VERSION,
          configPath: devcontainerPlan.configPath,
          onProgress: message => onProgress?.('devcontainer_setup', message),
        });
        ready.devcontainer = {
          workspacePath: devcontainerPlan.workspacePath,
          innerWorkspaceFolder: devcontainer.innerWorkspaceFolder,
          wrapperPort: devcontainerPlan.wrapperPort,
          configPath: devcontainerPlan.configPath,
        };
      }

      const preferSnapshot = metadata.lifecycle.preparedAt !== undefined;
      onProgress?.('kilo_session', preferSnapshot ? 'Restoring session…' : 'Importing session…');
      await this.restoreOrBootstrapKiloSession(
        sandbox,
        session,
        metadata.auth.kiloSessionId,
        workspacePath,
        preferSnapshot,
        {
          devcontainer,
          dockerEnv,
          env,
          kilocodeToken: metadata.auth.kilocodeToken,
          runtimeEnv,
          sessionHome,
        }
      );

      const setupCommands = readProfileBundle(metadata).setupCommands;
      if (setupCommands && setupCommands.length > 0) {
        onProgress?.('setup_commands', 'Running setup commands…');
        await runSetupCommands(session, context, setupCommands, false, {
          devcontainer,
          dockerEnv,
          runtimeEnv,
        });
      }

      onProgress?.('kilo_server', 'Starting Kilo…');
      return { context, session, runtimeEnv, devcontainer, ready };
    } catch (error) {
      if (devcontainer) {
        await devcontainer.teardown().catch(teardownError => {
          logger
            .withFields({
              sessionId,
              error: teardownError instanceof Error ? teardownError.message : String(teardownError),
            })
            .warn('Failed to tear down devcontainer after workspace preparation failure');
        });
      }
      logger
        .withFields({ sessionId, error: error instanceof Error ? error.message : String(error) })
        .warn('Workspace preparation step failed; removing workspace for clean retry');
      await cleanupWorkspace(session, workspacePath, sessionHome);
      throw error;
    }
  }

  private async buildSessionForContext(
    sandbox: SandboxInstance,
    context: SessionContext,
    env: PersistenceEnv,
    metadata: CloudAgentSessionState,
    kilocodeModel: string | undefined,
    orgId: string | undefined
  ): Promise<ExecutionSession> {
    if (!metadata.auth.kilocodeToken) {
      throw ExecutionError.invalidRequest('Missing kilocodeToken in session metadata');
    }
    return this.getOrCreateSession({
      sandbox,
      context,
      env,
      originalToken: metadata.auth.kilocodeToken,
      kilocodeModel,
      originalOrgId: orgId,
      createdOnPlatform: metadata.identity.createdOnPlatform,
      appendSystemPrompt: metadata.agent?.appendSystemPrompt,
      profile: readProfileBundle(metadata),
    });
  }

  private async workspaceHasGit(
    executor: SandboxInstance | ExecutionSession,
    workspacePath: string
  ): Promise<boolean> {
    const result = await timedExec(
      executor,
      `test -d '${workspacePath}/.git' && echo exists`,
      'session.prepareWorkspace.repoExists'
    );
    return result.stdout?.includes('exists') ?? false;
  }

  private async cloneRepository(
    env: PersistenceEnv,
    session: ExecutionSession,
    workspacePath: string,
    metadata: CloudAgentSessionState,
    tokens: ResolvedWorkspaceTokens
  ): Promise<void> {
    const cloneOptions = repositoryShallow(metadata) ? { shallow: true } : undefined;
    const git = gitRepository(metadata);
    if (git) {
      await cloneGitRepo(session, workspacePath, git.url, tokens.gitToken, undefined, {
        ...cloneOptions,
        platform: repositoryPlatform(metadata),
      });
      return;
    }
    const github = githubRepository(metadata);
    if (github) {
      await cloneGitHubRepo(
        session,
        workspacePath,
        github.repo,
        tokens.githubToken,
        getGitAuthorEnv(env, tokens.githubAppType ?? github.githubAppType),
        cloneOptions
      );
      return;
    }
    throw ExecutionError.invalidRequest('Session metadata is missing a repository source');
  }

  private async prepareBranch(
    session: ExecutionSession,
    workspacePath: string,
    branchName: string,
    metadata: CloudAgentSessionState
  ): Promise<void> {
    // First-run with an upstream branch: enforce strict remote existence —
    // if the upstream is missing, the session can't meaningfully start and
    // we want to fail loudly.
    //
    // Cold-evicted resume (preparedAt set, workspace gone): relax the strict
    // check. The upstream branch may have been merged or deleted since the
    // session was first prepared, but the recorded session branch is the
    // source of truth now, so `manageBranch(..., strict=false)` falls back to
    // creating the branch locally if needed.
    if (metadata.repository?.upstreamBranch && !metadata.lifecycle.preparedAt) {
      await manageBranch(session, workspacePath, branchName, true);
      return;
    }

    if (metadata.repository?.upstreamBranch || metadata.workspace?.branchName) {
      await manageBranch(session, workspacePath, branchName, false);
      return;
    }

    logger.withTags({ branchName }).info('Creating session branch');
    const result = await timedExec(
      session,
      `cd '${workspacePath}' && git checkout -b '${branchName}'`,
      'session.prepareWorkspace.createBranch'
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create session branch ${branchName}: ${result.stderr || result.stdout}`
      );
    }
  }

  /**
   * Refresh the embedded credentials in the workspace's git remote URL on the
   * warm fast path.
   *
   * GitHub App installation tokens expire after ~1h, and managed GitLab tokens
   * rotate on a similar cadence; the URL-embedded credentials from the original
   * clone go stale quickly. `GH_TOKEN` / `GITLAB_TOKEN` env vars don't rescue
   * `git` itself (they only affect the `gh` CLI / GitLab HTTP integrations), so
   * we rewrite `origin` with the freshly-resolved token whenever the token is
   * managed by us.
   */
  private async refreshGitRemoteToken(
    session: ExecutionSession,
    context: SessionContext,
    metadata: CloudAgentSessionState,
    tokens: ResolvedWorkspaceTokens
  ): Promise<void> {
    const github = githubRepository(metadata);
    if (github) {
      if (tokens.githubToken !== undefined && tokens.githubInstallationId !== undefined) {
        await updateGitRemoteToken(
          session,
          context.workspacePath,
          `https://github.com/${github.repo}.git`,
          tokens.githubToken
        );
      }
    }

    const git = gitRepository(metadata);
    if (git) {
      if (tokens.gitToken !== undefined && tokens.gitlabTokenManaged === true) {
        await updateGitRemoteToken(
          session,
          context.workspacePath,
          git.url,
          tokens.gitToken,
          repositoryPlatform(metadata)
        );
      }
    }
  }

  private async restoreOrBootstrapKiloSession(
    sandbox: SandboxInstance,
    session: ExecutionSession,
    kiloSessionId: string,
    workspacePath: string,
    preferSnapshot: boolean,
    options: RestoreRuntimeOptions
  ): Promise<void> {
    if (preferSnapshot) {
      const restored = await this.tryRestoreKiloSessionFromSnapshot(
        sandbox,
        session,
        kiloSessionId,
        workspacePath,
        options
      );
      if (restored) return;
    }

    await this.bootstrapKiloSession(sandbox, session, kiloSessionId, workspacePath, options);
  }

  private getDevContainerRestoreEnv(
    options: RestoreRuntimeOptions,
    restoreTokenFilePath: string | undefined
  ): Record<string, string | undefined> {
    const backendUrl = options.env.KILOCODE_BACKEND_BASE_URL
      ? backendUrlForSandbox(options.env.KILOCODE_BACKEND_BASE_URL)
      : undefined;
    return {
      KILOCODE_TOKEN_FILE: restoreTokenFilePath,
      KILO_SESSION_INGEST_URL: options.env.KILO_SESSION_INGEST_URL,
      ...buildKiloSessionXdgEnv(options.sessionHome),
      ...(backendUrl ? { KILOCODE_BACKEND_BASE_URL: backendUrl, KILO_API_URL: backendUrl } : {}),
    };
  }

  private async tryRestoreKiloSessionFromSnapshot(
    sandbox: SandboxInstance,
    session: ExecutionSession,
    kiloSessionId: string,
    workspacePath: string,
    options: RestoreRuntimeOptions
  ): Promise<boolean> {
    const restoreTokenFilePath = options.devcontainer
      ? await writeRestoreTokenFile(sandbox, session, options.sessionHome, options.kilocodeToken)
      : undefined;
    const restoreCommand = buildRestoreCommand({
      kiloSessionId,
      runtimeWorkspacePath: options.devcontainer?.innerWorkspaceFolder ?? workspacePath,
      runtimeEnv: options.devcontainer
        ? this.getDevContainerRestoreEnv(options, restoreTokenFilePath)
        : undefined,
      devContainer: options.devcontainer,
    });
    const restoreResult = await (async () => {
      try {
        return await timedExec(session, restoreCommand, 'session.prepareWorkspace.restore', {
          timeoutMs: GIT_COMMAND_TIMEOUT_MS,
          cwd: dirname(workspacePath),
          env: options.devcontainer ? options.dockerEnv : undefined,
        });
      } finally {
        if (restoreTokenFilePath) {
          await cleanupRestoreTokenFile(
            session,
            restoreTokenFilePath,
            options.devcontainer?.agentSessionId ?? ''
          );
        }
      }
    })();

    if (restoreResult.exitCode === 0) {
      logger.info('Session snapshot restore completed');
      return true;
    }

    const parsed = parseRestoreScriptOutput(restoreResult.stdout);
    if (parsed?.code === 404) {
      logger.info('Session snapshot not found; bootstrapping empty Kilo session');
      return false;
    }

    const detail = [
      `exit ${restoreResult.exitCode}`,
      parsed?.step && `step=${parsed.step}`,
      parsed?.error && `error=${parsed.error}`,
    ]
      .filter(Boolean)
      .join(', ');
    throw new SessionSnapshotRestoreError(
      `Session snapshot restore failed: ${detail}`,
      parsed?.code
    );
  }

  private async bootstrapKiloSession(
    sandbox: SandboxInstance,
    session: ExecutionSession,
    kiloSessionId: string,
    workspacePath: string,
    options: RestoreRuntimeOptions
  ): Promise<void> {
    const now = Date.now();
    const minimalSessionJson = JSON.stringify({
      info: {
        id: kiloSessionId,
        slug: '',
        projectID: '',
        directory: '',
        title: 'New session - ' + new Date(now).toISOString(),
        version: '2',
        time: { created: now, updated: now },
      },
      messages: [],
    });
    const importFilePath = options.devcontainer
      ? `${options.sessionHome}/tmp/kilo-empty-session-${kiloSessionId}.json`
      : `/tmp/kilo-empty-session-${kiloSessionId}.json`;
    await sandbox.writeFile(importFilePath, minimalSessionJson);
    const restoreTokenFilePath = options.devcontainer
      ? await writeRestoreTokenFile(sandbox, session, options.sessionHome, options.kilocodeToken)
      : undefined;
    const restoreCommand = buildRestoreCommand({
      kiloSessionId,
      importFilePath,
      runtimeWorkspacePath: options.devcontainer?.innerWorkspaceFolder ?? workspacePath,
      runtimeEnv: options.devcontainer
        ? this.getDevContainerRestoreEnv(options, restoreTokenFilePath)
        : undefined,
      devContainer: options.devcontainer,
    });
    const restoreResult = await (async () => {
      try {
        return await timedExec(session, restoreCommand, 'session.prepareWorkspace.bootstrap', {
          timeoutMs: GIT_COMMAND_TIMEOUT_MS,
          cwd: dirname(workspacePath),
          env: options.devcontainer ? options.dockerEnv : undefined,
        });
      } finally {
        if (restoreTokenFilePath) {
          await cleanupRestoreTokenFile(
            session,
            restoreTokenFilePath,
            options.devcontainer?.agentSessionId ?? ''
          );
        }
      }
    })();
    if (restoreResult.exitCode !== 0) {
      const parsed = parseRestoreScriptOutput(restoreResult.stdout);
      const detail = [
        `exit ${restoreResult.exitCode}`,
        parsed?.step && `step=${parsed.step}`,
        parsed?.error && `error=${parsed.error}`,
      ]
        .filter(Boolean)
        .join(', ');
      throw new SessionSnapshotRestoreError(`Session bootstrap failed: ${detail}`, parsed?.code);
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

export type PreparedSession = {
  context: SessionContext;
  session: Awaited<ReturnType<SessionService['getOrCreateSession']>>;
  runtimeEnv: Record<string, string>;
  devcontainer?: DevContainerHandle;
};

export type GetOrCreateSessionOptions = {
  sandbox: SandboxInstance;
  context: SessionContext;
  env: PersistenceEnv;
  originalToken: string;
  kilocodeModel?: string;
  originalOrgId?: string;
  createdOnPlatform?: string;
  appendSystemPrompt?: string;
  profile?: SessionProfileBundle;
};

export type BuildRuntimeEnvOptions = Omit<GetOrCreateSessionOptions, 'sandbox'>;

type RestoreRuntimeOptions = {
  devcontainer?: DevContainerHandle;
  dockerEnv?: Record<string, string>;
  env: PersistenceEnv;
  kilocodeToken: string;
  runtimeEnv: Record<string, string>;
  sessionHome: string;
};

type GetSaferEnvVarsOptions = {
  sessionHome: string;
  sessionId: string;
  workspacePath: string;
  env: PersistenceEnv;
  originalToken: string;
  kilocodeModel?: string;
  originalOrgId?: string;
  githubToken?: string;
  githubRepo?: string;
  createdOnPlatform?: string;
  appendSystemPrompt?: string;
  gitUrl?: string;
  gitToken?: string;
  platform?: 'github' | 'gitlab';
  profile?: SessionProfileBundle;
};

export type WorkspaceReadyMetadata = {
  workspacePath: string;
  sandboxId: string;
  sessionHome: string;
  branchName: string;
  kiloSessionId: string;
  githubInstallationId?: string;
  githubAppType?: 'standard' | 'lite';
  gitToken?: string;
  gitlabTokenManaged?: boolean;
  devcontainer?: CloudAgentSessionState['devcontainer'];
};

export type PreparedWorkspace = PreparedSession & {
  ready: WorkspaceReadyMetadata;
};

export type PrepareWorkspaceOptions = {
  sandbox: SandboxInstance;
  sandboxId: SessionContext['sandboxId'];
  orgId?: string;
  userId: string;
  sessionId: SessionId;
  kilocodeModel?: string;
  env: PersistenceEnv;
  metadata: CloudAgentSessionState;
  onProgress?: (step: string, message: string) => void;
};

export type BuildWrapperSessionReadyAndPromptRequestsOptions = {
  env: PersistenceEnv;
  plan: FencedWrapperDispatchRequest | FencedLegacyExecutionRequest;
};

function buildWrapperSessionBinding(options: {
  workerUrl?: string;
  kilocodeToken: string;
  userId: string;
  sessionId: string;
  wrapper: FencedWrapperDispatchRequest['wrapper'];
  upstreamBranch?: string;
}): WrapperSessionReadyRequest['session'] {
  const { workerUrl, kilocodeToken, userId, sessionId, wrapper, upstreamBranch } = options;
  if (!workerUrl) {
    throw ExecutionError.invalidRequest('WORKER_URL is required for wrapper bootstrap');
  }

  const wsUrl = new URL(workerUrl);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.pathname = `/sessions/${encodeURIComponent(userId)}/${sessionId}/ingest`;

  return {
    ingestUrl: wsUrl.toString(),
    workerAuthToken: kilocodeToken,
    wrapperRunId: wrapper.fence.wrapperRunId,
    wrapperGeneration: wrapper.fence.wrapperGeneration,
    wrapperConnectionId: wrapper.fence.wrapperConnectionId,
    ...(upstreamBranch ? { upstreamBranch } : {}),
  };
}
