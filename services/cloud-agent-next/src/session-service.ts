import { dirname } from 'node:path';
import type {
  ExecutionSession,
  SandboxInstance,
  SandboxId,
  SessionContext,
  SessionId,
  GitAuthorConfig,
  ManagedGitHubFallbackReason,
} from './types.js';
import { generateSandboxId } from './sandbox-id.js';
import { normalizeKilocodeModel } from './persistence/model-utils.js';
import {
  resolveCloudAgentGitHubAuthForRepo,
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
  updateGitAuthor,
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
import { buildSignedPromptAttachments } from './execution/attachment-prompt-parts.js';
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
import {
  isSandboxFilesystemUnusableError,
  SandboxCapacityInspectionError,
} from './workspace-errors.js';

const SETUP_COMMAND_TIMEOUT_SECONDS = 300; // 5 minutes
const DEFAULT_DENIED_COMMAND_PATTERNS = ['rm -rf', 'sudo rm', 'mkfs', 'dd if='];

function gitLabTokenLookupFailureMessage(reason: string): string {
  switch (reason) {
    case 'no_integration_found':
    case 'invalid_org_id':
      return `No GitLab integration found (${reason}). Please connect your GitLab account first.`;
    case 'no_token':
    case 'token_refresh_failed':
    case 'token_expired_no_refresh':
      return `GitLab token lookup failed (${reason}). Please reconnect your GitLab account.`;
    case 'repository_url_required':
    case 'invalid_repository_url':
      return `GitLab token lookup failed (${reason}). Repository metadata is missing or invalid for this GitLab code-review session.`;
    case 'no_matching_integration':
      return `GitLab token lookup failed (${reason}). No authorized GitLab integration matches this repository. Connect the GitLab account or organization that has access to the repository.`;
    case 'ambiguous_integration':
      return `GitLab token lookup failed (${reason}). Multiple GitLab integrations or project tokens match this repository. Remove duplicate GitLab integrations or reconfigure the GitLab code-review integration.`;
    case 'project_lookup_failed':
      return `GitLab token lookup failed (${reason}). The connected GitLab integration cannot read this project. Grant repository access, then reconnect GitLab if required.`;
    case 'no_project_token':
      return `GitLab token lookup failed (${reason}). No GitLab project access token is configured for this repository. Reconfigure or reinstall the GitLab code-review bot for the project.`;
    case 'database_not_configured':
    case 'service_not_configured':
    case 'rpc_error':
      return `GitLab token lookup failed (${reason}). Git token service is unavailable; contact support.`;
    default:
      return `GitLab token lookup failed (${reason}). Please reconnect your GitLab account.`;
  }
}

// Keep in sync with: cloudflare-code-review-infra/src/code-review-orchestrator.ts
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
  'git fetch',
  'git pull',
  'gh pr diff',
  'gh pr view',
  'gh api repos/*/issues/*/comments --input*',
  'gh api repos/*/issues/comments/* -X PATCH*',
  'gh api repos/*/pulls/*/reviews --input*',
  'glab mr diff',
  'glab mr view',
  'glab api --method POST *merge_requests/*/notes*',
  'glab api --method PUT *merge_requests/*/notes/*',
  'glab api --method POST *merge_requests/*/discussions*',
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
  'git branch',
  'git clean',
  'git commit',
  'git config',
  'git mv',
  'git push',
  'git restore',
  'git rm',
  'git merge',
  'git rebase',
  'git cherry-pick',
  'git reset',
  'git checkout',
  'git switch',
  'git stash',
  'git tag',
  'git worktree',
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
  'glab auth',
  'glab mr approve',
  'glab mr close',
  'glab mr create',
  'glab mr delete',
  'glab mr merge',
  'glab mr reopen',
  'glab mr update',
  'glab repo',
  'glab issue',
  'glab pipeline',
  'glab release',
  'glab variable',
  'npm test',
  'pnpm test',
  'bun test',
  'yarn test',
  'pytest',
  'vitest',
];

export type CommandGuardPolicy = {
  policyName: string;
  allowed: string[];
  denied: string[];
};

export function getCommandGuardPolicy(createdOnPlatform?: string): CommandGuardPolicy | null {
  if (createdOnPlatform !== 'code-review') {
    return null;
  }

  return {
    policyName: 'code-review-read-only',
    allowed: CODE_REVIEW_ALLOWED_COMMANDS,
    denied: [...DEFAULT_DENIED_COMMAND_PATTERNS, ...CODE_REVIEW_DENIED_COMMAND_PATTERNS],
  };
}

