import path from 'node:path';
import {
  diagnosticSyncStatus,
  emitControlDiagnostic,
  type ControlDiagnosticRecord,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import {
  SESSION_OPERATIONS,
  sandboxShutdownPayloadSchema,
  sessionAbortPayloadSchema,
  sessionAttachPayloadSchema,
  sessionDetachPayloadSchema,
  sessionGitSummaryPayloadSchema,
  sessionPermissionResolvePayloadSchema,
  sessionPromptPayloadSchema,
  sessionQuestionResolvePayloadSchema,
  sessionSyncPayloadSchema,
  sessionTerminalClosePayloadSchema,
  sessionTerminalCloseResultSchema,
  sessionTerminalConnectPayloadSchema,
  sessionTerminalConnectResultSchema,
  sessionTerminalCreatePayloadSchema,
  sessionTerminalCreateResultSchema,
  sessionTerminalResizePayloadSchema,
  sessionTerminalResizeResultSchema,
  worktreeDeletePayloadSchema,
  type SandboxHeartbeatPayload,
  type SessionEventPayload,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
  type SessionOperationAck,
  type SessionPromptPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import { isKiloServerUnreachableError, type WrapperKiloClient } from '../kilo-api.js';
import type { materializeMessageAttachments } from '../session-bootstrap.js';
import type { runAutoCommit } from '../auto-commit.js';
import { rejectBeforeAdmission, type ControlHandlerResult } from './control-handler-result.js';
import { createOperationRegistry, type OperationRegistry } from './operation-registry.js';
import { applySessionAttach, type AttachPreparingEmitter } from './apply-attach';
import {
  directoriesForRoot,
  directoryForSession,
  forgetAttachedRoot,
  rootForSession,
} from './session-directories';
import {
  KILO_CONTROL_REQUEST_TIMEOUT_MS,
  withKiloRequestDeadline,
} from './sandbox-control-runtime';
import { ControlTerminalRuntimeError, type ControlTerminalRuntime } from './terminal-runtime.js';
import {
  WorktreeKiloRuntimeError,
  type WorktreeKiloRuntime,
  type WorktreeKiloRuntimes,
} from './worktree-runtime.js';
import {
  assertDirectoryActive,
  fenceDirectoryOperations,
  runDirectoryOperation,
} from './worktree-operations';
import {
  createWorktreeKiloCleanupClient,
  deleteWorktree,
  prepareWorktreeDeletion,
  validateWorktreeDirectory,
  type WorktreeKiloCleanupClient,
} from './delete-worktree';
import { collectWorktreeChanges } from './worktree-changes';
import { createNativeObservations, type NativeObservations } from './native-observations.js';

export type { ControlHandlerResult } from './control-handler-result.js';
export type { SessionOperation as OwnedSessionTask } from './session-operation.js';

export type HandlerSessionSnapshot = {
  kiloSessionId: string;
  lastActivityAt: number;
  pendingInputs?: Set<string>;
};

type SessionActivity = {
  revision: symbol;
  state: 'idle' | 'active' | 'finalizing';
  lastActivityAt: number;
  waitingOn?: 'model' | 'tool' | 'finalizing';
};

type KiloSessionStatuses = Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>;

export type SessionActivityRegistry = {
  attach(rootKiloSessionId: string): void;
  detach(rootKiloSessionId: string): void;
  markActive(rootKiloSessionId: string): void;
  observeEvent(
    type: string,
    kiloSessionId: string | undefined,
    rootKiloSessionId: string | undefined,
    properties: Record<string, unknown>
  ): void;
  reconcile(statuses: KiloSessionStatuses, roots?: readonly string[]): void;
  revision(rootKiloSessionId: string): symbol | undefined;
  snapshots(): NonNullable<SandboxHeartbeatPayload['sessions']>;
  state(): 'idle' | 'active';
};

export function createSessionActivityRegistry(
  now: () => number = Date.now
): SessionActivityRegistry {
  const sessions = new Map<string, SessionActivity>();

  function update(
    rootKiloSessionId: string,
    state: SessionActivity['state'],
    waitingOn?: SessionActivity['waitingOn'],
    refresh = false
  ): void {
    const session = sessions.get(rootKiloSessionId);
    if (!session) return;
    session.revision = Symbol();
    if (!refresh && session.state === state && session.waitingOn === waitingOn) return;
    session.state = state;
    session.lastActivityAt = now();
    if (waitingOn) {
      session.waitingOn = waitingOn;
    } else {
      delete session.waitingOn;
    }
  }

  function applyStatus(rootKiloSessionId: string, status: { type: string; waitingOn?: unknown }) {
    if (status.type === 'idle') {
      update(rootKiloSessionId, 'idle');
      return;
    }
    if (status.type === 'finalizing') {
      update(rootKiloSessionId, 'finalizing', 'finalizing');
      return;
    }
    update(rootKiloSessionId, 'active', status.waitingOn === 'tool' ? 'tool' : 'model');
  }

  return {
    attach(rootKiloSessionId) {
      if (!sessions.has(rootKiloSessionId)) {
        sessions.set(rootKiloSessionId, {
          revision: Symbol(),
          state: 'idle',
          lastActivityAt: now(),
        });
      }
    },
    detach(rootKiloSessionId) {
      sessions.delete(rootKiloSessionId);
    },
    markActive(rootKiloSessionId) {
      update(rootKiloSessionId, 'active', 'model', true);
    },
    observeEvent(type, kiloSessionId, rootKiloSessionId, properties) {
      if (!rootKiloSessionId || kiloSessionId !== rootKiloSessionId) return;
      if (type === 'session.turn.open') {
        update(rootKiloSessionId, 'active', 'model', true);
        return;
      }
      if (type === 'session.status') {
        const status = properties.status;
        if (typeof status === 'object' && status !== null && 'type' in status) {
          if (typeof status.type === 'string') {
            applyStatus(rootKiloSessionId, {
              type: status.type,
              waitingOn: 'waitingOn' in status ? status.waitingOn : undefined,
            });
          }
        }
        return;
      }
      if (type === 'session.idle' || type === 'session.turn.close' || type === 'session.error') {
        update(rootKiloSessionId, 'idle');
      }
    },
    reconcile(statuses, roots = [...sessions.keys()]) {
      for (const rootKiloSessionId of roots) {
        applyStatus(rootKiloSessionId, statuses[rootKiloSessionId] ?? { type: 'idle' });
      }
    },
    revision(rootKiloSessionId) {
      return sessions.get(rootKiloSessionId)?.revision;
    },
    snapshots() {
      const observedAt = now();
      return [...sessions.entries()].map(([kiloSessionId, session]) => ({
        kiloSessionId,
        state: session.state,
        idleForMs: Math.max(0, Math.trunc(observedAt - session.lastActivityAt)),
        ...(session.waitingOn ? { waitingOn: session.waitingOn } : {}),
      }));
    },
    state() {
      for (const session of sessions.values()) {
        if (session.state === 'active' || session.state === 'finalizing') return 'active';
      }
      return 'idle';
    },
  };
}

export type HandlerDeps = {
  kiloRuntimes?: WorktreeKiloRuntimes;
  worktreeCleanupClient?: WorktreeKiloCleanupClient;
  operations: OperationRegistry;
  version: string;
  kiloReady: boolean;
  sessions: HandlerSessionSnapshot[];
  sendOperationResult?: (
    session: SessionRequestIdentity,
    delivery: SessionOperationDelivery,
    signal: AbortSignal,
    deadlineAt: number
  ) => Promise<SessionOperationAck>;
  signal?: AbortSignal;
  activity?: SessionActivityRegistry;
  nativeObservations?: NativeObservations;
  emitSessionEvent: (
    session: SessionRequestIdentity,
    payload: SessionEventPayload,
    options?: { retained?: true }
  ) => void;
  retireRuntime: (reason: string) => void;
  onShutdown?: () => void;
  onDiagnostic?: ControlDiagnosticReporter;
  emitPreparing?: AttachPreparingEmitter;
  terminalRuntime?: ControlTerminalRuntime;
  applyAttach?: typeof applySessionAttach;
  materializeAttachments?: typeof materializeMessageAttachments;
  runAutoCommit?: typeof runAutoCommit;
  collectWorktreeChanges?: typeof collectWorktreeChanges;
};

const SESSION_OPERATION_SET = new Set<string>(SESSION_OPERATIONS);

function ok(result: unknown): ControlHandlerResult {
  return { ok: true, result };
}

function fail(code: string, message: string, retryable: boolean): ControlHandlerResult {
  return { ok: false, error: { code, message, retryable } };
}

function kiloFailure(error: unknown): ControlHandlerResult {
  return fail('not_ready', 'Kilo request failed', isKiloServerUnreachableError(error));
}

function operationEffects(session: SessionRequestIdentity, deps: HandlerDeps) {
  const send = deps.sendOperationResult;
  return {
    signal: deps.signal,
    onDiagnostic: deps.onDiagnostic,
    emitSessionEvent: (event: SessionEventPayload, options?: { retained?: true }) =>
      deps.emitSessionEvent(session, event, options),
    sendOperationResult: send
      ? (delivery: SessionOperationDelivery, signal: AbortSignal, deadlineAt: number) =>
          send(session, delivery, signal, deadlineAt)
      : undefined,
  };
}

export function pruneControlOperations(deps: HandlerDeps, now = Date.now()): void {
  deps.operations.prune(now);
}

export function buildHeartbeatPayload(deps: HandlerDeps): SandboxHeartbeatPayload {
  const now = Date.now();
  const snapshots = new Map(
    deps.activity?.snapshots().map(snapshot => [snapshot.kiloSessionId, snapshot])
  );
  for (const snapshot of deps.sessions) {
    const task = deps.operations.active(snapshot.kiloSessionId);
    if (!task && snapshots.has(snapshot.kiloSessionId)) continue;
    const waitingOn =
      task?.kind === 'preparation'
        ? 'preparation'
        : task?.kind === 'finalizing'
          ? 'finalizing'
          : snapshot.pendingInputs?.size
            ? 'input'
            : 'model';
    snapshots.set(snapshot.kiloSessionId, {
      kiloSessionId: snapshot.kiloSessionId,
      state: task?.kind === 'finalizing' ? 'finalizing' : task ? 'active' : 'idle',
      idleForMs: Math.max(0, now - snapshot.lastActivityAt),
      ...(task ? { waitingOn } : {}),
    });
  }
  const sessions = [...snapshots.values()];
  const active = sessions.filter(snapshot => snapshot.state !== 'idle');
  return {
    state:
      active.length === 0
        ? 'idle'
        : active.every(snapshot => snapshot.state === 'finalizing')
          ? 'finalizing'
          : 'active',
    activeKiloSessions: active.length,
    pendingMessages: deps.operations.counts().active,
    kilo: {
      ready: deps.kiloReady && !deps.signal?.aborted,
      ...(deps.kiloRuntimes?.kiloCliVersion !== undefined
        ? { version: deps.kiloRuntimes.kiloCliVersion }
        : {}),
    },
    sessions,
  };
}

export async function refreshHeartbeatPayload(
  deps: HandlerDeps,
  signal?: AbortSignal
): Promise<SandboxHeartbeatPayload> {
  await deps.nativeObservations?.refresh(signal);
  return buildHeartbeatPayload(deps);
}

export function createControlHandlerDeps(input: Omit<HandlerDeps, 'operations'>): HandlerDeps {
  const deps: HandlerDeps = Object.assign(input, {
    operations: createOperationRegistry({
      native: { get: directory => input.kiloRuntimes?.get(directory) },
      onStarted: (session, preparation) => {
        if (!preparation) deps.activity?.markActive(session.kiloSessionId);
        const snapshot = deps.sessions.find(item => item.kiloSessionId === session.kiloSessionId);
        if (snapshot) snapshot.lastActivityAt = Date.now();
        else
          deps.sessions.push({ kiloSessionId: session.kiloSessionId, lastActivityAt: Date.now() });
      },
      onCompleted: session => {
        deps.activity?.reconcile({}, [session.kiloSessionId]);
        const snapshot = deps.sessions.find(item => item.kiloSessionId === session.kiloSessionId);
        if (snapshot) {
          snapshot.lastActivityAt = Date.now();
          delete snapshot.pendingInputs;
        }
      },
      retireRuntime: reason => deps.retireRuntime(reason),
    }),
  });
  if (!deps.nativeObservations && deps.activity && deps.kiloRuntimes) {
    deps.nativeObservations = createNativeObservations({
      get signal() {
        return deps.signal;
      },
      roots: () =>
        (deps.activity?.snapshots() ?? []).map(({ kiloSessionId }) => ({
          kiloSessionId,
          directory: directoryForSession(kiloSessionId),
          revision: deps.activity?.revision(kiloSessionId),
        })),
      getRuntime: directory => deps.kiloRuntimes?.get(directory),
      reconcileActivity: (statuses, roots) => deps.activity?.reconcile(statuses, roots),
    });
  }
  return deps;
}

export async function cancelControlTasks(
  deps: HandlerDeps,
  reason: string,
  status: 'failed' | 'cancelled' = 'cancelled'
): Promise<void> {
  const tasks = deps.operations.activeOperations();
  for (const task of tasks) task.cancel(reason, status);
  await Promise.all(tasks.map(task => task.done));
}

export async function handleControlRequest(
  operation: string,
  session: SessionRequestIdentity | undefined,
  payload: unknown,
  deps: HandlerDeps,
  authorization?: SessionOperationAuthorization
): Promise<ControlHandlerResult> {
  if (operation === 'sandbox.status') {
    const heartbeat = buildHeartbeatPayload(deps);
    return ok({
      healthy: heartbeat.kilo.ready,
      state: heartbeat.state,
      version: deps.version,
      kiloReady: heartbeat.kilo.ready,
    });
  }
  if (operation === 'sandbox.shutdown') {
    const deadlineAt = Date.now() + KILO_CONTROL_REQUEST_TIMEOUT_MS;
    if (!sandboxShutdownPayloadSchema.safeParse(payload).success) {
      return fail('protocol_error', 'Invalid payload', false);
    }
    deps.onShutdown?.();
    await cancelControlTasks(deps, 'Sandbox shutting down');
    await deps.operations.drainDelivery(deadlineAt);
    deps.terminalRuntime?.shutdown();
    deps.kiloRuntimes?.shutdown();
    return ok({ shuttingDown: true });
  }
  if (operation === 'worktree.prepareDeletion' || operation === 'worktree.delete') {
    const parsed = worktreeDeletePayloadSchema.safeParse(payload);
    if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);
    const input = parsed.data;
    try {
      validateWorktreeDirectory(input);
    } catch {
      return fail('protocol_error', 'Invalid worktree directory', false);
    }
    const kiloRuntimes = deps.kiloRuntimes;
    if (!kiloRuntimes) return missingKilo();
    const startedAt = Date.now();
    let failureStage: ControlDiagnosticRecord['fields']['stage'] = 'deletion_fence';
    const diagnostic = (
      phase: 'started' | 'completed' | 'failed',
      stage: NonNullable<ControlDiagnosticRecord['fields']['stage']>
    ): void =>
      emitControlDiagnostic(deps.onDiagnostic, 'control.request', {
        operation,
        phase,
        stage,
        worktreeId: input.worktreeId,
        sessionCount: input.sessionIds.length,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
    try {
      const fenced = fenceDirectoryOperations(input.directory);
      diagnostic('started', 'deletion_fence');
      failureStage = 'task_cancellation';
      const tasks = deps.operations
        .activeOperations()
        .filter(task => task.session.directory === input.directory);
      for (const task of tasks) task.cancel('Worktree deleted', 'cancelled');
      const results = await Promise.all(tasks.map(task => task.done));
      failureStage = 'deletion_fence';
      await fenced;
      diagnostic('completed', 'deletion_fence');
      if (results.some((result, index) => !result.ok && tasks[index]?.kind !== 'preparation')) {
        diagnostic('failed', 'task_cancellation');
        return fail('not_ready', 'Worktree cancellation is incomplete', true);
      }
      failureStage = 'runtime_lookup';
      const runtime = kiloRuntimes.get(input.directory);
      const client =
        deps.worktreeCleanupClient ??
        (runtime ? createWorktreeKiloCleanupClient(runtime.kiloClient.serverUrl) : undefined);
      const cleanupDeps = {
        onDiagnostic: deps.onDiagnostic,
        client,
        detachRoot: (id: string) => {
          deps.activity?.detach(id);
          const index = deps.sessions.findIndex(snapshot => snapshot.kiloSessionId === id);
          if (index !== -1) deps.sessions.splice(index, 1);
        },
        detachTerminals: async (directory: string) => {
          await deps.terminalRuntime?.detachDirectory(directory);
        },
        retireDirectory: async (directory: string) => {
          await kiloRuntimes.deleteDirectory(directory);
        },
      };
      failureStage = undefined;
      if (operation === 'worktree.prepareDeletion') {
        return ok({
          prepared: true,
          sessionIds: await prepareWorktreeDeletion(input, cleanupDeps),
        });
      }
      return ok(await deleteWorktree(input, cleanupDeps));
    } catch {
      if (failureStage) diagnostic('failed', failureStage);
      return fail('not_ready', 'Worktree cleanup is incomplete', true);
    }
  }
  if (!SESSION_OPERATION_SET.has(operation)) {
    return fail('unknown_operation', 'Unknown operation', false);
  }
  if (!session) {
    return fail('protocol_error', 'session identity is required', false);
  }
  if (operation === 'session.operation.ack') return deps.operations.acknowledge(session, payload);
  const admission = deps.operations.admission(operation, session, payload, authorization);
  if (admission.kind === 'reply') return admission.result;
  if (
    (deps.signal?.aborted || (!deps.kiloReady && operation !== 'session.git.summary')) &&
    operation !== 'session.abort' &&
    operation !== 'session.detach'
  ) {
    if (operation === 'session.sync') {
      emitControlDiagnostic(deps.onDiagnostic, 'control.request', {
        operation,
        phase: 'failed',
        stage: 'runtime_lookup',
        sessionId: session.sessionId,
        kiloSessionId: session.kiloSessionId,
        elapsedMs: 0,
        ok: false,
        errorCode: 'not_ready',
        retryable: true,
        aborted: deps.signal?.aborted ?? false,
        ownedTask: deps.operations.hasActive(session.kiloSessionId),
        statusQueryPending: false,
        questionQueryPending: false,
        permissionQueryPending: false,
      });
    }
    return missingKilo();
  }

  const attachedDirectory = directoryForSession(session.kiloSessionId);
  if (
    operation === 'session.detach' &&
    attachedDirectory !== undefined &&
    attachedDirectory !== session.directory
  ) {
    return fail('unauthorized', 'Session directory mismatch', false);
  }
  const current = deps.operations.active(session.kiloSessionId);
  if (
    current &&
    (current.session.directory !== session.directory ||
      current.session.sessionId !== session.sessionId)
  ) {
    return fail('unauthorized', 'Session task ownership mismatch', false);
  }

  try {
    assertDirectoryActive(session.directory);
    return await handleSessionControlRequest(operation, session, payload, deps, authorization);
  } catch {
    return fail('not_ready', 'Worktree is being deleted', false);
  }
}

async function handleSessionControlRequest(
  operation: string,
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps,
  authorization?: SessionOperationAuthorization
): Promise<ControlHandlerResult> {
  switch (operation) {
    case 'session.attach':
      return handleAttach(session, payload, deps, authorization);
    case 'session.detach':
      return handleDetach(session, payload, deps);
    case 'session.prompt':
      return handlePrompt(session, payload, deps, authorization);
    case 'session.abort':
      return handleAbort(session, payload, deps);
    case 'session.permission.resolve':
      return handlePermissionResolve(session, payload, deps);
    case 'session.question.resolve':
      return handleQuestionResolve(session, payload, deps);
    case 'session.sync':
      return handleSync(session, payload, deps);
    case 'session.terminal.create':
      return handleTerminalOperation(
        session,
        payload,
        deps.terminalRuntime,
        sessionTerminalCreatePayloadSchema,
        sessionTerminalCreateResultSchema,
        (runtime, identity, parsed) => runtime.create(identity, parsed)
      );
    case 'session.terminal.resize':
      return handleTerminalOperation(
        session,
        payload,
        deps.terminalRuntime,
        sessionTerminalResizePayloadSchema,
        sessionTerminalResizeResultSchema,
        (runtime, identity, parsed) => runtime.resize(identity, parsed)
      );
    case 'session.terminal.close':
      return handleTerminalOperation(
        session,
        payload,
        deps.terminalRuntime,
        sessionTerminalClosePayloadSchema,
        sessionTerminalCloseResultSchema,
        (runtime, identity, parsed) => runtime.close(identity, parsed)
      );
    case 'session.terminal.connect':
      return handleTerminalOperation(
        session,
        payload,
        deps.terminalRuntime,
        sessionTerminalConnectPayloadSchema,
        sessionTerminalConnectResultSchema,
        (runtime, identity, parsed) => runtime.connect(identity, parsed)
      );
    case 'session.git.summary':
      return handleGitSummary(session, payload, deps);
    default:
      return fail('unknown_operation', 'Unknown operation', false);
  }
}

function missingKilo(): ControlHandlerResult {
  return fail('not_ready', 'Kilo is not ready', true);
}

function sessionKiloRuntime(
  session: SessionRequestIdentity,
  deps: HandlerDeps
): WorktreeKiloRuntime | undefined {
  if (
    directoryForSession(session.kiloSessionId) !== session.directory ||
    rootForSession(session.kiloSessionId) !== session.kiloSessionId
  )
    return undefined;
  return deps.kiloRuntimes?.get(session.directory);
}

function terminalFailure(error: unknown): ControlHandlerResult {
  if (error instanceof ControlTerminalRuntimeError || error instanceof WorktreeKiloRuntimeError) {
    return fail(error.code, error.message, error.retryable);
  }
  return fail('not_ready', 'Terminal request failed', isKiloServerUnreachableError(error));
}

async function handleAttach(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps,
  authorization?: SessionOperationAuthorization
): Promise<ControlHandlerResult> {
  const parsed = sessionAttachPayloadSchema.safeParse(payload ?? {});
  if (!parsed.success) return rejectBeforeAdmission('protocol_error', 'Invalid payload', false);

  if (
    parsed.data.env &&
    CONTROL_RUNTIME_RESERVED_ENV_VARS.some(name => Object.hasOwn(parsed.data.env ?? {}, name))
  ) {
    return rejectBeforeAdmission(
      'protocol_error',
      'Reserved control runtime environment variable',
      false
    );
  }
  if (deps.operations.hasActive(session.kiloSessionId)) {
    return rejectBeforeAdmission('session_busy', 'Session has work in progress', true);
  }

  const task = deps.operations.start(
    session,
    authorization,
    {
      operation: 'session.attach',
      payload: parsed.data,
      apply: (identity, payload, hooks) =>
        (deps.applyAttach ?? applySessionAttach)(identity, payload, {
          ...hooks,
          onDiagnostic: deps.onDiagnostic,
          kiloRuntimes: deps.kiloRuntimes,
          canRefreshCredentials: () =>
            !deps.operations
              .activeOperations()
              .some(
                task =>
                  task.session.directory === session.directory &&
                  task.session.kiloSessionId !== session.kiloSessionId
              ) &&
            !(deps.activity?.snapshots() ?? []).some(
              snapshot =>
                snapshot.state !== 'idle' &&
                directoryForSession(snapshot.kiloSessionId) === session.directory
            ),
          ...(deps.terminalRuntime ? { terminalRuntime: deps.terminalRuntime } : {}),
        }),
      onAttached: () => deps.activity?.attach(session.kiloSessionId),
      emitPreparing: deps.emitPreparing,
    },
    operationEffects(session, deps)
  );
  return task.done;
}

async function handleDetach(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  if (!sessionDetachPayloadSchema.safeParse(payload).success) {
    return fail('protocol_error', 'Invalid payload', false);
  }
  const task = deps.operations.active(session.kiloSessionId);
  if (task) {
    task.cancel('Session detached', 'cancelled');
    const result = await task.done;
    if (!result.ok && task.kind !== 'preparation') return result;
  }
  try {
    if (!task) {
      const runtime = sessionKiloRuntime(session, deps);
      if (runtime) await abortKiloSession(session, runtime.kiloClient);
    }
    deps.kiloRuntimes?.detach(session);
    const terminalCleanup = deps.terminalRuntime?.detachSession(session);
    forgetAttachedRoot(session.kiloSessionId, session.directory);
    deps.activity?.detach(session.kiloSessionId);
    const index = deps.sessions.findIndex(item => item.kiloSessionId === session.kiloSessionId);
    if (index !== -1) deps.sessions.splice(index, 1);
    await terminalCleanup;
    return ok({ detached: true });
  } catch (error) {
    return terminalFailure(error);
  }
}

type RuntimeSchema<Value> = {
  safeParse(value: unknown): { success: true; data: Value } | { success: false };
};

async function handleTerminalOperation<Payload, Result>(
  session: SessionRequestIdentity,
  payload: unknown,
  runtime: ControlTerminalRuntime | undefined,
  payloadSchema: RuntimeSchema<Payload>,
  resultSchema: RuntimeSchema<Result>,
  invoke: (
    terminalRuntime: ControlTerminalRuntime,
    identity: SessionRequestIdentity,
    parsed: Payload
  ) => Promise<Result>
): Promise<ControlHandlerResult> {
  const parsedPayload = payloadSchema.safeParse(payload);
  if (!parsedPayload.success) return fail('protocol_error', 'Invalid payload', false);
  if (!runtime) return fail('not_ready', 'Terminal is not available', false);

  try {
    const result = resultSchema.safeParse(await invoke(runtime, session, parsedPayload.data));
    if (!result.success) return fail('protocol_error', 'Invalid terminal result', false);
    return ok(result.data);
  } catch (error) {
    return terminalFailure(error);
  }
}

async function handleGitSummary(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const parsed = sessionGitSummaryPayloadSchema.safeParse(payload);
  if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);
  const directory = session.directory;
  return runDirectoryOperation(directory, async () => {
    if (rootForSession(session.kiloSessionId, directory) !== session.kiloSessionId) {
      return fail('not_ready', 'Session directory is not attached', false);
    }
    if (deps.signal?.aborted) return missingKilo();
    let result: Awaited<ReturnType<typeof collectWorktreeChanges>>;
    try {
      result = await (deps.collectWorktreeChanges ?? collectWorktreeChanges)(
        directory,
        parsed.data,
        undefined,
        deps.signal
      );
    } catch {
      return deps.signal?.aborted
        ? missingKilo()
        : fail('capture_failed', 'Worktree capture failed', true);
    }
    assertDirectoryActive(directory);
    if (deps.signal?.aborted) return missingKilo();
    if (rootForSession(session.kiloSessionId, directory) !== session.kiloSessionId) {
      return fail('not_ready', 'Session directory is not attached', false);
    }
    return ok(result);
  });
}

function validAttachmentPaths(
  session: SessionRequestIdentity,
  payload: SessionPromptPayload
): boolean {
  const root = path.resolve('/tmp/attachments', session.sessionId);
  return (
    root.startsWith('/tmp/attachments/') &&
    (payload.attachments ?? []).every(attachment => {
      const localPath = path.resolve(attachment.localPath);
      return (
        path.isAbsolute(attachment.localPath) &&
        localPath.startsWith(`${root}/`) &&
        path.basename(localPath) === attachment.filename &&
        !attachment.filename.includes('\\')
      );
    })
  );
}

function handlePrompt(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps,
  authorization?: SessionOperationAuthorization
): ControlHandlerResult {
  const runtime = sessionKiloRuntime(session, deps);
  if (!runtime) {
    if (
      deps.kiloRuntimes?.isHealthy() &&
      directoryForSession(session.kiloSessionId) === session.directory &&
      rootForSession(session.kiloSessionId) === session.kiloSessionId &&
      deps.operations
        .activeOperations()
        .some(
          task =>
            task.kind === 'preparation' &&
            task.session.directory === session.directory &&
            !task.signal.aborted
        )
    ) {
      return rejectBeforeAdmission('session_busy', 'Worktree has preparation in progress', true);
    }
    return rejectBeforeAdmission('not_ready', 'Kilo is not ready', true);
  }
  const parsed = sessionPromptPayloadSchema.safeParse(payload);
  if (!parsed.success) return rejectBeforeAdmission('protocol_error', 'Invalid payload', false);
  const request = parsed.data;
  if (authorization && authorization.messageId !== request.messageId)
    return rejectBeforeAdmission('idempotency_conflict', 'Message identity mismatch', false);
  if (
    request.turn.type === 'command' &&
    request.turn.command === 'compact' &&
    !request.agent.model
  ) {
    return rejectBeforeAdmission('protocol_error', 'Model is required for compact', false);
  }
  if (!validAttachmentPaths(session, request)) {
    return rejectBeforeAdmission('protocol_error', 'Invalid attachment path', false);
  }
  if (request.turn.type === 'command' && request.attachments?.length) {
    return rejectBeforeAdmission(
      'protocol_error',
      'Command attachments are not supported by the control runtime',
      false
    );
  }
  const existing = deps.operations.active(session.kiloSessionId);
  if (existing) {
    if (
      existing.kind !== 'preparation' &&
      existing.messageId === request.messageId &&
      !existing.signal.aborted
    ) {
      return ok({ messageId: request.messageId, status: 'existing' });
    }
    return rejectBeforeAdmission('session_busy', 'Session has work in progress', true);
  }
  deps.operations.start(
    session,
    authorization,
    {
      operation: 'session.prompt',
      payload: request,
      runtime,
      materializeAttachments: deps.materializeAttachments,
      runAutoCommit: deps.runAutoCommit,
    },
    operationEffects(session, deps)
  );
  return ok({ messageId: request.messageId, status: 'accepted' });
}

async function abortKiloSession(
  session: SessionRequestIdentity,
  kiloClient: WrapperKiloClient
): Promise<void> {
  const aborted = await withKiloRequestDeadline(signal =>
    kiloClient.abortSession({
      sessionId: session.kiloSessionId,
      directory: session.directory,
      signal,
    })
  );
  if (aborted !== true) throw new Error('Kilo cancellation was not confirmed');
}

async function handleAbort(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const parsed = sessionAbortPayloadSchema.safeParse(payload ?? {});
  if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);
  const task = deps.operations.abortTarget(session, parsed.data.messageId);
  if (task) {
    if (
      parsed.data.cleanupDeadlineAt !== undefined &&
      parsed.data.cleanupDeadlineAt <= Date.now()
    ) {
      return ok(
        parsed.data.operationId
          ? { status: 'unconfirmed', quiescent: false }
          : { status: 'already_idle' }
      );
    }
    task.cancel('Session aborted', 'cancelled', parsed.data.cleanupDeadlineAt);
    const result = await task.done;
    if (parsed.data.operationId) {
      const delivery = task.deliveryResult();
      return ok({
        status: 'unconfirmed',
        quiescent: false,
        ...(delivery ? { delivery } : {}),
      });
    }
    if (!result.ok && task.kind !== 'preparation') return result;
    return ok({ status: 'aborted' });
  }
  return ok(
    parsed.data.operationId
      ? { status: 'unconfirmed', quiescent: false }
      : { status: 'already_idle' }
  );
}

async function readRootRequests<Request extends { id: string; sessionID: string }>(
  session: SessionRequestIdentity,
  read: (directory: string, signal: AbortSignal) => Promise<Request[]>,
  signal: AbortSignal
): Promise<{ matches: Array<{ directory: string; request: Request }>; complete: boolean }> {
  const rootDirectory = directoryForSession(session.kiloSessionId) ?? session.directory;
  const scopes = await Promise.all(
    directoriesForRoot(session.kiloSessionId, rootDirectory).map(async directory => {
      const requests = await read(directory, signal);
      const matches: Array<{ directory: string; request: Request }> = [];
      let complete = true;
      for (const request of requests) {
        const root = rootForSession(request.sessionID);
        if (request.sessionID === session.kiloSessionId || root === session.kiloSessionId) {
          const requestDirectory = directoryForSession(request.sessionID);
          if (requestDirectory === directory) matches.push({ directory, request });
          else if (!requestDirectory) complete = false;
        } else if (root === undefined) {
          complete = false;
        }
      }
      return { matches, complete };
    })
  );
  return {
    matches: scopes.flatMap(scope => scope.matches),
    complete: scopes.every(scope => scope.complete),
  };
}

async function handlePermissionResolve(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const kiloClient = sessionKiloRuntime(session, deps)?.kiloClient;
  if (!kiloClient) return missingKilo();
  const parsed = sessionPermissionResolvePayloadSchema.safeParse(payload);
  if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);
  try {
    return await withKiloRequestDeadline(async signal => {
      const permissions = await readRootRequests(
        session,
        (directory, signal) => kiloClient.getPermissions(directory, signal),
        signal
      );
      const pending = permissions.matches.find(
        item => item.request.id === parsed.data.permissionId
      );
      if (!pending)
        return fail('unauthorized', 'Permission is not pending for this session', false);
      const success = await kiloClient.answerPermission(
        parsed.data.permissionId,
        parsed.data.response,
        parsed.data.message,
        true,
        pending.directory,
        signal
      );
      return success
        ? ok({ success: true })
        : fail('not_ready', 'Permission reply was not accepted', false);
    }, deps.signal);
  } catch (error) {
    return kiloFailure(error);
  }
}

