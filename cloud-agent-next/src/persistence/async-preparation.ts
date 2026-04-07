import { dirname } from 'node:path';
import { logger } from '../logger.js';
import { SANDBOX_SLEEP_AFTER_SECONDS } from '../core/lease.js';
import { generateSandboxId, getSandboxNamespace } from '../sandbox-id.js';
import { GitHubTokenService } from '../services/github-token-service.js';
import { InstallationLookupService } from '../services/installation-lookup-service.js';
import { getSandbox } from '@cloudflare/sandbox';
import {
  checkDiskAndCleanBeforeSetup,
  setupWorkspace,
  cloneGitHubRepo,
  cloneGitRepo,
  manageBranch,
  buildGitCloneUrl,
} from '../workspace.js';
import {
  SessionService,
  determineBranchName,
  runSetupCommands,
  writeAuthFile,
} from '../session-service.js';
import { WrapperClient, buildSupervisorPayload } from '../kilo/wrapper-client.js';
import type { PreparingStep } from '../shared/protocol.js';
import type { PreparationInput } from './schemas.js';
import type { Env as WorkerEnv, SandboxId, SessionId as AgentSessionId } from '../types.js';

type EmitProgress = (step: PreparingStep, message: string) => void;

/** Result returned by executePreparationSteps on success. */
export type PreparationStepsResult = {
  sandboxId: SandboxId;
  workspacePath: string;
  sessionHome: string;
  branchName: string;
  kiloSessionId: string;
  resolvedInstallationId: string | undefined;
  resolvedGithubAppType: 'standard' | 'lite' | undefined;
};

/**
 * Supervisor path: after token resolution and sandbox creation, delegate all
 * workspace setup to the supervisor wrapper via /job/init.
 *
 * Throws on failure so the caller gets a clear error rather than a silent `undefined`.
 */
async function executeSupervisorInit(
  sandboxId: SandboxId,
  sandbox: ReturnType<typeof getSandbox>,
  input: PreparationInput,
  resolvedGithubToken: string | undefined,
  emitProgress: EmitProgress,
  env: WorkerEnv,
  resolved: {
    resolvedInstallationId: string | undefined;
    resolvedGithubAppType: 'standard' | 'lite' | undefined;
  }
): Promise<PreparationStepsResult> {
  const sessionService = new SessionService();
  emitProgress('kilo_server', 'Initializing supervisor…');

  const session = await sandbox.createSession();
  const wrapperClient = WrapperClient.forSupervisor(session);

  await wrapperClient.waitForHealthy();

  const repoUrl = buildGitCloneUrl({
    githubRepo: input.githubRepo,
    githubToken: resolvedGithubToken,
    gitUrl: input.gitUrl,
    gitToken: input.gitToken,
    platform: input.platform,
  });

  const branchName = determineBranchName(input.sessionId, input.upstreamBranch);
  const workspacePath = `/home/${input.sessionId}/workspace/${input.githubRepo ?? 'repo'}`;
  const sessionHome = `/home/${input.sessionId}`;
  const effectiveEnv = sessionService.getEffectiveSessionEnv({
    userEnvVars: input.envVars,
    sessionHome,
    sessionId: input.sessionId,
    workspacePath,
    env,
    kilocodeToken: input.authToken,
    kilocodeModel: input.model,
    orgId: input.kilocodeOrganizationId ?? input.orgId,
    githubToken: resolvedGithubToken,
    githubRepo: input.githubRepo,
    encryptedSecrets: input.encryptedSecrets,
    createdOnPlatform: input.createdOnPlatform,
    appendSystemPrompt: input.appendSystemPrompt,
    gitUrl: input.gitUrl,
    gitToken: input.gitToken,
    platform: input.platform,
    mcpServers: input.mcpServers,
  });

  const workerUrl = env.WORKER_URL || 'http://localhost:8788';
  const ingestUrl = `${workerUrl}/sessions/${encodeURIComponent(input.userId)}/${input.sessionId}/ingest`;

  const basePayload = buildSupervisorPayload({
    sessionId: input.sessionId,
    userId: input.userId,
    repoUrl,
    branchName,
    githubRepo: input.githubRepo,
    setupCommands: input.setupCommands,
    kilocodeToken: input.authToken,
    kiloSessionId: input.kiloSessionId,
    env: effectiveEnv,
  });

  const initResponse = await wrapperClient.init({
    ...basePayload,
    ingest: {
      url: ingestUrl,
      token: input.authToken,
      workerAuthToken: input.authToken,
    },
  });

  if (initResponse.status !== 'ready' || !initResponse.kiloSessionId) {
    throw new Error(
      `Supervisor init failed at step ${initResponse.step ?? 'unknown'}: ${initResponse.message ?? 'unknown error'}`
    );
  }

  emitProgress('ready', 'Supervisor ready');

  return {
    sandboxId,
    workspacePath,
    sessionHome,
    branchName,
    kiloSessionId: initResponse.kiloSessionId,
    resolvedInstallationId: resolved.resolvedInstallationId,
    resolvedGithubAppType: resolved.resolvedGithubAppType,
  };
}