export function buildCommandGuardBashPermissions(
  commandGuardPolicy: CommandGuardPolicy
): Record<string, string> {
  // Denies are inserted after allows so exact duplicates still fail closed;
  // more-specific denied sub-commands also override broader allowed commands in the CLI matcher.
  const bashPermissions: Record<string, string> = {};
  for (const cmd of commandGuardPolicy.allowed) {
    bashPermissions[cmd] = 'allow';
    bashPermissions[`${cmd} *`] = 'allow';
  }
  for (const cmd of commandGuardPolicy.denied) {
    bashPermissions[cmd] = 'deny';
    bashPermissions[`${cmd} *`] = 'deny';
  }
  return bashPermissions;
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
  githubSource?: 'user' | 'installation';
  githubGitAuthor?: GitAuthorConfig;
  githubCommitCoAuthor?: GitAuthorConfig;
  githubFallbackReason?: ManagedGitHubFallbackReason;
  gitToken?: string;
  gitlabTokenManaged?: boolean;
  glabIsOAuth2?: boolean;
};

function installationGitAuthorFromEnv(
  env: PersistenceEnv,
  githubAppType: 'standard' | 'lite'
): GitAuthorConfig | undefined {
  const slug =
    githubAppType === 'lite'
      ? env.GITHUB_LITE_APP_SLUG || env.GITHUB_APP_SLUG
      : env.GITHUB_APP_SLUG;
  const userId =
    githubAppType === 'lite'
      ? env.GITHUB_LITE_APP_BOT_USER_ID || env.GITHUB_APP_BOT_USER_ID
      : env.GITHUB_APP_BOT_USER_ID;
  if (!slug || !userId) return undefined;
  return {
    name: `${slug}[bot]`,
    email: `${userId}+${slug}[bot]@users.noreply.github.com`,
  };
}

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
    gitlabTokenManaged?: boolean;
    glabIsOAuth2?: boolean;
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
      gitlabTokenManaged: options.gitlabTokenManaged,
      glabIsOAuth2: options.glabIsOAuth2,
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
      glabIsOAuth2: context.glabIsOAuth2,
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
      glabIsOAuth2,
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
        [`/tmp/attachments/${sessionId}/**`]: 'allow',
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
      const bashPermissions = buildCommandGuardBashPermissions(commandGuardPolicy);

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

    const requiresResolvedGitLabTokenMode = glabIsOAuth2 === false;
    // A token-mode credential must be materialized consistently with its resolver instruction.
    if (
      gitToken &&
      effectivePlatform === 'gitlab' &&
      (!baseEnvVars.GITLAB_TOKEN || requiresResolvedGitLabTokenMode)
    ) {
      envVars.GITLAB_TOKEN = gitToken;
      if (
        glabIsOAuth2 !== undefined &&
        (baseEnvVars.GLAB_IS_OAUTH2 === undefined || requiresResolvedGitLabTokenMode)
      ) {
        envVars.GLAB_IS_OAUTH2 = glabIsOAuth2 ? 'true' : 'false';
      }
      if (!baseEnvVars.GITLAB_HOST || requiresResolvedGitLabTokenMode) {
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
          glabOAuthMode: envVars.GLAB_IS_OAUTH2 === 'true',
        })
        .info('[GITLAB] Configured GitLab CLI environment for GitLab session');
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
    let githubSource: 'user' | 'installation' | undefined;
    let githubGitAuthor: GitAuthorConfig | undefined;
    let githubCommitCoAuthor: GitAuthorConfig | undefined;
    let githubFallbackReason: ManagedGitHubFallbackReason | undefined;

    if (github) {
      const result = await resolveCloudAgentGitHubAuthForRepo(env, {
        githubRepo: github.repo,
        userId: metadata.identity.userId,
        orgId: metadata.identity.orgId,
        allowUserAuthorization:
          metadata.identity.createdOnPlatform === 'cloud-agent-web' ||
          metadata.identity.createdOnPlatform === 'slack',
      });
      if (result.success) {
        githubToken = result.value.githubToken;
        githubInstallationId = result.value.installationId;
        githubAppType = result.value.appType;
        githubSource = result.value.source;
        githubGitAuthor =
          result.value.gitAuthor ?? installationGitAuthorFromEnv(env, result.value.appType);
        githubCommitCoAuthor = result.value.commitCoAuthor;
        githubFallbackReason = result.value.fallbackReason;
      } else {
        throw ExecutionError.invalidRequest(
          `GitHub token or active app installation required for this repository (${result.error.reason})`
        );
      }
    }

    if (github && !githubToken) {
      throw ExecutionError.invalidRequest('GitHub authentication required for this repository');
    }

    let gitToken = repositoryPlatform(metadata) === 'gitlab' ? undefined : git?.token;
    let gitlabTokenManaged = git?.type === 'gitlab' ? git.gitlabTokenManaged : undefined;
    let glabIsOAuth2: boolean | undefined;
    if (git?.url && repositoryPlatform(metadata) === 'gitlab') {
      if (!env.GIT_TOKEN_SERVICE) {
        throw ExecutionError.invalidRequest('Git token service is not configured');
      }

      const result = await resolveManagedGitLabToken(env, {
        userId: metadata.identity.userId,
        orgId: metadata.identity.orgId,
        repositoryUrl: git.url,
        createdOnPlatform: metadata.identity.createdOnPlatform,
      });
      if (result.success) {
        gitToken = result.token;
        gitlabTokenManaged = true;
        glabIsOAuth2 = result.glabIsOAuth2;
      } else {
        throw ExecutionError.invalidRequest(gitLabTokenLookupFailureMessage(result.reason));
      }
    }

    if (git?.url && repositoryPlatform(metadata) === 'gitlab' && !gitToken) {
      throw ExecutionError.invalidRequest(
        'No GitLab integration found. Please connect your GitLab account first.'
      );
    }

    return {
      githubToken,
      githubInstallationId,
      githubAppType,
      githubSource,
      githubGitAuthor,
      githubCommitCoAuthor,
      githubFallbackReason,
      gitToken,
      gitlabTokenManaged,
      glabIsOAuth2,
    };
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
      gitlabTokenManaged: resolvedTokens.gitlabTokenManaged,
      glabIsOAuth2: resolvedTokens.glabIsOAuth2,
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
      glabIsOAuth2: resolvedTokens.glabIsOAuth2,
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

    const repo = this.buildWrapperRepoSource(metadata, resolvedTokens);
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
        ? await buildSignedPromptAttachments({
            env,
            userId,
            sessionId,
            attachments: turn.attachments,
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
        agent: {
          mode: promptAgent,
          model: { modelID: agent.model },
          ...(agent.variant ? { variant: agent.variant } : {}),
        },
        ...(finalization?.autoCommit !== undefined ? { autoCommit: finalization.autoCommit } : {}),
        ...(finalization?.condenseOnComplete !== undefined
          ? { condenseOnComplete: finalization.condenseOnComplete }
          : {}),
        ...(resolvedTokens.githubCommitCoAuthor
          ? { commitCoAuthor: resolvedTokens.githubCommitCoAuthor }
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
      ...(finalization?.autoCommit !== undefined ||
      finalization?.condenseOnComplete !== undefined ||
      resolvedTokens.githubCommitCoAuthor
        ? {
            finalization: {
              ...(finalization?.autoCommit !== undefined
                ? { autoCommit: finalization.autoCommit }
                : {}),
              ...(finalization?.condenseOnComplete !== undefined
                ? { condenseOnComplete: finalization.condenseOnComplete }
                : {}),
              ...(resolvedTokens.githubCommitCoAuthor
                ? { commitCoAuthor: resolvedTokens.githubCommitCoAuthor }
                : {}),
            },
          }
        : {}),
      session,
    };

    return { type: 'prompt', readyRequest, promptRequest, ready, context };
  }

  private buildWrapperRepoSource(
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
      return {
        kind: 'github',
        repo: github.repo,
        ...(tokens.githubToken ? { token: tokens.githubToken } : {}),
        ...(repositoryShallow(metadata) !== undefined
          ? { shallow: repositoryShallow(metadata) }
          : {}),
        ...(tokens.githubGitAuthor ? { gitAuthor: tokens.githubGitAuthor } : {}),
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
      gitlabTokenManaged: resolvedTokens.gitlabTokenManaged,
      glabIsOAuth2: resolvedTokens.glabIsOAuth2,
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
    await checkDiskAndCleanBeforeSetup(sandbox, orgId, userId, sessionId, {
      inspectContainers:
        sandboxId.startsWith('dind-') ||
        metadata.workspace?.devcontainerRequested === true ||
        metadata.devcontainer !== undefined,
    });

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
      await this.cloneRepository(session, workspacePath, metadata, resolvedTokens);

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
    try {
      const result = await timedExec(
        executor,
        `test -d '${workspacePath}/.git' && echo exists`,
        'session.prepareWorkspace.repoExists'
      );
      if (result.exitCode !== 0 && isSandboxFilesystemUnusableError(result.stderr)) {
        throw new SandboxCapacityInspectionError(
          'Workspace admission probe cannot run because the sandbox filesystem is unusable',
          new Error(result.stderr)
        );
      }
      return result.stdout?.includes('exists') ?? false;
    } catch (error) {
      if (isSandboxFilesystemUnusableError(error)) {
        throw new SandboxCapacityInspectionError(
          'Workspace admission probe cannot run because the sandbox filesystem is unusable',
          error
        );
      }
      throw error;
    }
  }

  private async cloneRepository(
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
        tokens.githubGitAuthor,
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
   * GitHub App installation tokens expire after ~1h, and server-resolved GitLab
   * credentials can rotate independently of a warm workspace. The URL-embedded
   * credentials from the original clone go stale quickly. `GH_TOKEN` /
   * `GITLAB_TOKEN` env vars don't rescue `git` itself (they only affect the
   * provider CLIs / GitLab HTTP integrations), so we rewrite `origin` whenever
   * the token is resolved by us.
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
        if (tokens.githubGitAuthor) {
          await updateGitAuthor(session, context.workspacePath, tokens.githubGitAuthor);
        }
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
  glabIsOAuth2?: boolean;
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
