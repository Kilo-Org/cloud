import path from 'node:path';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
  SESSION_OPERATIONS,
  sandboxShutdownPayloadSchema,
  sessionAbortPayloadSchema,
  sessionAttachPayloadSchema,
  sessionDetachPayloadSchema,
  sessionMessageOutcomeSchema,
  sessionEventPayloadSchema,
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
  type SessionMessageOutcome,
  type SessionPromptPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import { isKiloServerUnreachableError, type WrapperKiloClient } from '../kilo-api.js';
import { materializeMessageAttachments } from '../session-bootstrap.js';
import { runAutoCommit } from '../auto-commit.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';
import { withTimeoutAndAbort } from '../utils.js';
import { applySessionAttach, type AttachPreparingEmitter } from './apply-attach';
import {
  directoriesForRoot,
  directoryForSession,
  forgetAttachedRoot,
  rootForSession,
} from './session-directories';
import { withKiloRequestDeadline } from './sandbox-control-runtime';
import { ControlTerminalRuntimeError, type ControlTerminalRuntime } from './terminal-runtime.js';
import {
  WorktreeKiloRuntimeError,
  type WorktreeKiloRuntime,
  type WorktreeKiloRuntimes,
} from './worktree-runtime.js';
import { assertDirectoryActive, fenceDirectoryOperations } from './worktree-operations';
import {
  createWorktreeKiloCleanupClient,
  deleteWorktree,
  prepareWorktreeDeletion,
  validateWorktreeDirectory,
  type WorktreeKiloCleanupClient,
} from './delete-worktree';

export type HandlerSessionSnapshot = {
  kiloSessionId: string;
  lastActivityAt: number;
  pendingInputs?: Set<string>;
};

type TaskIdentity =
  | { kind: 'preparation'; messageId?: string }
  | { kind: 'execution' | 'finalizing'; messageId: string };

export type OwnedSessionTask = TaskIdentity & {
  session: SessionRequestIdentity;
  controller: AbortController;
  signal: AbortSignal;
  done: Promise<ControlHandlerResult>;
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
  version: string;
  kiloReady: boolean;
  sessions: HandlerSessionSnapshot[];
  tasks: Map<string, OwnedSessionTask>;
  signal?: AbortSignal;
  activity?: SessionActivityRegistry;
  emitSessionEvent: (session: SessionRequestIdentity, payload: SessionEventPayload) => void;
  retireRuntime: (reason: string) => void;
  onShutdown?: () => void;
  emitPreparing?: AttachPreparingEmitter;
  terminalRuntime?: ControlTerminalRuntime;
  applyAttach?: typeof applySessionAttach;
  materializeAttachments?: typeof materializeMessageAttachments;
  runAutoCommit?: typeof runAutoCommit;
};

export type ControlHandlerResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

class ControlTaskCancellation extends Error {
  constructor(
    readonly status: 'failed' | 'cancelled',
    message: string
  ) {
    super(message);
  }
}

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

export function buildHeartbeatPayload(deps: HandlerDeps): SandboxHeartbeatPayload {
  const now = Date.now();
  const snapshots = new Map(
    deps.activity?.snapshots().map(snapshot => [snapshot.kiloSessionId, snapshot])
  );
  for (const snapshot of deps.sessions) {
    const task = deps.tasks.get(snapshot.kiloSessionId);
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
    pendingMessages: deps.tasks.size,
    kilo: { ready: deps.kiloReady && !deps.signal?.aborted },
    sessions,
  };
}

export async function refreshHeartbeatPayload(deps: HandlerDeps): Promise<SandboxHeartbeatPayload> {
  const { activity, kiloRuntimes } = deps;
  if (activity && kiloRuntimes) {
    const rootsByDirectory = new Map<string, string[]>();
    for (const { kiloSessionId } of activity.snapshots()) {
      const directory = directoryForSession(kiloSessionId);
      if (!directory) continue;
      const roots = rootsByDirectory.get(directory) ?? [];
      roots.push(kiloSessionId);
      rootsByDirectory.set(directory, roots);
    }
    await Promise.all(
      [...rootsByDirectory].map(async ([directory, roots]) => {
        const runtime = kiloRuntimes.get(directory);
        if (!runtime) return;
        const revisions = new Map(roots.map(root => [root, activity.revision(root)]));
        try {
          const statuses = await withKiloRequestDeadline(
            signal => runtime.kiloClient.getSessionStatuses(directory, signal),
            deps.signal ? AbortSignal.any([deps.signal, runtime.signal]) : runtime.signal
          );
          if (
            runtime.signal.aborted ||
            deps.signal?.aborted ||
            kiloRuntimes.get(directory) !== runtime
          )
            return;
          activity.reconcile(
            statuses,
            roots.filter(
              root =>
                directoryForSession(root) === directory &&
                activity.revision(root) === revisions.get(root)
            )
          );
        } catch {
          return;
        }
      })
    );
  }
  return buildHeartbeatPayload(deps);
}

