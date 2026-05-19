import { dirname } from 'node:path';
import { logger } from '../logger.js';
import { SANDBOX_SLEEP_AFTER_SECONDS } from '../core/lease.js';
import { generateSandboxId, getSandboxNamespace } from '../sandbox-id.js';
import {
  resolveGitHubTokenForRepo,
  resolveManagedGitLabToken,
} from '../services/git-token-service-client.js';
import { getSandbox } from '@cloudflare/sandbox';
import {
  checkDiskAndCleanBeforeSetup,
  setupWorkspace,
  cloneGitHubRepo,
  cloneGitRepo,
  manageBranch,
} from '../workspace.js';
import {
  SessionService,
  determineBranchName,
  runSetupCommands,
  writeAuthFile,
  writeGlobalRules,
} from '../session-service.js';
import { WrapperClient } from '../kilo/wrapper-client.js';
import {
  buildRestoreCommand,
  bringUpDevContainer,
  detectDevContainer,
  KILO_CLI_VERSION,
  type DevContainerHandle,
} from '../kilo/devcontainer.js';
import { findWrapperContainerForSession } from '../kilo/wrapper-manager.js';
import { randomPort } from '../kilo/ports.js';
import { dockerSocketEnv, resolveDockerSocketPath } from '../kilo/sandbox-runtime.js';
import { shellQuote } from '../kilo/utils.js';
import type { PreparingStep } from '../shared/protocol.js';
import type { PreparationInput } from './schemas.js';
import { readProfileBundle } from '../session-profile.js';
import { withPreparationInfrastructureRecovery } from '../sandbox-recovery.js';
import type { Env as WorkerEnv, SandboxId, SessionId as AgentSessionId } from '../types.js';

type EmitProgress = (step: PreparingStep, message: string) => void;

