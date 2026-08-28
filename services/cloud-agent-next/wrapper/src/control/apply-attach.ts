import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  sessionAttachPayloadSchema,
  type SessionAttachPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { PreparingEventDataV2, PreparingStep } from '../../../src/shared/protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import {
  git,
  isTimeoutTermination,
  logToFile,
  runProcess,
  type ExecResult,
  type ProcessOutputStream,
} from '../utils.js';
import { rememberAttachedRoot, rememberSessionDirectory } from './session-directories';
import { authenticatedGitUrl } from './git-url';
import { createOutputRedactor, createSecretRedactor } from '../redact-output';
import { stripAnsi } from '../event-parser';
import type { ControlHandlerResult } from './sandbox-control-handlers';
import type { WrapperKiloClient } from '../kilo-api.js';
import { restoreSession } from '../restore-session.js';
import { configureWorkspaceGitAuthor } from '../session-bootstrap.js';
import { withKiloRequestDeadline } from './sandbox-control-runtime';

const BOOTSTRAP_MARKER = 'kilo-bootstrap-complete';
const SETUP_COMMAND_INACTIVITY_TIMEOUT_MS = 4 * 60_000;
const SETUP_COMMAND_HARD_TIMEOUT_MS = 300_000;

export type AttachPreparingEmitter = (event: PreparingEventDataV2) => void;

