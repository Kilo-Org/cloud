import path from 'node:path';
import {
  CONTROL_RUNTIME_RESERVED_ENV_VARS,
  MULTI_MEMBER_GIT_CREDENTIAL_ENV,
  RESERVED_ENV_VAR_PREFIXES,
  SYSTEM_GIT_CONFIG_ENV,
  isStrippedGitConfigEnvVar,
} from '../../../src/shared/runtime-environment.js';
import {
  CONTROL_PLANE_SETUP_EVENTS,
  type ControlPlaneSetupEvent,
} from '../../../src/shared/control-plane-protocol.js';
import type {
  EnvironmentBuildGit,
  EnvironmentBuildInput,
  EnvironmentBuildResult,
  EnvironmentBuildRunnerFailure,
  EnvironmentBuildRunnerStep,
} from '../../../src/shared/environment-build-protocol.js';
import {
  clearGitCredentialRecord,
  credentialFreeGitUrl,
  writeGitCredentialRecord,
  writeGitCredentialRecordSet,
} from '../control/git-credentials.js';
import { WrapperBootstrapError } from '../bootstrap-error.js';
import { createSecretRedactor } from '../redact-output.js';
import type { ExecResult, ProcessOptions } from '../utils.js';
import type { RepositoryPreparation } from '../control-plane/repository-preparation.js';
import type { WorkspaceStamp } from '../control-plane/workspace-stamp.js';
import { directoryHome } from '../control-plane/workspace-home.js';
import type { CleanupInput } from './cleanup.js';
import type { BuildReporter } from './reporter.js';

/**
 * One environment build inside its dedicated container (plan step 5 to 7 of
 * "Execution order"): clone the default branch and pin its commit, run the
 * environment's setup commands in the canonical workspace with the fixed home,
 * stop setup descendants, remove credentials, stamp the workspace with this
 * builder's allocation and report ready. The coordinator then captures.
 */

/**
 * The setup environment: the builder's inherited process environment without
 * the build credential and runtime-owned names, then the environment's
 * variables and secrets, then the fixed home and the XDG directories under it,
 * as a session's setup sees them, so caches land in the same paths.
 */
