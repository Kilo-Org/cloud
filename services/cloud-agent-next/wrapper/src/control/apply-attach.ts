import fs from 'node:fs/promises';
import path from 'node:path';
import {
  sessionAttachPayloadSchema,
  type SessionAttachPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { PreparingEventDataV2, PreparingStep } from '../../../src/shared/protocol.js';
import { git, isTimeoutTermination, logToFile, runProcess, type ExecResult } from '../utils.js';
import { rememberAttachedRoot, rememberSessionDirectory } from './session-directories';
import { authenticatedGitUrl } from './git-url';
import { redactSecrets } from '../redact-output';
import type { ControlHandlerResult } from './sandbox-control-handlers';
import type { WrapperKiloClient } from '../kilo-api.js';
import { restoreSession, type RestoreResult } from '../restore-session.js';

const BOOTSTRAP_MARKER = '.kilo-bootstrap-complete';
const SETUP_COMMAND_INACTIVITY_TIMEOUT_MS = 4 * 60_000;
const SETUP_COMMAND_HARD_TIMEOUT_MS = 300_000;

export type AttachPreparingEmitter = (event: PreparingEventDataV2) => void;

export type ApplyAttachDeps = {
  kiloClient?: WrapperKiloClient;
  mkdir?: (directory: string) => Promise<void>;
  hasGit?: (directory: string) => Promise<boolean>;
  hasBootstrapMarker?: (directory: string) => Promise<boolean>;
  writeBootstrapMarker?: (directory: string) => Promise<void>;
  runGit?: (args: string[], cwd?: string) => Promise<ExecResult>;
  runSetup?: (
    command: string,
    directory: string,
    env: Record<string, string> | undefined,
    onOutput?: (output: string) => void
  ) => Promise<ExecResult>;
  restoreSession?: (kiloSessionId: string, directory: string) => Promise<RestoreResult>;
  sessionExists?: (kiloSessionId: string) => Promise<boolean>;
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

async function defaultHasBootstrapMarker(directory: string): Promise<boolean> {
  try {
    await fs.access(path.join(directory, BOOTSTRAP_MARKER));
    return true;
  } catch {
    return false;
  }
}

async function defaultWriteBootstrapMarker(directory: string): Promise<void> {
  await fs.writeFile(path.join(directory, BOOTSTRAP_MARKER), 'ready\n');
}

async function defaultSessionExists(
  kiloClient: WrapperKiloClient,
  kiloSessionId: string
): Promise<boolean> {
  try {
    await kiloClient.getSession(kiloSessionId);
    return true;
  } catch {
    return false;
  }
}

async function defaultRunSetup(
  command: string,
  directory: string,
  env: Record<string, string> | undefined,
  onOutput?: (output: string) => void
): Promise<ExecResult> {
  return runProcess('sh', ['-lc', command], {
    cwd: directory,
    inactivityTimeoutMs: SETUP_COMMAND_INACTIVITY_TIMEOUT_MS,
    hardTimeoutMs: SETUP_COMMAND_HARD_TIMEOUT_MS,
    ...(env ? { env } : {}),
    ...(onOutput ? { onOutput: (_stream, output) => onOutput(output) } : {}),
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
  const directory = attach.directory ?? session.directory;
  const mkdir = deps.mkdir ?? (dir => fs.mkdir(dir, { recursive: true }).then(() => undefined));
  const hasGit = deps.hasGit ?? defaultHasGit;
  const hasBootstrapMarker = deps.hasBootstrapMarker ?? defaultHasBootstrapMarker;
  const writeBootstrapMarker = deps.writeBootstrapMarker ?? defaultWriteBootstrapMarker;
  const runGit = deps.runGit ?? ((args, cwd) => git(args, cwd ? { cwd } : undefined));
  const runSetup = deps.runSetup ?? defaultRunSetup;
  const progress = createProgress(attach.preparation, deps.emitPreparing);

  const alreadyBootstrapped = await hasBootstrapMarker(directory);
  const setupCommands = attach.setupCommands ?? [];
  const needsWorkspace = Boolean(attach.git) || setupCommands.length > 0;
  if (!alreadyBootstrapped && needsWorkspace) {
    try {
      await mkdir(directory);
      if (attach.git) {
        const needsClone = !(await hasGit(directory));
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
            const cloned = await runGit(['clone', cloneUrl, directory]);
            if (cloned.exitCode !== 0) {
              progress.fail('cloning', cloneStepId, 'git clone failed');
              return fail('not_ready', 'git clone failed', true);
            }
          }
          if (attach.branch) {
            const checked = await runGit(['checkout', '-B', attach.branch], directory);
            if (checked.exitCode !== 0) {
              progress.fail('cloning', cloneStepId, 'git checkout failed');
              return fail('not_ready', 'git checkout failed', true);
            }
          }
          progress.complete('cloning', cloneStepId);
        }
      }
      if (setupCommands.length > 0) {
        for (const [index, command] of setupCommands.entries()) {
          const stepId = `setup_command:${index}`;
          const safeCommand = redactSecrets(command);
          progress.start('setup_commands', stepId, `Running setup command ${index + 1}`, {
            kind: 'setup_command',
            label: `Setup command ${index + 1}`,
            command: safeCommand,
            commandIndex: index,
            commandCount: setupCommands.length,
          });
          const result = await runSetup(command, directory, attach.env, output => {
            const cleaned = redactSecrets(output).trim();
            if (cleaned) progress.output(stepId, `${cleaned}\n`);
          });
          if (result.exitCode !== 0) {
            const safeError = `Setup command ${index + 1} ${isTimeoutTermination(result) ? 'timed out' : 'failed'}`;
            progress.fail('setup_commands', stepId, safeError);
            return fail('not_ready', safeError, true);
          }
          progress.complete('setup_commands', stepId);
        }
      }
      await writeBootstrapMarker(directory);
    } catch {
      return fail('not_ready', 'workspace restore failed', true);
    }
  }

  const kiloClient = deps.kiloClient;
  if (!kiloClient) return fail('not_ready', 'Kilo is not ready', true);
  const kiloSessionId = attach.snapshotIdentity ?? session.kiloSessionId;
  const restore = deps.restoreSession ?? restoreSession;
  const sessionExists = deps.sessionExists ?? (id => defaultSessionExists(kiloClient, id));
  try {
    progress.start('kilo_session', 'phase:kilo_session', 'Starting session…');
    const exists = await sessionExists(kiloSessionId);
    if (!exists) {
      progress.progress('kilo_session', 'phase:kilo_session', 'Restoring session…');
      const restored = await restore(kiloSessionId, directory);
      if (restored.ok) {
        progress.complete('kilo_session', 'phase:kilo_session');
        rememberSessionDirectory(session.kiloSessionId, directory);
        rememberAttachedRoot(session.kiloSessionId, directory);
        logToFile(`session.attach ready directory=${directory}`);
        return ok();
      }
      if (restored.code !== 404) {
        progress.fail('kilo_session', 'phase:kilo_session', restored.error);
        return fail('not_ready', 'kilo session is not ready', true);
      }
      progress.progress('kilo_session', 'phase:kilo_session', 'Starting session…');
      await kiloClient.ensureSession(kiloSessionId, directory);
    }
    progress.complete('kilo_session', 'phase:kilo_session');
  } catch {
    progress.fail('kilo_session', 'phase:kilo_session', 'kilo session is not ready');
    return fail('not_ready', 'kilo session is not ready', true);
  }
  rememberSessionDirectory(session.kiloSessionId, directory);
  rememberAttachedRoot(session.kiloSessionId, directory);
  logToFile(`session.attach ready directory=${directory}`);
  return ok();
}