/**
 * Execute all expensive workspace preparation steps (token resolution, disk
 * check, clone, branch, setup commands, auth file, session import, wrapper start).
 *
 * This is a pure orchestration function with no Durable Object dependencies.
 * On early failure it emits a 'failed' progress event and returns undefined.
 */
export async function executePreparationSteps(
  input: PreparationInput,
  env: WorkerEnv,
  emitProgress: EmitProgress
): Promise<PreparationStepsResult | undefined> {
  const sessionService = new SessionService();

  // 1. Resolve GitHub installation + token
  let resolvedGithubToken = input.githubToken;
  let resolvedInstallationId: string | undefined;
  let resolvedGithubAppType: 'standard' | 'lite' | undefined;

  if (input.githubRepo && !input.githubToken) {
    const lookupService = new InstallationLookupService(env);
    if (lookupService.isConfigured()) {
      const result = await lookupService.findInstallationId({
        githubRepo: input.githubRepo,
        userId: input.userId,
        orgId: input.orgId,
      });
      if (result) {
        resolvedInstallationId = result.installationId;
        resolvedGithubAppType = result.githubAppType;
        const tokenService = new GitHubTokenService(env);
        resolvedGithubToken = await tokenService.getToken(
          resolvedInstallationId,
          resolvedGithubAppType ?? 'standard'
        );
      }
    }
    if (!resolvedGithubToken) {
      emitProgress(
        'failed',
        'GitHub token or active app installation required for this repository'
      );
      return undefined;
    }
  }

  // 2. Disk check
  emitProgress('disk_check', 'Checking disk space…');
  const sandboxId = await generateSandboxId(
    env.PER_SESSION_SANDBOX_ORG_IDS,
    input.orgId,
    input.userId,
    input.sessionId,
    input.botId
  );
  const sandbox = getSandbox(getSandboxNamespace(env, sandboxId), sandboxId, {
    sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS,
  });
  await checkDiskAndCleanBeforeSetup(sandbox, input.orgId, input.userId, input.sessionId);

  // Supervisor path: sandbox CMD handles workspace setup + kilo startup
  if (sandboxId.startsWith('ses-')) {
    try {
      return await executeSupervisorInit(
        sandboxId,
        sandbox,
        input,
        resolvedGithubToken,
        emitProgress,
        env,
        {
          resolvedInstallationId,
          resolvedGithubAppType,
        }
      );
    } catch (error) {
      emitProgress(
        'failed',
        `Supervisor init failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  // 3. Workspace setup
  emitProgress('workspace_setup', 'Setting up workspace…');
  const { workspacePath, sessionHome } = await setupWorkspace(
    sandbox,
    input.userId,
    input.orgId,
    input.sessionId
  );

  // 4. Clone repository
  emitProgress('cloning', 'Cloning repository…');
  const branchName = determineBranchName(input.sessionId, input.upstreamBranch);
  const sessionId = input.sessionId as AgentSessionId;
  const context = sessionService.buildContext({
    sandboxId,
    orgId: input.orgId,
    userId: input.userId,
    sessionId,
    workspacePath,
    sessionHome,
    githubRepo: input.githubRepo,
    githubToken: resolvedGithubToken,
    gitUrl: input.gitUrl,
    gitToken: input.gitToken,
    platform: input.platform,
    upstreamBranch: input.upstreamBranch,
    botId: input.botId,
  });

  const session = await sessionService.getOrCreateSession(
    sandbox,
    context,
    env,
    input.authToken,
    input.model,
    input.orgId,
    input.encryptedSecrets,
    input.createdOnPlatform,
    input.appendSystemPrompt,
    input.mcpServers
  );

  const cloneOptions = input.shallow ? { shallow: true } : undefined;
  if (input.gitUrl) {
    await cloneGitRepo(session, workspacePath, input.gitUrl, input.gitToken, undefined, {
      ...cloneOptions,
      platform: input.platform,
    });
  } else if (input.githubRepo) {
    await cloneGitHubRepo(
      session,
      workspacePath,
      input.githubRepo,
      resolvedGithubToken,
      {
        GITHUB_APP_SLUG: env.GITHUB_APP_SLUG,
        GITHUB_APP_BOT_USER_ID: env.GITHUB_APP_BOT_USER_ID,
      },
      cloneOptions
    );
  }

  // 5. Branch management
  emitProgress('branch', 'Setting up branch…');
  await manageBranch(session, workspacePath, branchName, !!input.upstreamBranch);

  // 6. Setup commands
  if (input.setupCommands && input.setupCommands.length > 0) {
    emitProgress('setup_commands', 'Running setup commands…');
    await runSetupCommands(session, context, input.setupCommands, true);
  }

  // 7. Write auth file
  await writeAuthFile(sandbox, sessionHome, input.authToken);

  // 8. Import pre-generated session into CLI's SQLite so the wrapper picks it up
  if (input.kiloSessionId) {
    emitProgress('kilo_session', 'Importing session…');
    const now = Date.now();
    const defaultTitle = 'New session - ' + new Date(now).toISOString();
    const minimalSessionJson = JSON.stringify({
      info: {
        id: input.kiloSessionId,
        slug: '',
        projectID: '',
        directory: '',
        title: defaultTitle,
        version: '2',
        time: { created: now, updated: now },
      },
      messages: [],
    });
    const importFilePath = `/tmp/kilo-empty-session-${input.kiloSessionId}.json`;
    await sandbox.writeFile(importFilePath, minimalSessionJson);
    const escapedFile = importFilePath.replaceAll("'", "'\\''");
    const escapedId = input.kiloSessionId.replaceAll("'", "'\\''");
    const escapedWorkspace = workspacePath.replaceAll("'", "'\\''");
    const restoreResult = await session.exec(
      `bun /usr/local/bin/kilo-restore-session.js --file '${escapedFile}' '${escapedId}' '${escapedWorkspace}'`,
      { cwd: dirname(workspacePath) }
    );
    if (restoreResult.exitCode !== 0) {
      const stdout = restoreResult.stdout?.trim() ?? '';
      logger
        .withFields({ exitCode: restoreResult.exitCode, stdout })
        .error('Session import failed');
      emitProgress('failed', `Session import failed (exit ${restoreResult.exitCode})`);
      return undefined;
    }
  }

  // 9. Start wrapper (with --session-id if pre-imported)
  emitProgress('kilo_server', 'Starting Kilo…');
  const { sessionId: wrapperSessionId } = await WrapperClient.ensureWrapper(sandbox, session, {
    agentSessionId: input.sessionId,
    userId: input.userId,
    workspacePath,
    sessionId: input.kiloSessionId,
  });

  return {
    sandboxId,
    workspacePath,
    sessionHome,
    branchName,
    kiloSessionId: input.kiloSessionId ?? wrapperSessionId,
    resolvedInstallationId,
    resolvedGithubAppType,
  };
}
