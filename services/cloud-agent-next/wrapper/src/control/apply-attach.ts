import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  controlErrorCodes,
  sessionAttachPayloadSchema,
  type ControlErrorCode,
  type SessionAttachPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { PreparingEventDataV2, PreparingStep } from '../../../src/shared/protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import {
  diagnosticDetail,
  emitControlDiagnostic,
  type ControlDiagnosticRecord,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import {
  git,
  isTimeoutTermination,
  runProcess,
  withTimeoutAndAbort,
  type ExecResult,
  type ProcessOutputStream,
} from '../utils.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import {
  directoryForSession,
  forgetAttachedRoot,
  rememberAttachedRoot,
  rootForSession,
} from './session-directories';
import { authenticatedGitUrl } from './git-url';
import { createOutputRedactor, createSecretRedactor } from '../redact-output';
import { stripAnsi } from '../event-parser';
import type { ControlHandlerResult } from './sandbox-control-handlers';
import { restoreSession, seedSessionIngestRegistration } from '../restore-session.js';
import { configureWorkspaceGitAuthor } from '../session-bootstrap.js';
import { withKiloRequestDeadline } from './sandbox-control-runtime';
import { ControlTerminalRuntimeError, type ControlTerminalRuntime } from './terminal-runtime.js';
import {
  WorktreeKiloRuntimeError,
  type WorktreeKiloRuntime,
  type WorktreeKiloAttachment,
  type WorktreeKiloRuntimes,
} from './worktree-runtime.js';
import { runDirectoryOperation } from './worktree-operations';
import type { NativeRetirement } from './session-operation-cleanup.js';

const BOOTSTRAP_MARKER = 'kilo-bootstrap-complete';
const SETUP_COMMAND_INACTIVITY_TIMEOUT_MS = 4 * 60_000;
const SETUP_COMMAND_HARD_TIMEOUT_MS = 300_000;
const workspacePreparations = new Map<string, Promise<ControlHandlerResult | undefined>>();

export type AttachPreparingEmitter = (
  event: PreparingEventDataV2,
  options?: { retained?: true; nativeRuntimeId?: string }
) => void;

export type ApplyAttachDeps = {
  onDiagnostic?: ControlDiagnosticReporter;
  kiloRuntimes?: WorktreeKiloRuntimes;
  canRefreshCredentials?: () => boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onMutation?: () => void;
  onRuntime?: (runtime: WorktreeKiloRuntime) => void;
  onError?: (error: unknown) => void;
  onCleanupTarget?: (cleanup: (deadlineAt: number) => Promise<NativeRetirement>) => void;
  terminalRuntime?: Pick<ControlTerminalRuntime, 'rememberAttachedSession'>;
  mkdir?: (directory: string) => Promise<void>;
  hasGit?: (directory: string) => Promise<boolean>;
  hasBootstrapMarker?: (directory: string) => Promise<boolean>;
  writeBootstrapMarker?: (directory: string) => Promise<void>;
  runGit?: (args: string[], cwd?: string, signal?: AbortSignal) => Promise<ExecResult>;
  runSetup?: (
    command: string,
    directory: string,
    env: Record<string, string>,
    onOutput?: (stream: ProcessOutputStream, output: string) => void,
    signal?: AbortSignal
  ) => Promise<ExecResult>;
  restoreSession?: typeof restoreSession;
  sessionExists?: (
    kiloSessionId: string,
    directory: string,
    signal: AbortSignal
  ) => Promise<boolean>;
  emitPreparing?: AttachPreparingEmitter;
};

function ok(): ControlHandlerResult {
  return { ok: true, result: { attached: true } };
}

function fail(
  code: ControlErrorCode,
  message: string,
  retryable: boolean
): Extract<ControlHandlerResult, { ok: false }> {
  return { ok: false, error: { code, message, retryable } };
}

function diagnosticErrorCode(
  code: string
): NonNullable<ControlDiagnosticRecord['fields']['errorCode']> {
  for (const value of controlErrorCodes) {
    if (value === code) return value;
  }
  return 'other';
}

function attachFailureFields(
  result: Extract<ControlHandlerResult, { ok: false }>
): Pick<ControlDiagnosticRecord['fields'], 'errorCode' | 'retryable' | 'detail'> {
  const detail = diagnosticDetail(result.error.message);
  return {
    errorCode: diagnosticErrorCode(result.error.code),
    retryable: result.error.retryable,
    ...(detail ? { detail } : {}),
  };
}