/** Result returned by executePreparationSteps on success. */
export type PreparationStepsResult = {
  sandboxId: SandboxId;
  workspacePath: string;
  sessionHome: string;
  branchName: string;
  devcontainer?: {
    workspacePath: string;
    innerWorkspaceFolder: string;
    wrapperPort: number;
    configPath: string;
  };
  kiloSessionId: string;
  resolvedInstallationId: string | undefined;
  resolvedGithubAppType: 'standard' | 'lite' | undefined;
  resolvedGithubToken: string | undefined;
  resolvedGitToken: string | undefined;
  gitlabTokenManaged: boolean;
};

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
    const result = await resolveGitHubTokenForRepo(env, {
      githubRepo: input.githubRepo,
      userId: input.userId,
      orgId: input.orgId,
    });
    if (result.success) {
      resolvedGithubToken = result.value.token;
      resolvedInstallationId = result.value.installationId;
      resolvedGithubAppType = result.value.appType;
    } else {
      emitProgress(
        'failed',
        `GitHub token or active app installation required for this repository (${result.error.reason})`
      );
      return undefined;
    }
  }

  // Resolve managed GitLab token when no client token provided.
  // If the caller (e.g. session-prepare fast-path) already resolved the
  // managed token, trust it and skip the RPC — re-resolving 1-2s later
  // races with GitLab OAuth refresh-token rotation and can fail the
  // second call with token_refresh_failed.
  let resolvedGitToken = input.gitToken;
  let gitlabTokenManaged = input.gitlabTokenManaged ?? false;
  if (input.gitUrl && !input.gitToken && input.platform === 'gitlab') {
    const result = await resolveManagedGitLabToken(env, {
      userId: input.userId,
      orgId: input.orgId,
    });
    if (result.success) {
      resolvedGitToken = result.token;
      gitlabTokenManaged = true;
    }
  }
  if (input.gitUrl && input.platform === 'gitlab' && !resolvedGitToken) {
    emitProgress(
      'failed',
      'No GitLab integration found. Please connect your GitLab account first.'
    );
    return undefined;
  }

  // 2. Disk check
  emitProgress('disk_check', 'Checking disk space…');
  const sandboxId = await generateSandboxId(
    env.PER_SESSION_SANDBOX_ORG_IDS,
    input.orgId,
    input.userId,
    input.sessionId,
    input.botId,
    input.devcontainer
  );
  const sandbox = getSandbox(getSandboxNamespace(env, sandboxId), sandboxId, {
    sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS,
  });
  return withPreparationInfrastructureRecovery(
    {
      sandbox,
      sandboxId,
      sessionId: input.sessionId,
      phase: 'asyncPreparation',
    },
    async () => {
      await checkDiskAndCleanBeforeSetup(sandbox, input.orgId, input.userId, input.sessionId);

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
        gitToken: resolvedGitToken,
        platform: input.platform,
        upstreamBranch: input.upstreamBranch,
        botId: input.botId,
      });

      const sessionOptions = {
        sandbox,
        context,
        env,
        originalToken: input.authToken,
        kilocodeModel: input.model,
        originalOrgId: input.orgId,
        createdOnPlatform: input.createdOnPlatform,
        appendSystemPrompt: input.appendSystemPrompt,
        profile: readProfileBundle(input),
      };
      const runtimeEnv = sessionService.buildRuntimeEnv(sessionOptions);
      const session = await sessionService.getOrCreateSession({
        ...sessionOptions,
        sandbox,
      });

      const cloneOptions = input.shallow ? { shallow: true } : undefined;
      if (input.gitUrl) {
        await cloneGitRepo(
          session,
          workspacePath,
          input.gitUrl,
          resolvedGitToken,
          undefined,
          cloneOptions
        );
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

      // 5b. Dev container detection + bring-up.
      let devContainerHandle: DevContainerHandle | undefined;
      let wrapperPort: number | undefined;
      let detected: Awaited<ReturnType<typeof detectDevContainer>> = null;
      let dockerEnv: Record<string, string> | undefined;
      let preparationSucceeded = false;

      try {
        if (input.devcontainer === true) {
          // Pre-resolve docker socket env — devcontainer/docker CLIs need
          // DOCKER_HOST pointing at the sandbox dockerd socket. Resolving once
          // here avoids redundant execs in restore/import paths.
          dockerEnv = dockerSocketEnv(await resolveDockerSocketPath(session));

          detected = await detectDevContainer(session, workspacePath);
          if (detected) {
            emitProgress('devcontainer_setup', `Building dev container (${detected.configPath})…`);
            const existingContainer = await findWrapperContainerForSession(
              sandbox,
              input.sessionId
            );
            wrapperPort = existingContainer?.port ?? randomPort();
            try {
              devContainerHandle = await bringUpDevContainer(session, {
                workspacePath,
                sessionHome,
                agentSessionId: input.sessionId,
                wrapperPort,
                kiloCliVersion: KILO_CLI_VERSION,
                configPath: detected.configPath,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger
                .withFields({ sessionId: input.sessionId, configPath: detected.configPath })
                .error(`devcontainer up failed: ${message}`);
              emitProgress('failed', `Dev container build failed: ${message}`);
              return undefined;
            }
          }
        }

        // 6. Setup commands
        const inputSetupCommands = readProfileBundle(input).setupCommands;
        if (inputSetupCommands && inputSetupCommands.length > 0) {
          emitProgress('setup_commands', 'Running setup commands…');
          await runSetupCommands(session, context, inputSetupCommands, true, {
            devcontainer: devContainerHandle,
            dockerEnv,
            runtimeEnv,
          });
        }

        // 7. Write auth file and global rules (runtime skills are written by getOrCreateSession above)
        await writeAuthFile(sandbox, sessionHome, input.authToken);
        await writeGlobalRules(sandbox, sessionHome, input.sessionId);

        // 8. Import pre-generated session into CLI's SQLite so the wrapper picks it up.
        //
        // When a dev container is in play the import must run *inside* it: the
        // restore script does `Bun.spawn(['kilo', 'import', ...], { cwd })`, and the
        // cwd has to exist where the script runs. We also want the session record's
        // path to match what the runtime kilo (also inside) will see.
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
          const importFilePath = devContainerHandle
            ? `${sessionHome}/tmp/kilo-empty-session-${input.kiloSessionId}.json`
            : `/tmp/kilo-empty-session-${input.kiloSessionId}.json`;
          if (devContainerHandle) {
            await session.exec(`mkdir -p ${shellQuote(`${sessionHome}/tmp`)}`);
          }
          await sandbox.writeFile(importFilePath, minimalSessionJson);

          const restoreCommand = buildRestoreCommand({
            kiloSessionId: input.kiloSessionId,
            importFilePath,
            runtimeWorkspacePath: devContainerHandle?.innerWorkspaceFolder ?? workspacePath,
            devContainer: devContainerHandle,
            runtimeEnv,
          });
          const restoreResult = await session.exec(restoreCommand, {
            cwd: dirname(workspacePath),
            env: devContainerHandle ? dockerEnv : undefined,
          });
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
        const { sessionId: wrapperSessionId } = await WrapperClient.ensureWrapper(
          sandbox,
          session,
          {
            agentSessionId: input.sessionId,
            userId: input.userId,
            workspacePath,
            sessionId: input.kiloSessionId,
            runtimeEnv,
            devcontainer: devContainerHandle,
            fixedPort: wrapperPort,
          }
        );

        preparationSucceeded = true;
        return {
          sandboxId,
          workspacePath,
          sessionHome,
          branchName,
          devcontainer:
            devContainerHandle && wrapperPort !== undefined
              ? {
                  workspacePath: devContainerHandle.workspacePath,
                  innerWorkspaceFolder: devContainerHandle.innerWorkspaceFolder,
                  wrapperPort,
                  configPath: detected?.configPath ?? '',
                }
              : undefined,
          kiloSessionId: input.kiloSessionId ?? wrapperSessionId,
          resolvedInstallationId,
          resolvedGithubAppType,
          resolvedGithubToken: input.githubRepo ? resolvedGithubToken : undefined,
          resolvedGitToken,
          gitlabTokenManaged,
        };
      } finally {
        if (!preparationSucceeded && devContainerHandle) {
          await devContainerHandle.teardown().catch(teardownError => {
            logger
              .withFields({
                sessionId: input.sessionId,
                error:
                  teardownError instanceof Error ? teardownError.message : String(teardownError),
              })
              .warn('Failed to tear down devcontainer after async preparation failure');
          });
        }
      }
    }
  );
}