export type ApplyAttachDeps = {
  kiloClient?: WrapperKiloClient;
  signal?: AbortSignal;
  mkdir?: (directory: string) => Promise<void>;
  hasGit?: (directory: string) => Promise<boolean>;
  hasBootstrapMarker?: (directory: string) => Promise<boolean>;
  writeBootstrapMarker?: (directory: string) => Promise<void>;
  runGit?: (args: string[], cwd?: string, signal?: AbortSignal) => Promise<ExecResult>;
  runSetup?: (
    command: string,
    directory: string,
    env: Record<string, string> | undefined,
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

function fail(code: string, message: string, retryable: boolean): ControlHandlerResult {
  return { ok: false, error: { code, message, retryable } };
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
  env: Record<string, string> | undefined,
  onOutput?: (stream: ProcessOutputStream, output: string) => void,
  signal?: AbortSignal
): Promise<ExecResult> {
  return runProcess('sh', ['-lc', command], {
    cwd: directory,
    signal,
    inactivityTimeoutMs: SETUP_COMMAND_INACTIVITY_TIMEOUT_MS,
    hardTimeoutMs: SETUP_COMMAND_HARD_TIMEOUT_MS,
    ...(env ? { env } : {}),
    ...(onOutput ? { onOutput } : {}),
  });
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
  if (!parsed.success) {
    return fail('protocol_error', 'Invalid payload', false);
  }
  const attach = parsed.data;
  const environment = attach.env;
  if (
    environment &&
    CONTROL_RUNTIME_RESERVED_ENV_VARS.some(key => Object.hasOwn(environment, key))
  ) {
    return fail('protocol_error', 'Reserved control runtime environment variable', false);
  }

  const kiloClient = deps.kiloClient;
  if (!kiloClient) return fail('not_ready', 'Kilo is not ready', true);
  const signal = deps.signal ?? AbortSignal.timeout(SANDBOX_CONTROL_ATTACH_TIMEOUT_MS);
  const directory = attach.directory ?? session.directory;
  const mkdir = deps.mkdir ?? (dir => fs.mkdir(dir, { recursive: true }).then(() => undefined));
  const hasGit = deps.hasGit ?? defaultHasGit;
  const hasBootstrapMarker = deps.hasBootstrapMarker ?? defaultHasBootstrapMarker;
  const writeBootstrapMarker = deps.writeBootstrapMarker ?? defaultWriteBootstrapMarker;
  const runGit = deps.runGit ?? ((args, cwd, signal) => git(args, { cwd, signal }));
  const runSetup = deps.runSetup ?? defaultRunSetup;
  if (signal.aborted) return fail('not_ready', 'Session attachment cancelled', true);
  const progress = createProgress(attach.preparation, deps.emitPreparing);
  const redact = createSecretRedactor({
    ...process.env,
    ...environment,
    ...(attach.git?.token ? { GIT_TOKEN: attach.git.token } : {}),
  });

  try {
    signal.throwIfAborted();
    const alreadyBootstrapped = await hasBootstrapMarker(directory);
    signal.throwIfAborted();
    const setupCommands = attach.setupCommands ?? [];
    const needsWorkspace = Boolean(attach.git) || setupCommands.length > 0;
    if (!alreadyBootstrapped && needsWorkspace) {
      await mkdir(directory);
      signal.throwIfAborted();
      if (attach.git) {
        const needsClone = !(await hasGit(directory));
        signal.throwIfAborted();
        if (needsClone || attach.branch) {
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
          if (attach.branch) {
            const checked = await runGit(
              ['checkout', '-B', attach.branch, `origin/${attach.branch}`],
              directory,
              signal
            );
            signal.throwIfAborted();
            if (checked.exitCode !== 0) {
              progress.fail('cloning', cloneStepId, 'git checkout failed');
              return fail('not_ready', 'git checkout failed', true);
            }
          }
          progress.complete('cloning', cloneStepId);
        }
        await configureWorkspaceGitAuthor(
          directory,
          (args, options) => runGit(args, options?.cwd, options?.signal),
          undefined,
          signal
        );
        signal.throwIfAborted();
      }
      for (const [index, command] of setupCommands.entries()) {
        signal.throwIfAborted();
        const stepId = `setup_command:${index}`;
        const safeCommand = redact(command);
        progress.start('setup_commands', stepId, `Running setup command ${index + 1}`, {
          kind: 'setup_command',
          label: `Setup command ${index + 1}`,
          command: safeCommand,
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
        const result = await runSetup(command, directory, attach.env, output.onOutput, signal);
        signal.throwIfAborted();
        output.flush();
        if (result.exitCode !== 0) {
          const safeError = `Setup command ${index + 1} ${isTimeoutTermination(result) ? 'timed out' : 'failed'}`;
          progress.fail('setup_commands', stepId, safeError);
          return fail('not_ready', safeError, true);
        }
        progress.complete('setup_commands', stepId);
      }
      signal.throwIfAborted();
      await writeBootstrapMarker(directory);
      signal.throwIfAborted();
    }
  } catch {
    return fail(
      'not_ready',
      signal.aborted ? 'Session attachment cancelled' : 'workspace restore failed',
      true
    );
  }

  const kiloSessionId = attach.snapshotIdentity ?? session.kiloSessionId;
  const restore = deps.restoreSession ?? restoreSession;
  const sessionExists =
    deps.sessionExists ??
    ((id, directory, signal) => defaultSessionExists(kiloClient, id, directory, signal));
  try {
    signal.throwIfAborted();
    progress.start('kilo_session', 'phase:kilo_session', 'Starting session…');
    const exists = await withKiloRequestDeadline(
      probeSignal => sessionExists(kiloSessionId, directory, probeSignal),
      signal
    );
    signal.throwIfAborted();
    if (!exists) {
      progress.progress('kilo_session', 'phase:kilo_session', 'Restoring session…');
      const restored = await restore(kiloSessionId, directory, undefined, { signal });
      signal.throwIfAborted();
      if (!restored.ok) {
        if (restored.code !== 404 && !restored.emptySnapshot) {
          progress.fail('kilo_session', 'phase:kilo_session', restored.error);
          return fail('not_ready', 'kilo session is not ready', true);
        }
        progress.progress('kilo_session', 'phase:kilo_session', 'Starting session…');
        await withKiloRequestDeadline(
          probeSignal => kiloClient.ensureSession(kiloSessionId, directory, probeSignal),
          signal
        );
      }
    }
    signal.throwIfAborted();
    progress.complete('kilo_session', 'phase:kilo_session');
  } catch {
    const message = signal.aborted ? 'Session attachment cancelled' : 'kilo session is not ready';
    progress.fail('kilo_session', 'phase:kilo_session', message);
    return fail('not_ready', message, true);
  }
  rememberSessionDirectory(session.kiloSessionId, directory);
  rememberAttachedRoot(session.kiloSessionId, directory);
  logToFile(`session.attach ready directory=${directory}`);
  return ok();
}