async function defaultHasGit(directory: string): Promise<boolean> {
  try {
    await fs.access(path.join(directory, '.git', 'HEAD'));
    return true;
  } catch {
    return false;
  }
}

async function bootstrapMarkerPath(directory: string): Promise<string> {
  return (await defaultHasGit(directory))
    ? path.join(directory, '.git', BOOTSTRAP_MARKER)
    : `${path.resolve(directory)}.${BOOTSTRAP_MARKER}`;
}

async function defaultHasBootstrapMarker(directory: string): Promise<boolean> {
  try {
    await fs.access(await bootstrapMarkerPath(directory));
    return true;
  } catch {
    return false;
  }
}

async function defaultWriteBootstrapMarker(directory: string): Promise<void> {
  await fs.writeFile(await bootstrapMarkerPath(directory), 'ready\n');
}

async function defaultSessionExists(
  kiloClient: WrapperKiloClient,
  kiloSessionId: string,
  directory: string,
  signal: AbortSignal
): Promise<boolean> {
  const url = new URL(`/session/${encodeURIComponent(kiloSessionId)}`, kiloClient.serverUrl);
  url.searchParams.set('directory', directory);
  const response = await fetch(url, { signal });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error('Kilo session probe failed');
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null || !('id' in data) || data.id !== kiloSessionId) {
    throw new Error('Kilo session probe returned an invalid session');
  }
  return true;
}

async function defaultRunSetup(
  command: string,
  directory: string,
  env: Record<string, string>,
  onOutput?: (stream: ProcessOutputStream, output: string) => void,
  signal?: AbortSignal
): Promise<ExecResult> {
  return runProcess('sh', ['-c', command], {
    cwd: directory,
    env,
    inheritEnv: false,
    signal,
    inactivityTimeoutMs: SETUP_COMMAND_INACTIVITY_TIMEOUT_MS,
    hardTimeoutMs: SETUP_COMMAND_HARD_TIMEOUT_MS,
    ...(onOutput ? { onOutput } : {}),
  });
}