async function handleQuestionResolve(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const kiloClient = sessionKiloRuntime(session, deps)?.kiloClient;
  if (!kiloClient) return missingKilo();
  const parsed = sessionQuestionResolvePayloadSchema.safeParse(payload);
  if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);
  try {
    return await withKiloRequestDeadline(async signal => {
      const questions = await readRootRequests(
        session,
        (directory, signal) => kiloClient.getQuestions(directory, signal),
        signal
      );
      const pending = questions.matches.find(item => item.request.id === parsed.data.questionId);
      if (!pending) return fail('unauthorized', 'Question is not pending for this session', false);
      const success =
        parsed.data.action === 'answer'
          ? await kiloClient.answerQuestion(
              parsed.data.questionId,
              parsed.data.answers,
              pending.directory,
              signal
            )
          : await kiloClient.rejectQuestion(parsed.data.questionId, pending.directory, signal);
      return success
        ? ok({ success: true })
        : fail('not_ready', 'Question reply was not accepted', false);
    }, deps.signal);
  } catch (error) {
    return kiloFailure(error);
  }
}

async function handleSync(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const startedAt = Date.now();
  const pending = { sync_status: false, sync_questions: false, sync_permissions: false };
  let pendingAtAbort: typeof pending | undefined;
  let nativeStatus: ControlDiagnosticRecord['fields']['nativeStatus'];
  let questionCount: number | undefined;
  let permissionCount: number | undefined;
  const diagnostic = (
    phase: 'completed' | 'failed',
    stage: NonNullable<ControlDiagnosticRecord['fields']['stage']>,
    fields: Partial<ControlDiagnosticRecord['fields']> = {}
  ): void => {
    const queries = pendingAtAbort ?? pending;
    emitControlDiagnostic(deps.onDiagnostic, 'control.request', {
      operation: 'session.sync',
      phase,
      stage,
      sessionId: session.sessionId,
      kiloSessionId: session.kiloSessionId,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ok: phase === 'completed',
      aborted: deps.signal?.aborted ?? false,
      ownedTask: deps.operations.hasActive(session.kiloSessionId),
      statusQueryPending: queries.sync_status,
      questionQueryPending: queries.sync_questions,
      permissionQueryPending: queries.sync_permissions,
      nativeStatus,
      questionCount,
      permissionCount,
      ...fields,
    });
  };
  const kiloClient = sessionKiloRuntime(session, deps)?.kiloClient;
  if (!kiloClient) {
    diagnostic('failed', 'runtime_lookup', { errorCode: 'not_ready', retryable: true });
    return missingKilo();
  }
  if (!sessionSyncPayloadSchema.safeParse(payload).success) {
    diagnostic('failed', 'sync_validation', { errorCode: 'protocol_error', retryable: false });
    return fail('protocol_error', 'Invalid payload', false);
  }
  try {
    const [statuses, questions, permissions] = await withKiloRequestDeadline(signal => {
      signal.addEventListener(
        'abort',
        () => {
          pendingAtAbort = { ...pending };
        },
        { once: true }
      );
      const query = <Value>(
        stage: keyof typeof pending,
        read: () => Promise<Value>,
        completed: (value: Value) => void
      ): Promise<Value> => {
        pending[stage] = true;
        const failed = (error: unknown): never => {
          pending[stage] = false;
          diagnostic('failed', stage, { aborted: signal.aborted });
          throw error;
        };
        try {
          return read().then(value => {
            pending[stage] = false;
            completed(value);
            diagnostic('completed', stage, { aborted: signal.aborted });
            return value;
          }, failed);
        } catch (error) {
          return failed(error);
        }
      };
      return Promise.all([
        query(
          'sync_status',
          () =>
            kiloClient.getSessionStatuses(
              directoryForSession(session.kiloSessionId) ?? session.directory,
              signal
            ),
          statuses => {
            const status = statuses?.[session.kiloSessionId];
            nativeStatus = status == null ? 'missing' : diagnosticSyncStatus(status.type);
          }
        ),
        query(
          'sync_questions',
          () =>
            readRootRequests(
              session,
              (directory, signal) => kiloClient.getQuestions(directory, signal),
              signal
            ),
          questions => {
            questionCount = questions.matches.length;
          }
        ),
        query(
          'sync_permissions',
          () =>
            readRootRequests(
              session,
              (directory, signal) => kiloClient.getPermissions(directory, signal),
              signal
            ),
          permissions => {
            permissionCount = permissions.matches.length;
          }
        ),
      ]);
    }, deps.signal);
    if (!questions.complete || !permissions.complete) {
      throw new Error('Native requests contain unresolved ancestry');
    }
    const ownedTask = deps.operations.hasActive(session.kiloSessionId);
    const status = ownedTask
      ? { type: 'busy' }
      : (statuses[session.kiloSessionId] ?? { type: 'idle' });
    const result = ok({
      status,
      questions: questions.matches.map(({ request }) =>
        request.sessionID === session.kiloSessionId && !('rootKiloSessionId' in request)
          ? request
          : { ...request, rootKiloSessionId: session.kiloSessionId }
      ),
      permissions: permissions.matches.map(({ request }) =>
        request.sessionID === session.kiloSessionId && !('rootKiloSessionId' in request)
          ? request
          : { ...request, rootKiloSessionId: session.kiloSessionId }
      ),
    });
    diagnostic('completed', 'sync_result', {
      ownedTask,
      syncStatus: diagnosticSyncStatus(status.type),
    });
    return result;
  } catch (error) {
    const result = kiloFailure(error);
    diagnostic('failed', 'sync_result', {
      errorCode: 'not_ready',
      retryable: !result.ok && result.error.retryable,
      timedOut: error instanceof Error && error.message === 'Kilo request timed out',
    });
    return result;
  }
}