function startSessionTask(
  session: SessionRequestIdentity,
  identity: TaskIdentity,
  deps: HandlerDeps,
  run: (task: OwnedSessionTask) => Promise<ControlHandlerResult>
): OwnedSessionTask {
  const completion = Promise.withResolvers<ControlHandlerResult>();
  const controller = new AbortController();
  const task: OwnedSessionTask = {
    ...identity,
    session,
    controller,
    signal: deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal,
    done: completion.promise,
  };
  deps.tasks.set(session.kiloSessionId, task);
  if (identity.kind !== 'preparation') deps.activity?.markActive(session.kiloSessionId);
  const snapshot = deps.sessions.find(item => item.kiloSessionId === session.kiloSessionId);
  if (snapshot) {
    snapshot.lastActivityAt = Date.now();
  } else {
    deps.sessions.push({ kiloSessionId: session.kiloSessionId, lastActivityAt: Date.now() });
  }
  const timeout = setTimeout(
    () => {
      const reason =
        identity.kind !== 'preparation'
          ? 'Execution exceeded the 60 minute limit'
          : 'Session preparation timed out';
      controller.abort(new ControlTaskCancellation('failed', reason));
      deps.retireRuntime(reason);
    },
    identity.kind !== 'preparation'
      ? SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS
      : SANDBOX_CONTROL_ATTACH_TIMEOUT_MS
  );
  timeout.unref();
  void Promise.resolve()
    .then(() => run(task))
    .catch(kiloFailure)
    .then(result => {
      clearTimeout(timeout);
      if (deps.tasks.get(session.kiloSessionId) === task) {
        deps.tasks.delete(session.kiloSessionId);
        deps.activity?.reconcile({}, [session.kiloSessionId]);
        const snapshot = deps.sessions.find(item => item.kiloSessionId === session.kiloSessionId);
        if (snapshot) {
          snapshot.lastActivityAt = Date.now();
          delete snapshot.pendingInputs;
        }
      }
      completion.resolve(result);
    });
  return task;
}

export async function cancelControlTasks(
  deps: HandlerDeps,
  reason: string,
  status: 'failed' | 'cancelled' = 'cancelled'
): Promise<void> {
  const tasks = [...deps.tasks.values()];
  for (const task of tasks) task.controller.abort(new ControlTaskCancellation(status, reason));
  await Promise.all(tasks.map(task => task.done));
}