async function serializeWorkspacePreparation(
  directory: string,
  signal: AbortSignal,
  prepare: () => Promise<ControlHandlerResult | undefined>
): Promise<ControlHandlerResult | undefined> {
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(signal.reason);
  const run = () => {
    signal.removeEventListener('abort', onAbort);
    signal.throwIfAborted();
    return runDirectoryOperation(directory, prepare);
  };
  const previous = workspacePreparations.get(directory) ?? Promise.resolve();
  const current = previous.then(run, run).finally(() => {
    if (workspacePreparations.get(directory) === current) workspacePreparations.delete(directory);
  });
  workspacePreparations.set(directory, current);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([current, cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function createProgress(
  preparation: SessionAttachPayload['preparation'],
  emit: AttachPreparingEmitter | undefined
): {
  start(
    step: PreparingStep,
    stepId: string,
    message: string,
    extra?: {
      kind?: 'phase' | 'setup_command';
      label?: string;
      command?: string;
      commandIndex?: number;
      commandCount?: number;
    }
  ): void;
  progress(step: PreparingStep, stepId: string, detail: string): void;
  output(stepId: string, output: string): void;
  complete(step: PreparingStep, stepId: string): void;
  fail(step: PreparingStep, stepId: string, safeError: string): void;
} {
  let revision = Date.now();
  const send = (event: PreparingEventDataV2): void => {
    if (!preparation || !emit) return;
    emit(event);
  };
  const base = (step: PreparingStep, message: string) => {
    revision += 1;
    return {
      version: 2 as const,
      attemptId: preparation?.attemptId ?? '',
      triggerMessageId: preparation?.triggerMessageId ?? '',
      revision,
      timestamp: Date.now(),
      step,
      message,
    };
  };
  if (preparation && emit) {
    send({ ...base('workspace_setup', 'Preparing environment'), action: 'attempt_started' });
  }
  return {
    start(step, stepId, message, extra = {}) {
      send({
        ...base(step, message),
        action: 'step_started',
        stepId,
        kind: extra.kind === 'setup_command' ? 'setup_command' : 'phase',
        label: extra.label ?? step.replaceAll('_', ' '),
        ...(extra.command === undefined ? {} : { command: extra.command }),
        ...(extra.commandIndex === undefined ? {} : { commandIndex: extra.commandIndex }),
        ...(extra.commandCount === undefined ? {} : { commandCount: extra.commandCount }),
      });
    },
    progress(step, stepId, detail) {
      send({ ...base(step, detail), action: 'step_progress', stepId, detail });
    },
    output(stepId, output) {
      send({ ...base('setup_commands', output), action: 'step_output', stepId, output });
    },
    complete(step, stepId) {
      send({ ...base(step, 'Preparation complete'), action: 'step_completed', stepId });
    },
    fail(step, stepId, safeError) {
      send({ ...base(step, safeError), action: 'step_failed', stepId, safeError });
    },
  };
}

export async function applySessionAttach(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: ApplyAttachDeps
): Promise<ControlHandlerResult> {
  const parsed = sessionAttachPayloadSchema.safeParse(payload ?? {});
  if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);
  const attach = parsed.data;
  if (
    attach.env &&
    CONTROL_RUNTIME_RESERVED_ENV_VARS.some(key => Object.hasOwn(attach.env ?? {}, key))
  ) {
    return fail('protocol_error', 'Reserved control runtime environment variable', false);
  }
  const kilo = attach.kilo;
  if (!kilo) return fail('protocol_error', 'Kilo auth context is required', false);
  const directory = attach.directory ?? session.directory;
  if (directory !== session.directory)
    return fail('protocol_error', 'Attachment directory mismatch', false);
  try {
    return await runDirectoryOperation(directory, () =>
      executeSessionAttach(session, { ...attach, kilo }, deps, directory)
    );
  } catch {
    return fail('not_ready', 'Worktree is being deleted', false);
  }
}

async function executeSessionAttach(
  session: SessionRequestIdentity,
  attach: SessionAttachPayload & { kilo: NonNullable<SessionAttachPayload['kilo']> },
  deps: ApplyAttachDeps,
  directory: string
): Promise<ControlHandlerResult> {
  const startedAt = Date.now();
  let stage: ControlDiagnosticRecord['fields']['stage'] = 'attach_validation';
  let workspaceAction: ControlDiagnosticRecord['fields']['workspaceAction'];
  let sessionResolution: ControlDiagnosticRecord['fields']['sessionResolution'];
  let attachment: WorktreeKiloAttachment | undefined;
  const diagnostic = (
    phase: 'completed' | 'failed',
    extra: Partial<ControlDiagnosticRecord['fields']> = {}
  ): void =>
    emitControlDiagnostic(deps.onDiagnostic, 'control.request', {
      operation: 'session.attach',
      phase,
      stage,
      sessionId: session.sessionId,
      kiloSessionId: session.kiloSessionId,
      messageId: attach.preparation?.triggerMessageId,
      workspaceAction,
      sessionResolution,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ok: phase === 'completed',
      aborted: Boolean(deps.signal?.aborted || attachment?.signal.aborted),
      ...extra,
    });
  const existingDirectory = directoryForSession(session.kiloSessionId);
  if (existingDirectory && existingDirectory !== directory) {
    const result = fail('unauthorized', 'Session directory mismatch', false);
    diagnostic('failed', attachFailureFields(result));
    return result;
  }
  stage = 'runtime_attach';
  if (!deps.kiloRuntimes) {
    const result = fail('not_ready', 'Kilo is not ready', true);
    diagnostic('failed', attachFailureFields(result));
    return result;
  }
  const taskSignal = deps.signal ?? AbortSignal.timeout(SANDBOX_CONTROL_ATTACH_TIMEOUT_MS);
  try {
    taskSignal.throwIfAborted();
    attachment = deps.kiloRuntimes.attach(
      session,
      attach.kilo,
      attach.env,
      deps.canRefreshCredentials,
      deps.onMutation,
      deps.onCleanupTarget
    );
    const signal = AbortSignal.any([taskSignal, attachment.signal]);
    const runtime = await withTimeoutAndAbort(attachment.ready, {
      signal,
      timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
      timeoutMessage: 'Session attachment timed out',
      abortMessage: 'Session attachment cancelled',
    });
    signal.throwIfAborted();
    const { kiloClient, env } = runtime;
    deps.onRuntime?.(runtime);
    stage = 'workspace_prepare';
    const mkdir = deps.mkdir ?? (dir => fs.mkdir(dir, { recursive: true }).then(() => undefined));
    const hasGit = deps.hasGit ?? defaultHasGit;
    const hasBootstrapMarker = deps.hasBootstrapMarker ?? defaultHasBootstrapMarker;
    const writeBootstrapMarker = deps.writeBootstrapMarker ?? defaultWriteBootstrapMarker;
    const runGit =
      deps.runGit ?? ((args, cwd, signal) => git(args, { cwd, env, inheritEnv: false, signal }));
    const runSetup = deps.runSetup ?? defaultRunSetup;
    const progress = createProgress(attach.preparation, deps.emitPreparing);
    const redact = createSecretRedactor(process.env, attach.env ?? {}, {
      ...env,
      ...(attach.git?.token ? { GIT_TOKEN: attach.git.token } : {}),
    });

    const workspaceFailure = await serializeWorkspacePreparation(directory, signal, async () => {
      try {
        signal.throwIfAborted();
        const alreadyBootstrapped = await hasBootstrapMarker(directory);
        signal.throwIfAborted();
        const setupCommands = attach.setupCommands ?? [];
        const needsWorkspace = Boolean(attach.git) || setupCommands.length > 0;
        workspaceAction = alreadyBootstrapped
          ? 'reuse'
          : needsWorkspace
            ? 'bootstrap'
            : 'not_needed';
        if (!alreadyBootstrapped && needsWorkspace) {
          await mkdir(directory);
          signal.throwIfAborted();
          if (attach.git) {
            stage = 'git_setup';
            const needsClone = !(await hasGit(directory));
            signal.throwIfAborted();
            const cloneStepId = 'phase:cloning';
            progress.start('cloning', cloneStepId, 'Cloning repository…');
            if (needsClone) {
              progress.progress('cloning', cloneStepId, 'Cloning repository…');
              const cloneUrl = authenticatedGitUrl(
                attach.git.url,
                attach.git.token,
                attach.git.platform
              );
              const cloned = await runGit(['clone', cloneUrl, directory], undefined, signal);
              signal.throwIfAborted();
              if (cloned.exitCode !== 0) {
                progress.fail('cloning', cloneStepId, 'git clone failed');
                return fail('not_ready', 'git clone failed', true);
              }
            }
            const branch = attach.branch ?? `session/${attach.kilo.scopeId}`;
            let checkoutArgs = ['checkout', '-B', branch, `origin/${branch}`];
            if (!attach.branch) {
              const existingBranch = await runGit(
                ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
                directory,
                signal
              );
              signal.throwIfAborted();
              if (existingBranch.exitCode !== 0 && existingBranch.exitCode !== 1) {
                progress.fail('cloning', cloneStepId, 'git branch lookup failed');
                return fail('not_ready', 'git branch lookup failed', true);
              }
              checkoutArgs = ['checkout', branch];
              if (existingBranch.exitCode === 1) {
                const remoteBranch = await runGit(
                  ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
                  directory,
                  signal
                );
                signal.throwIfAborted();
                if (remoteBranch.exitCode !== 0 && remoteBranch.exitCode !== 1) {
                  progress.fail('cloning', cloneStepId, 'git branch lookup failed');
                  return fail('not_ready', 'git branch lookup failed', true);
                }
                checkoutArgs = [
                  'checkout',
                  '-b',
                  branch,
                  ...(remoteBranch.exitCode === 0 ? ['--track', `origin/${branch}`] : []),
                ];
              }
            }
            const checked = await runGit(checkoutArgs, directory, signal);
            signal.throwIfAborted();
            if (checked.exitCode !== 0) {
              progress.fail('cloning', cloneStepId, 'git checkout failed');
              return fail('not_ready', 'git checkout failed', true);
            }
            progress.complete('cloning', cloneStepId);
            await configureWorkspaceGitAuthor(
              directory,
              (args, options) => runGit(args, options?.cwd, options?.signal),
              undefined,
              signal
            );
            signal.throwIfAborted();
          }
          for (const [index, command] of setupCommands.entries()) {
            stage = 'setup_commands';
            signal.throwIfAborted();
            const stepId = `setup_command:${index}`;
            progress.start('setup_commands', stepId, `Running setup command ${index + 1}`, {
              kind: 'setup_command',
              label: `Setup command ${index + 1}`,
              command: redact(command),
              commandIndex: index,
              commandCount: setupCommands.length,
            });
            const output = createOutputRedactor(
              text => redact(stripAnsi(text)),
              text => {
                if (signal.aborted) return;
                const cleaned = text.trim();
                if (cleaned) progress.output(stepId, `${cleaned}\n`);
              }
            );
            const result = await runSetup(command, directory, env, output.onOutput, signal);
            signal.throwIfAborted();
            output.flush();
            if (result.exitCode !== 0) {
              const safeError = `Setup command ${index + 1} ${isTimeoutTermination(result) ? 'timed out' : 'failed'}`;
              progress.fail('setup_commands', stepId, safeError);
              return fail('not_ready', safeError, true);
            }
            progress.complete('setup_commands', stepId);
          }
          stage = 'bootstrap_marker';
          signal.throwIfAborted();
          await writeBootstrapMarker(directory);
          signal.throwIfAborted();
        }
        if (attach.kilo.containmentEnabled === false && attach.git?.token) {
          stage = 'git_credentials';
          const refreshed = await runGit(
            [
              'remote',
              'set-url',
              'origin',
              authenticatedGitUrl(attach.git.url, attach.git.token, attach.git.platform),
            ],
            directory,
            signal
          );
          signal.throwIfAborted();
          if (refreshed.exitCode !== 0) {
            return fail('not_ready', 'Worktree Git credential refresh failed', true);
          }
        }
      } catch {
        return fail(
          'not_ready',
          signal.aborted ? 'Session attachment cancelled' : 'workspace restore failed',
          true
        );
      }
    });
    if (workspaceFailure && !workspaceFailure.ok) {
      diagnostic('failed', attachFailureFields(workspaceFailure));
      return workspaceFailure;
    }

    stage = 'session_registration';
    const kiloSessionId = attach.snapshotIdentity ?? session.kiloSessionId;
    const restore = deps.restoreSession ?? restoreSession;
    const sessionExists =
      deps.sessionExists ??
      ((id, directory, signal) => defaultSessionExists(kiloClient, id, directory, signal));
    try {
      signal.throwIfAborted();
      progress.start('kilo_session', 'phase:kilo_session', 'Starting session…');
      await seedSessionIngestRegistration(session.kiloSessionId, env, signal);
      signal.throwIfAborted();
      stage = 'session_probe';
      const exists = await withKiloRequestDeadline(
        probeSignal => sessionExists(kiloSessionId, directory, probeSignal),
        signal
      );
      signal.throwIfAborted();
      sessionResolution = exists ? 'existing' : undefined;
      if (!exists) {
        stage = 'session_restore';
        progress.progress('kilo_session', 'phase:kilo_session', 'Restoring session…');
        const restored = await restore(kiloSessionId, directory, undefined, { env, signal });
        signal.throwIfAborted();
        if (!restored.ok) {
          if (restored.code !== 404 && !restored.emptySnapshot) {
            progress.fail('kilo_session', 'phase:kilo_session', restored.error);
            const result = fail('not_ready', 'kilo session is not ready', true);
            diagnostic('failed', attachFailureFields(result));
            return result;
          }
          stage = 'session_create';
          progress.progress('kilo_session', 'phase:kilo_session', 'Starting session…');
          await withKiloRequestDeadline(
            probeSignal => kiloClient.ensureSession(kiloSessionId, directory, probeSignal),
            signal
          );
          sessionResolution = 'created';
        } else {
          sessionResolution = 'restored';
        }
      }
      signal.throwIfAborted();
      progress.complete('kilo_session', 'phase:kilo_session');
    } catch {
      const message = signal.aborted ? 'Session attachment cancelled' : 'kilo session is not ready';
      progress.fail('kilo_session', 'phase:kilo_session', message);
      const result = fail('not_ready', message, true);
      diagnostic('failed', attachFailureFields(result));
      return result;
    }
    stage = 'attachment_commit';
    signal.throwIfAborted();
    const alreadyAttached = rootForSession(session.kiloSessionId) === session.kiloSessionId;
    rememberAttachedRoot(session.kiloSessionId, directory);
    try {
      if (kiloSessionId === session.kiloSessionId)
        deps.terminalRuntime?.rememberAttachedSession(session);
      attachment.commit();
    } catch (error) {
      if (!alreadyAttached) forgetAttachedRoot(session.kiloSessionId, directory);
      throw error;
    }
    diagnostic('completed');
    return ok();
  } catch (error) {
    deps.onError?.(error);
    const result =
      error instanceof WorktreeKiloRuntimeError || error instanceof ControlTerminalRuntimeError
        ? fail(error.code, error.message, error.retryable)
        : fail(
            'not_ready',
            taskSignal.aborted ? 'Session attachment cancelled' : 'Session attachment failed',
            true
          );
    diagnostic('failed', attachFailureFields(result));
    return result;
  } finally {
    attachment?.release();
  }
}