export function builderSetupEnvironment(input: {
  inherited: NodeJS.ProcessEnv;
  vars: Record<string, string>;
  home: string;
  directory: string;
  /** A V2 build can hold a different token for each repository of one host, so Git must send the request path. */
  isV2: boolean;
}): Record<string, string> {
  const reserved = new Set<string>(CONTROL_RUNTIME_RESERVED_ENV_VARS);
  const runtimeOwned = (name: string): boolean =>
    reserved.has(name) ||
    name === 'HOME' ||
    name === 'PWD' ||
    name.startsWith('ENVIRONMENT_BUILD_') ||
    RESERVED_ENV_VAR_PREFIXES.some(prefix => name.startsWith(prefix));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.inherited)) {
    if (value !== undefined && !runtimeOwned(name) && !isStrippedGitConfigEnvVar(name)) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(input.vars)) {
    if (!runtimeOwned(name) && !isStrippedGitConfigEnvVar(name)) env[name] = value;
  }
  return {
    ...env,
    PWD: input.directory,
    HOME: input.home,
    XDG_DATA_HOME: path.join(input.home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(input.home, '.config'),
    XDG_CACHE_HOME: path.join(input.home, '.cache'),
    XDG_STATE_HOME: path.join(input.home, '.local', 'state'),
    ...SYSTEM_GIT_CONFIG_ENV,
    ...(input.isV2 ? MULTI_MEMBER_GIT_CREDENTIAL_ENV : {}),
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** One readable line per setup event; command text is not repeated in the log. */
export function setupEventLine(event: ControlPlaneSetupEvent): string | null {
  const properties = event.properties as Record<string, unknown>;
  const command = typeof properties.command === 'number' ? properties.command : undefined;
  switch (event.type) {
    case CONTROL_PLANE_SETUP_EVENTS.started:
      return `▶ Setup command ${command} of ${String(properties.commandCount)}`;
    case CONTROL_PLANE_SETUP_EVENTS.output:
      return typeof properties.output === 'string' ? properties.output.replace(/\n$/, '') : null;
    case CONTROL_PLANE_SETUP_EVENTS.finished:
      return properties.exitCode === 0
        ? `✓ Setup command ${command} finished`
        : `✗ ${typeof properties.safeError === 'string' ? properties.safeError : `Setup command ${command} failed`} (exit ${String(properties.exitCode)})`;
    default:
      return null;
  }
}

export type BuildRunDeps = {
  input: EnvironmentBuildInput;
  reporter: Pick<BuildReporter, 'setStep' | 'line'>;
  repository: Pick<RepositoryPreparation, 'cloneRepository' | 'runSetupCommands' | 'headCommit'>;
  runGit: (args: string[], options?: ProcessOptions) => Promise<ExecResult>;
  stopProcesses: () => Promise<void>;
  cleanup: (input: CleanupInput) => Promise<string | null>;
  writeStamp: (directory: string, stamp: WorkspaceStamp) => Promise<void>;
  /** Aborted on a cancel reply or at the build deadline. */
  signal: AbortSignal;
  inherited: NodeJS.ProcessEnv;
  logPath: string | undefined;
  homeRoot?: string;
  now?: () => number;
};

function failure(
  step: EnvironmentBuildRunnerStep,
  reason: EnvironmentBuildRunnerFailure,
  detail?: string
): EnvironmentBuildResult {
  return { outcome: 'failed', step, reason, ...(detail === undefined ? {} : { detail }) };
}

function setupFailureReason(error: unknown): EnvironmentBuildRunnerFailure {
  return error instanceof WrapperBootstrapError && error.subtype === 'setup_command_timeout'
    ? 'setup_timeout'
    : 'setup_failed';
}

/** One repository a build checks out: its clone source and its target directory. */
type BuildTarget = {
  directory: string;
  url: string;
  token: string | undefined;
  platform: EnvironmentBuildGit['platform'];
  /** Present only for a V2 build. */
  repoFullName: string | undefined;
};

/** Run one build. Never throws: every outcome is a result the coordinator records. */
export async function runEnvironmentBuild(deps: BuildRunDeps): Promise<EnvironmentBuildResult> {
  const { input, reporter, repository, signal } = deps;
  const now = deps.now ?? Date.now;
  const directory = input.directory;
  const home = directoryHome(directory, deps.homeRoot);
  // A V1 build serves the `git` shape at the isolated directory. A V2 build
  // serves `members`, each with the directory a session gives it, and `directory`
  // is the session cwd. Every repository is cloned at its default branch and
  // stamped, and setup runs once at the cwd, as in a session.
  const membersInput = input.members;
  const gitInput = input.git;
  const isV2 = membersInput !== undefined;
  const targets: BuildTarget[] = membersInput
    ? membersInput.map(member => ({
        directory: member.directory,
        url: member.url,
        token: member.token,
        platform: member.platform,
        repoFullName: member.repoFullName,
      }))
    : gitInput
      ? [
          {
            directory,
            url: gitInput.url,
            token: gitInput.token,
            platform: gitInput.platform,
            repoFullName: undefined,
          },
        ]
      : [];
  if (targets.length === 0) return failure('clone', 'clone_failed', 'no repository to clone');
  const issuedTokens = targets.flatMap(target =>
    target.token === undefined ? [] : [target.token]
  );
  const env = builderSetupEnvironment({
    inherited: deps.inherited,
    vars: input.env,
    home,
    directory,
    isV2,
  });
  const redact = createSecretRedactor(
    {},
    [
      Object.fromEntries(input.secretKeys.map(key => [key, input.env[key]])),
      ...targets.map((target, index) => ({ [`GIT_TOKEN_${index}`]: target.token })),
    ],
    input.secretKeys
  );
  const startedAt = now();

  let step: EnvironmentBuildRunnerStep = 'clone';
  try {
    reporter.setStep('clone');
    if (isV2) {
      await writeGitCredentialRecordSet({
        home,
        entries: targets.flatMap(target =>
          target.token === undefined || target.repoFullName === undefined
            ? []
            : [
                {
                  url: credentialFreeGitUrl(target.url),
                  token: target.token,
                  platform: target.platform,
                },
              ]
        ),
      });
    } else {
      const first = targets[0];
      if (first === undefined) return failure('clone', 'clone_failed', 'no repository to clone');
      await writeGitCredentialRecord({
        home,
        url: credentialFreeGitUrl(first.url),
        token: first.token,
        platform: first.platform,
      });
    }
    const pinned: { directory: string; commit: string; branch: string }[] = [];
    const multiPins: { repoFullName: string; commit: string; branch: string }[] = [];
    for (const target of targets) {
      await repository.cloneRepository({
        git: { url: target.url, token: target.token, platform: target.platform },
        directory: target.directory,
        env,
        redact,
        signal,
        onProgress: detail =>
          reporter.line(detail ?? `Cloning ${target.repoFullName ?? 'the default branch'}`),
      });
      signal.throwIfAborted();
      const commit = await repository.headCommit(target.directory, env);
      const branchResult = await deps.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: target.directory,
        env,
        inheritEnv: false,
      });
      const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : '';
      if (!/^[0-9a-f]{40}$/.test(commit) || branch.length === 0 || branch === 'HEAD') {
        return failure('clone', 'clone_failed', 'default branch could not be resolved');
      }
      pinned.push({ directory: target.directory, commit, branch });
      if (target.repoFullName !== undefined) {
        multiPins.push({ repoFullName: target.repoFullName, commit, branch });
      }
    }
    const firstPin = pinned[0];
    if (firstPin === undefined) return failure('clone', 'clone_failed', 'no repository to clone');
    if (!isV2) reporter.line(`Default branch ${firstPin.branch} at ${firstPin.commit}`);

    step = 'setup';
    reporter.setStep('setup');
    if (input.commands.length === 0) reporter.line('No setup commands');
    await repository.runSetupCommands({
      commands: input.commands,
      directory,
      env,
      redact,
      signal,
      onEvent: event => {
        const line = setupEventLine(event);
        if (line !== null) reporter.line(line);
      },
      logContext: `environmentId=${input.environmentId} buildId=${input.buildId}`,
    });
    const setupDurationMs = Math.max(0, now() - startedAt);

    step = 'cleanup';
    reporter.setStep('cleanup');
    signal.throwIfAborted();
    await deps.stopProcesses();
    for (const target of targets) {
      const cleanupFailure = await deps.cleanup({
        git: args => deps.runGit(args, { cwd: target.directory, env, inheritEnv: false }),
        directory: target.directory,
        home,
        bareUrl: credentialFreeGitUrl(target.url),
        canaries: issuedTokens,
        logPath: deps.logPath,
      });
      if (cleanupFailure !== null) return failure('cleanup', 'cleanup_failed', cleanupFailure);
    }
    // One stamp per repository, with its own commit. The cwd of several
    // repositories is not a git root and is never stamped.
    for (const entry of pinned) {
      await deps.writeStamp(entry.directory, {
        allocationId: input.allocationId,
        commit: entry.commit,
      });
    }
    reporter.line('Workspace prepared; waiting for the snapshot');
    if (isV2) {
      return { outcome: 'ready', members: { members: multiPins }, setupDurationMs };
    }
    return {
      outcome: 'ready',
      commit: firstPin.commit,
      branch: firstPin.branch,
      setupDurationMs,
    };
  } catch (error) {
    if (signal.aborted) return failure(step, 'canceled');
    if (step === 'clone') return failure('clone', 'clone_failed');
    if (step === 'setup') return failure('setup', setupFailureReason(error));
    return failure('cleanup', 'cleanup_failed', 'cleanup did not complete');
  } finally {
    await clearGitCredentialRecord(home).catch(() => false);
  }
}