export async function handleControlRequest(
  operation: string,
  session: SessionRequestIdentity | undefined,
  payload: unknown,
  deps: HandlerDeps
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
    if (!sandboxShutdownPayloadSchema.safeParse(payload).success) {
      return fail('protocol_error', 'Invalid payload', false);
    }
    deps.onShutdown?.();
    await cancelControlTasks(deps, 'Sandbox shutting down');
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
    try {
      const fenced = fenceDirectoryOperations(input.directory);
      const tasks = [...deps.tasks.values()].filter(
        task => task.session.directory === input.directory
      );
      for (const task of tasks) {
        task.controller.abort(new ControlTaskCancellation('cancelled', 'Worktree deleted'));
      }
      const results = await Promise.all(tasks.map(task => task.done));
      await fenced;
      if (results.some((result, index) => !result.ok && tasks[index]?.kind !== 'preparation')) {
        return fail('not_ready', 'Worktree cancellation is incomplete', true);
      }
      const runtime = kiloRuntimes.get(input.directory);
      const client =
        deps.worktreeCleanupClient ??
        (runtime ? createWorktreeKiloCleanupClient(runtime.kiloClient.serverUrl) : undefined);
      const cleanupDeps = {
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
      if (operation === 'worktree.prepareDeletion') {
        return ok({
          prepared: true,
          sessionIds: await prepareWorktreeDeletion(input, cleanupDeps),
        });
      }
      return ok(await deleteWorktree(input, cleanupDeps));
    } catch {
      return fail('not_ready', 'Worktree cleanup is incomplete', true);
    }
  }
  if (!SESSION_OPERATION_SET.has(operation)) {
    return fail('unknown_operation', 'Unknown operation', false);
  }
  if (!session) {
    return fail('protocol_error', 'session identity is required', false);
  }
  if (
    (!deps.kiloReady || deps.signal?.aborted) &&
    operation !== 'session.abort' &&
    operation !== 'session.detach'
  ) {
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
  const current = deps.tasks.get(session.kiloSessionId);
  if (
    current &&
    (current.session.directory !== session.directory ||
      current.session.sessionId !== session.sessionId)
  ) {
    return fail('unauthorized', 'Session task ownership mismatch', false);
  }

  try {
    assertDirectoryActive(session.directory);
    return await handleSessionControlRequest(operation, session, payload, deps);
  } catch {
    return fail('not_ready', 'Worktree is being deleted', false);
  }
}

async function handleSessionControlRequest(
  operation: string,
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  switch (operation) {
    case 'session.attach':
      return handleAttach(session, payload, deps);
    case 'session.detach':
      return handleDetach(session, payload, deps);
    case 'session.prompt':
      return handlePrompt(session, payload, deps);
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
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const parsed = sessionAttachPayloadSchema.safeParse(payload ?? {});
  if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);

  if (
    parsed.data.env &&
    CONTROL_RUNTIME_RESERVED_ENV_VARS.some(name => Object.hasOwn(parsed.data.env ?? {}, name))
  ) {
    return fail('protocol_error', 'Reserved control runtime environment variable', false);
  }
  if (deps.tasks.has(session.kiloSessionId)) {
    return fail('not_ready', 'Session has work in progress', true);
  }

  const task = startSessionTask(
    session,
    { kind: 'preparation', messageId: parsed.data.preparation?.triggerMessageId },
    deps,
    async owned => {
      const result = await (deps.applyAttach ?? applySessionAttach)(session, parsed.data, {
        kiloRuntimes: deps.kiloRuntimes,
        signal: owned.signal,
        ...(deps.terminalRuntime ? { terminalRuntime: deps.terminalRuntime } : {}),
        ...(deps.emitPreparing ? { emitPreparing: deps.emitPreparing } : {}),
      });
      if (owned.signal.aborted) {
        return fail('not_ready', 'Session attachment cancelled', true);
      }
      if (result.ok) deps.activity?.attach(session.kiloSessionId);
      return result;
    }
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
  const task = deps.tasks.get(session.kiloSessionId);
  if (task) {
    task.controller.abort(new ControlTaskCancellation('cancelled', 'Session detached'));
    const result = await task.done;
    if (!result.ok && task.kind !== 'preparation') return result;
  }
  try {
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
  deps: HandlerDeps
): ControlHandlerResult {
  const runtime = sessionKiloRuntime(session, deps);
  if (!runtime) return missingKilo();
  const parsed = sessionPromptPayloadSchema.safeParse(payload);
  if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);
  const request = parsed.data;
  if (
    request.turn.type === 'command' &&
    request.turn.command === 'compact' &&
    !request.agent.model
  ) {
    return fail('protocol_error', 'Model is required for compact', false);
  }
  if (!validAttachmentPaths(session, request)) {
    return fail('protocol_error', 'Invalid attachment path', false);
  }
  if (request.turn.type === 'command' && request.attachments?.length) {
    return fail(
      'protocol_error',
      'Command attachments are not supported by the control runtime',
      false
    );
  }
  const existing = deps.tasks.get(session.kiloSessionId);
  if (existing) {
    if (
      existing.kind !== 'preparation' &&
      existing.messageId === request.messageId &&
      !existing.signal.aborted
    ) {
      return ok({ messageId: request.messageId, status: 'existing' });
    }
    return fail('not_ready', 'Session has work in progress', true);
  }
  startSessionTask(
    session,
    { kind: 'execution', messageId: request.messageId },
    {
      ...deps,
      signal: deps.signal ? AbortSignal.any([deps.signal, runtime.signal]) : runtime.signal,
    },
    task => executePrompt(task, request, runtime, deps)
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

function emitFinalizationEvent(
  session: SessionRequestIdentity,
  event: IngestEvent,
  deps: HandlerDeps
): void {
  deps.emitSessionEvent(
    session,
    sessionEventPayloadSchema.parse({
      type: event.streamEventType,
      properties: event.data,
      timestamp: event.timestamp,
    })
  );
}

async function summarizeOwnedSession(
  task: OwnedSessionTask,
  kiloClient: WrapperKiloClient,
  model: { providerID?: string; modelID: string },
  auto?: boolean
): Promise<void> {
  const success = await withTimeoutAndAbort(
    kiloClient.summarizeSession({
      sessionId: task.session.kiloSessionId,
      directory: task.session.directory,
      signal: task.signal,
      model,
      ...(auto === undefined ? {} : { auto }),
    }),
    {
      signal: task.signal,
      timeoutMs: SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
      timeoutMessage: 'Execution exceeded the 60 minute limit',
      abortMessage: 'Execution cancelled',
    }
  );
  if (!success) throw new Error('Session summarization failed');
}

async function executePrompt(
  task: OwnedSessionTask,
  request: SessionPromptPayload,
  runtime: WorktreeKiloRuntime,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const { session, signal } = task;
  const { kiloClient, env } = runtime;
  const { messageId, turn, agent } = request;
  let outcome: SessionMessageOutcome;
  let result = ok({});
  let failureReason = 'Kilo execution failed';
  const emitStatus = (message: string): void =>
    emitFinalizationEvent(
      session,
      {
        streamEventType: 'status',
        data: { message, messageId },
        timestamp: new Date().toISOString(),
      },
      deps
    );
  try {
    signal.throwIfAborted();
    let completion: Awaited<ReturnType<WrapperKiloClient['sendPrompt']>> | undefined;
    const options = {
      sessionId: session.kiloSessionId,
      directory: session.directory,
      signal,
      messageId,
      agent: agent.mode,
      ...(agent.variant ? { variant: agent.variant } : {}),
    };
    const deadline = {
      signal,
      timeoutMs: SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
      timeoutMessage: 'Execution exceeded the 60 minute limit',
      abortMessage: 'Execution cancelled',
    };
    if (turn.type === 'prompt') {
      if (agent.model === undefined) throw new Error('Prompt model is required');
      const message = await (deps.materializeAttachments ?? materializeMessageAttachments)(
        { id: messageId, prompt: turn.prompt, parts: turn.parts, attachments: request.attachments },
        { signal }
      );
      signal.throwIfAborted();
      completion = await withTimeoutAndAbort(
        kiloClient.sendPrompt({
          ...options,
          prompt: message.prompt,
          ...(message.parts ? { parts: message.parts } : {}),
          model: { providerID: 'kilo', modelID: agent.model },
        }),
        deadline
      );
    } else if (turn.command === 'compact') {
      if (!agent.model) throw new Error('Model is required for compact');
      failureReason = 'Context condensation failed';
      emitStatus('Condensing context...');
      await summarizeOwnedSession(task, kiloClient, { providerID: 'kilo', modelID: agent.model });
      signal.throwIfAborted();
      emitStatus('Context condensed successfully');
    } else {
      completion = await withTimeoutAndAbort(
        kiloClient.sendCommand({
          ...options,
          command: turn.command,
          args: turn.arguments,
          ...(agent.model !== undefined
            ? { model: { providerID: 'kilo', modelID: agent.model } }
            : {}),
        }),
        deadline
      );
    }
    signal.throwIfAborted();
    const error = completion?.info.error;
    if (!error && (request.finalization?.autoCommit || request.finalization?.condenseOnComplete)) {
      task.kind = 'finalizing';
      if (request.finalization.autoCommit) {
        failureReason = 'Auto-commit failed';
        const committed = await (deps.runAutoCommit ?? runAutoCommit)({
          workspacePath: session.directory,
          kiloClient,
          env,
          messageId: completion?.info.id ?? messageId,
          signal,
          onEvent: event => emitFinalizationEvent(session, event, deps),
        });
        signal.throwIfAborted();
        if (!committed.success) throw new Error('Auto-commit failed');
      }
      if (request.finalization.condenseOnComplete) {
        failureReason = 'Context condensation failed';
        const model = agent.model
          ? { providerID: 'kilo', modelID: agent.model }
          : completion
            ? { providerID: completion.info.providerID, modelID: completion.info.modelID }
            : undefined;
        if (!model) throw new Error('Model is required for condensation');
        emitStatus('Condensing context...');
        await summarizeOwnedSession(task, kiloClient, model, true);
        signal.throwIfAborted();
        emitStatus('Context condensed successfully');
      }
    }
    outcome = error
      ? {
          messageId,
          status: error.name === 'MessageAbortedError' ? 'cancelled' : 'failed',
          reason: `Kilo execution ended with ${error.name}`,
        }
      : { messageId, status: 'completed' };
  } catch {
    const cancellation: unknown = signal.reason;
    outcome = {
      messageId,
      status: cancellation instanceof ControlTaskCancellation ? cancellation.status : 'failed',
      reason:
        cancellation instanceof ControlTaskCancellation ? cancellation.message : failureReason,
    };
    try {
      await abortKiloSession(session, kiloClient);
    } catch (error) {
      deps.retireRuntime('Kilo cancellation failed');
      result = kiloFailure(error);
    }
  }
  try {
    deps.emitSessionEvent(session, {
      type: 'session.message.outcome',
      properties: sessionMessageOutcomeSchema.parse(outcome),
    });
  } catch {
    deps.retireRuntime('Session outcome delivery failed');
    return fail('not_ready', 'Session outcome delivery failed', false);
  }
  return result;
}

async function handleAbort(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const parsed = sessionAbortPayloadSchema.safeParse(payload ?? {});
  if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);
  const task = deps.tasks.get(session.kiloSessionId);
  if (parsed.data.messageId && task?.messageId !== parsed.data.messageId) {
    return ok({ status: 'already_idle' });
  }
  if (task) {
    task.controller.abort(new ControlTaskCancellation('cancelled', 'Session aborted'));
    const result = await task.done;
    if (!result.ok && task.kind !== 'preparation') return result;
    return ok({ status: 'aborted' });
  }
  return ok({ status: 'already_idle' });
}

async function readRootRequests<Request extends { id: string; sessionID: string }>(
  session: SessionRequestIdentity,
  read: (directory: string, signal: AbortSignal) => Promise<Request[]>,
  signal: AbortSignal
): Promise<Array<{ directory: string; request: Request }>> {
  const rootDirectory = directoryForSession(session.kiloSessionId) ?? session.directory;
  const scopes = await Promise.all(
    directoriesForRoot(session.kiloSessionId, rootDirectory).map(async directory => {
      const requests = await read(directory, signal);
      return requests
        .filter(
          request =>
            (request.sessionID === session.kiloSessionId ||
              rootForSession(request.sessionID) === session.kiloSessionId) &&
            (directoryForSession(request.sessionID) ?? rootDirectory) === directory
        )
        .map(request => ({ directory, request }));
    })
  );
  return scopes.flat();
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
      const pending = permissions.find(item => item.request.id === parsed.data.permissionId);
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
      const pending = questions.find(item => item.request.id === parsed.data.questionId);
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
  const kiloClient = sessionKiloRuntime(session, deps)?.kiloClient;
  if (!kiloClient) return missingKilo();
  if (!sessionSyncPayloadSchema.safeParse(payload).success) {
    return fail('protocol_error', 'Invalid payload', false);
  }
  try {
    const [statuses, questions, permissions] = await withKiloRequestDeadline(
      signal =>
        Promise.all([
          kiloClient.getSessionStatuses(
            directoryForSession(session.kiloSessionId) ?? session.directory,
            signal
          ),
          readRootRequests(
            session,
            (directory, signal) => kiloClient.getQuestions(directory, signal),
            signal
          ),
          readRootRequests(
            session,
            (directory, signal) => kiloClient.getPermissions(directory, signal),
            signal
          ),
        ]),
      deps.signal
    );
    return ok({
      status: deps.tasks.has(session.kiloSessionId)
        ? { type: 'busy' }
        : (statuses[session.kiloSessionId] ?? { type: 'idle' }),
      questions: questions.map(({ request }) =>
        request.sessionID === session.kiloSessionId
          ? request
          : { ...request, rootKiloSessionId: session.kiloSessionId }
      ),
      permissions: permissions.map(({ request }) =>
        request.sessionID === session.kiloSessionId
          ? request
          : { ...request, rootKiloSessionId: session.kiloSessionId }
      ),
    });
  } catch (error) {
    return kiloFailure(error);
  }
}
