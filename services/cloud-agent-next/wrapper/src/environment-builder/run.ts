import path from 'node:path';
import {
  CONTROL_RUNTIME_RESERVED_ENV_VARS,
  RESERVED_ENV_VAR_PREFIXES,
} from '../../../src/shared/runtime-environment.js';
import {
  CONTROL_PLANE_SETUP_EVENTS,
  type ControlPlaneSetupEvent,
} from '../../../src/shared/control-plane-protocol.js';
import type {
  EnvironmentBuildInput,
  EnvironmentBuildResult,
  EnvironmentBuildRunnerFailure,
  EnvironmentBuildRunnerStep,
} from '../../../src/shared/environment-build-protocol.js';
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
    if (value !== undefined && !runtimeOwned(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(input.vars)) {
    if (!runtimeOwned(name)) env[name] = value;
  }
  return {
    ...env,
    PWD: input.directory,
    HOME: input.home,
    XDG_DATA_HOME: path.join(input.home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(input.home, '.config'),
    XDG_CACHE_HOME: path.join(input.home, '.cache'),
    XDG_STATE_HOME: path.join(input.home, '.local', 'state'),
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

/** Run one build. Never throws: every outcome is a result the coordinator records. */
export async function runEnvironmentBuild(deps: BuildRunDeps): Promise<EnvironmentBuildResult> {
  const { input, reporter, repository, signal } = deps;
  const now = deps.now ?? Date.now;
  const directory = input.directory;
  const home = directoryHome(directory, deps.homeRoot);
  const env = builderSetupEnvironment({
    inherited: deps.inherited,
    vars: input.env,
    home,
    directory,
  });
  const redact = createSecretRedactor(
    {},
    [
      Object.fromEntries(input.secretKeys.map(key => [key, input.env[key]])),
      { GIT_TOKEN: input.git.token },
    ],
    input.secretKeys
  );
  const git = { ...input.git };
  const startedAt = now();

  let step: EnvironmentBuildRunnerStep = 'clone';
  try {
    reporter.setStep('clone');
    await repository.cloneRepository({
      git,
      directory,
      env,
      redact,
      signal,
      onProgress: detail => reporter.line(detail ?? 'Cloning the default branch'),
    });
    signal.throwIfAborted();
    const commit = await repository.headCommit(directory, env);
    const branchResult = await deps.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: directory,
      env,
      inheritEnv: false,
    });
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : '';
    if (!/^[0-9a-f]{40}$/.test(commit) || branch.length === 0 || branch === 'HEAD') {
      return failure('clone', 'clone_failed', 'default branch could not be resolved');
    }
    reporter.line(`Default branch ${branch} at ${commit}`);

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
    const cleanupFailure = await deps.cleanup({
      git: args => deps.runGit(args, { cwd: directory, env, inheritEnv: false }),
      directory,
      home,
      bareUrl: input.git.url,
      canaries: input.git.token === undefined ? [] : [input.git.token],
      logPath: deps.logPath,
    });
    if (cleanupFailure !== null) return failure('cleanup', 'cleanup_failed', cleanupFailure);
    // The builder's own allocation: a session restored from this snapshot sees a
    // foreign stamp and adopts the workspace instead of trusting it.
    await deps.writeStamp(directory, { allocationId: input.allocationId, commit });
    reporter.line('Workspace prepared; waiting for the snapshot');
    return { outcome: 'ready', commit, branch, setupDurationMs };
  } catch (error) {
    if (signal.aborted) return failure(step, 'canceled');
    if (step === 'clone') return failure('clone', 'clone_failed');
    if (step === 'setup') return failure('setup', setupFailureReason(error));
    return failure('cleanup', 'cleanup_failed', 'cleanup did not complete');
  }
}
