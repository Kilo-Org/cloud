import { z } from 'zod';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { OperationResult } from '../../persistence/types.js';
import {
  createSandboxTerminalBridge,
  terminalWrapperIdSchema,
  type SandboxTerminalRecord,
} from '../../sandbox-session/terminal-bridge.js';
import {
  sessionTerminalClosePayloadSchema,
  sessionTerminalCloseResultSchema,
  sessionTerminalConnectPayloadSchema,
  sessionTerminalConnectResultSchema,
  sessionTerminalCreatePayloadSchema,
  sessionTerminalCreateResultSchema,
  sessionTerminalResizePayloadSchema,
  sessionTerminalResizeResultSchema,
  terminalPtyIdSchema,
  type SessionTerminalConnectPayload,
} from '../../shared/sandbox-control-protocol.js';
import type {
  ControlPlaneControlResult,
  ControlPlaneControlSession,
  ControlPlaneTerminalInput,
} from '../../shared/control-plane-protocol.js';
import { isTerminalSessionPlatform } from '../../terminal/access.js';

const TERMINAL_PREFIX = 'control_terminal:';
const TERMINAL_OPERATION_PREFIX = 'control_terminal_operation:';
const TERMINAL_UNAVAILABLE = 'Terminal unavailable until the workspace is prepared';

const terminalRecordSchema = z
  .object({
    ptyId: terminalPtyIdSchema,
    ownerId: z.string().min(1),
    sessionId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    directory: z.string().min(1),
    sandboxId: z.string().min(1),
    wrapperId: terminalWrapperIdSchema,
    organizationId: z.string().min(1).optional(),
    state: z.enum(['running', 'ended']),
  })
  .strict();

const completedCreationSchema = z
  .object({
    operationId: z.string().uuid(),
    record: terminalRecordSchema,
    result: sessionTerminalCreateResultSchema,
    cols: z.number().int().min(2).max(500).optional(),
    rows: z.number().int().min(2).max(200).optional(),
  })
  .strict();

type CompletedCreation = z.infer<typeof completedCreationSchema>;

type TerminalPty = z.infer<typeof sessionTerminalCreateResultSchema>['pty'];
type TerminalCreateResult = OperationResult<{ pty: TerminalPty }>;

type ReadyTerminalContext = {
  metadata: SessionMetadata;
  sandboxId: string;
  wrapperId: string;
  session: ControlPlaneControlSession;
};

export type ControlPlaneTerminalsDeps = {
  state: DurableObjectState;
  sessionId: string;
  getMetadata: () => SessionMetadata | null;
  /** The registered route directory (spec §3). */
  getDirectory: () => string | undefined;
  /** The connected wrapper identity, or undefined when no wrapper is bound. */
  getWrapperId: () => Promise<string | undefined>;
  /** True when the route is ready to accept terminals (spec §5). */
  isRouteReady: () => boolean;
  /** Forwards one terminal request to the Sandbox DO (spec §10). */
  request: (
    sandboxId: string,
    input: ControlPlaneTerminalInput
  ) => Promise<ControlPlaneControlResult>;
};

function denied<T>(reason: string): OperationResult<T> {
  return { success: false, error: `Terminal access denied: ${reason}` };
}

function unavailable<T>(): OperationResult<T> {
  return { success: false, error: TERMINAL_UNAVAILABLE };
}

function sameTerminalIdentity(left: SandboxTerminalRecord, right: SandboxTerminalRecord): boolean {
  return (
    left.ptyId === right.ptyId &&
    left.ownerId === right.ownerId &&
    left.sessionId === right.sessionId &&
    left.kiloSessionId === right.kiloSessionId &&
    left.directory === right.directory &&
    left.sandboxId === right.sandboxId &&
    left.wrapperId === right.wrapperId &&
    left.organizationId === right.organizationId
  );
}

/**
 * The V2 Session DO's terminal projection (plan B10). It owns only the terminal
 * record and creation idempotency and forwards every operation to the Sandbox
 * DO's `terminal` RPC. The sockets themselves are bridged by the shared
 * `terminal-bridge.ts`; records are keyed by the V2 `wrapperId` (spec §6).
 */
export function createControlPlaneTerminals(deps: ControlPlaneTerminalsDeps) {
  const inFlightCreations = new Map<
    string,
    { fingerprint: string; promise: Promise<TerminalCreateResult> }
  >();

  async function readRecord(ptyId: string): Promise<SandboxTerminalRecord | null> {
    if (!terminalPtyIdSchema.safeParse(ptyId).success) return null;
    const raw = await deps.state.storage.get<unknown>(`${TERMINAL_PREFIX}${ptyId}`);
    if (raw === undefined) return null;
    const parsed = terminalRecordSchema.safeParse(raw);
    return parsed.success && parsed.data.ptyId === ptyId ? parsed.data : null;
  }

  async function readCompleted(operationId: string): Promise<CompletedCreation | null> {
    const raw = await deps.state.storage.get<unknown>(`${TERMINAL_OPERATION_PREFIX}${operationId}`);
    if (raw === undefined) return null;
    const parsed = completedCreationSchema.safeParse(raw);
    return parsed.success && parsed.data.operationId === operationId ? parsed.data : null;
  }

  async function clearCompleted(ptyId: string): Promise<void> {
    const rows = await deps.state.storage.list<unknown>({ prefix: TERMINAL_OPERATION_PREFIX });
    const deletes: string[] = [];
    for (const [key, raw] of rows) {
      const operation = completedCreationSchema.safeParse(raw);
      if (!operation.success || operation.data.record.ptyId === ptyId) deletes.push(key);
    }
    if (deletes.length > 0) await deps.state.storage.delete(deletes);
  }

  async function markEnded(record: SandboxTerminalRecord): Promise<void> {
    const current = await readRecord(record.ptyId);
    if (!current || !sameTerminalIdentity(current, record)) return;
    await deps.state.storage.put(`${TERMINAL_PREFIX}${current.ptyId}`, {
      ...current,
      state: 'ended',
    });
    await clearCompleted(current.ptyId);
  }

  async function getTerminal(ptyId: string): Promise<SandboxTerminalRecord | undefined> {
    const record = await readRecord(ptyId);
    if (!record) return undefined;
    const wrapperId = await deps.getWrapperId();
    if (wrapperId === undefined || record.wrapperId !== wrapperId) return undefined;
    return record;
  }

  async function readyContext(): Promise<OperationResult<ReadyTerminalContext>> {
    const metadata = deps.getMetadata();
    if (metadata === null) return { success: false, error: 'Session not found' };
    if (!isTerminalSessionPlatform(metadata.identity.createdOnPlatform)) {
      return denied('terminals are only available for interactive Cloud Agent sessions');
    }
    const directory = deps.getDirectory();
    const sandboxId = metadata.workspace?.sandboxId;
    const kiloSessionId = metadata.auth.kiloSessionId;
    if (!directory || !sandboxId || !kiloSessionId) return unavailable();
    if (!deps.isRouteReady()) return unavailable();
    const wrapperId = await deps.getWrapperId();
    if (wrapperId === undefined || !terminalWrapperIdSchema.safeParse(wrapperId).success) {
      return denied('the running wrapper does not support terminals');
    }
    // A replaced wrapper's running records are unreachable; settle them now so
    // they (and their creation completions) do not linger forever.
    await endStaleRecords(wrapperId);
    return {
      success: true,
      data: {
        metadata,
        sandboxId,
        wrapperId,
        session: { sessionId: metadata.identity.sessionId, kiloSessionId, directory },
      },
    };
  }

  function makeRecord(context: ReadyTerminalContext, ptyId: string): SandboxTerminalRecord {
    return {
      ptyId,
      ownerId: context.metadata.identity.userId,
      sessionId: context.metadata.identity.sessionId,
      kiloSessionId: context.session.kiloSessionId,
      directory: context.session.directory,
      sandboxId: context.sandboxId,
      wrapperId: context.wrapperId,
      ...(context.metadata.identity.orgId
        ? { organizationId: context.metadata.identity.orgId }
        : {}),
      state: 'running',
    };
  }

  function creationFingerprint(
    context: ReadyTerminalContext,
    payload: { cols?: number; rows?: number }
  ): string {
    return JSON.stringify([
      context.metadata.identity.userId,
      context.session.sessionId,
      context.session.kiloSessionId,
      context.session.directory,
      context.sandboxId,
      context.wrapperId,
      context.metadata.identity.orgId ?? null,
      payload.cols ?? null,
      payload.rows ?? null,
    ]);
  }

  function requestFailure<T>(result: ControlPlaneControlResult): OperationResult<T> {
    return { success: false, error: result.ok ? TERMINAL_UNAVAILABLE : result.error.message };
  }

  /**
   * Best-effort close of a PTY the wrapper already created. Used on every
   * post-create rejection so an orphaned shell cannot keep the sandbox active.
   */
  async function closeWrapperTerminal(context: ReadyTerminalContext, ptyId: string): Promise<void> {
    try {
      await deps.request(context.sandboxId, {
        operation: 'close',
        session: context.session,
        payload: { ptyId },
      });
    } catch {
      // The original rejection is the result the caller needs.
    }
  }

  /** Ends running records for a replaced wrapper and clears their completions. */
  async function endStaleRecords(currentWrapperId: string): Promise<void> {
    const rows = await deps.state.storage.list<unknown>({ prefix: TERMINAL_PREFIX });
    for (const [key, raw] of rows) {
      const parsed = terminalRecordSchema.safeParse(raw);
      if (!parsed.success || parsed.data.state !== 'running') continue;
      if (parsed.data.wrapperId === currentWrapperId) continue;
      await deps.state.storage.put(key, { ...parsed.data, state: 'ended' });
      await clearCompleted(parsed.data.ptyId);
    }
  }

  async function requiredRecord(
    input: { ptyId: string },
    allowEnded = false
  ): Promise<OperationResult<{ context: ReadyTerminalContext; record: SandboxTerminalRecord }>> {
    const ready = await readyContext();
    if (!ready.success || !ready.data) return { success: false, error: ready.error };
    const context = ready.data;
    const record = await readRecord(input.ptyId);
    if (!record || record.sessionId !== context.metadata.identity.sessionId) {
      return denied('terminal does not belong to this session');
    }
    if (record.wrapperId !== context.wrapperId) {
      return denied('terminal does not belong to the current runtime');
    }
    if (!allowEnded && record.state !== 'running') {
      return { success: false, error: 'PTY session ended' };
    }
    return { success: true, data: { context, record } };
  }

  async function create(input: {
    operationId: string;
    cols?: number;
    rows?: number;
  }): Promise<OperationResult<{ pty: z.infer<typeof sessionTerminalCreateResultSchema>['pty'] }>> {
    const parsed = sessionTerminalCreatePayloadSchema.safeParse(input);
    if (!parsed.success) return denied('invalid terminal creation request');
    const ready = await readyContext();
    if (!ready.success || !ready.data) return { success: false, error: ready.error };
    const context = ready.data;

    const completed = await readCompleted(parsed.data.operationId);
    if (completed) {
      const expected = makeRecord(context, completed.result.pty.id);
      const stored = await readRecord(completed.result.pty.id);
      if (
        !sameTerminalIdentity(completed.record, expected) ||
        completed.cols !== parsed.data.cols ||
        completed.rows !== parsed.data.rows ||
        !stored ||
        stored.state !== 'running' ||
        !sameTerminalIdentity(stored, expected)
      ) {
        return denied('terminal creation operation conflicts with its existing identity');
      }
      return { success: true, data: completed.result };
    }

    const fingerprint = creationFingerprint(context, parsed.data);
    const existing = inFlightCreations.get(parsed.data.operationId);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? existing.promise
        : denied('terminal creation operation conflicts with its existing identity');
    }

    const promise = performCreation(context, parsed.data);
    const inFlight = { fingerprint, promise };
    inFlightCreations.set(parsed.data.operationId, inFlight);
    try {
      return await promise;
    } finally {
      if (inFlightCreations.get(parsed.data.operationId) === inFlight) {
        inFlightCreations.delete(parsed.data.operationId);
      }
    }
  }

  async function performCreation(
    context: ReadyTerminalContext,
    payload: { operationId: string; cols?: number; rows?: number }
  ): Promise<OperationResult<{ pty: z.infer<typeof sessionTerminalCreateResultSchema>['pty'] }>> {
    let response: ControlPlaneControlResult;
    try {
      response = await deps.request(context.sandboxId, {
        operation: 'create',
        session: context.session,
        payload,
      });
    } catch {
      return unavailable();
    }
    if (!response.ok) return requestFailure(response);
    const result = sessionTerminalCreateResultSchema.safeParse(response.result);
    if (!result.success) return { success: false, error: 'Terminal is unavailable' };
    const pty = result.data.pty;
    if (pty.cwd !== context.session.directory || pty.status !== 'running') {
      await closeWrapperTerminal(context, pty.id);
      return denied('the wrapper returned an invalid terminal workspace');
    }
    // The wrapper may have been replaced while the create was in flight; a
    // record stamped with a dead identity would be unreachable.
    let latestWrapperId: string | undefined;
    try {
      latestWrapperId = await deps.getWrapperId();
    } catch {
      latestWrapperId = undefined;
    }
    if (!deps.isRouteReady() || latestWrapperId !== context.wrapperId) {
      await closeWrapperTerminal(context, pty.id);
      return unavailable();
    }
    const record = makeRecord(context, pty.id);
    const existing = await readRecord(pty.id);
    if (existing && !sameTerminalIdentity(existing, record)) {
      await closeWrapperTerminal(context, pty.id);
      return denied('the wrapper returned a terminal owned by another session');
    }
    const completion: CompletedCreation = {
      operationId: payload.operationId,
      record,
      result: result.data,
      ...(payload.cols === undefined ? {} : { cols: payload.cols }),
      ...(payload.rows === undefined ? {} : { rows: payload.rows }),
    };
    await deps.state.storage.put(`${TERMINAL_PREFIX}${pty.id}`, record);
    await deps.state.storage.put(`${TERMINAL_OPERATION_PREFIX}${payload.operationId}`, completion);
    return { success: true, data: result.data };
  }

  async function resize(input: {
    ptyId: string;
    cols: number;
    rows: number;
  }): Promise<OperationResult<{ pty: z.infer<typeof sessionTerminalResizeResultSchema>['pty'] }>> {
    const parsed = sessionTerminalResizePayloadSchema.safeParse(input);
    if (!parsed.success) return denied('invalid terminal resize request');
    const ownership = await requiredRecord(parsed.data);
    if (!ownership.success || !ownership.data) {
      return { success: false, error: ownership.error };
    }
    const { context, record } = ownership.data;
    let response: ControlPlaneControlResult;
    try {
      response = await deps.request(context.sandboxId, {
        operation: 'resize',
        session: context.session,
        payload: parsed.data,
      });
    } catch {
      return unavailable();
    }
    if (!response.ok) return requestFailure(response);
    const latest = await readRecord(record.ptyId);
    if (latest?.state !== 'running' || !sameTerminalIdentity(latest, record)) {
      return denied('terminal does not belong to the current runtime');
    }
    const result = sessionTerminalResizeResultSchema.safeParse(response.result);
    if (
      !result.success ||
      result.data.pty.id !== record.ptyId ||
      result.data.pty.cwd !== record.directory
    ) {
      return denied('the wrapper returned an invalid terminal identity');
    }
    return { success: true, data: result.data };
  }

  async function close(input: { ptyId: string }): Promise<OperationResult<{ success: boolean }>> {
    const parsed = sessionTerminalClosePayloadSchema.safeParse(input);
    if (!parsed.success) return denied('invalid terminal close request');
    const ownership = await requiredRecord(parsed.data, true);
    if (!ownership.success || !ownership.data) {
      return { success: false, error: ownership.error };
    }
    const { context, record } = ownership.data;
    let response: ControlPlaneControlResult;
    try {
      response = await deps.request(context.sandboxId, {
        operation: 'close',
        session: context.session,
        payload: parsed.data,
      });
    } catch {
      return unavailable();
    }
    if (!response.ok) return requestFailure(response);
    const result = sessionTerminalCloseResultSchema.safeParse(response.result);
    if (!result.success || !result.data.success) {
      return { success: false, error: 'Terminal closure failed; please retry' };
    }
    await markEnded(record);
    bridge.closeTerminal(record.ptyId, 1000, 'PTY session ended');
    return { success: true, data: { success: true } };
  }

  async function requestConnect(
    record: SandboxTerminalRecord,
    input: SessionTerminalConnectPayload
  ): Promise<ControlPlaneControlResult> {
    const payload = sessionTerminalConnectPayloadSchema.parse(input);
    if (payload.ptyId !== record.ptyId || payload.ownerId !== record.ownerId) {
      return {
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'Terminal connection identity mismatch',
          retryable: false,
        },
      };
    }
    const ownership = await requiredRecord({ ptyId: payload.ptyId });
    if (!ownership.success || !ownership.data) {
      return {
        ok: false,
        error: {
          code: 'not_ready',
          message: ownership.error ?? TERMINAL_UNAVAILABLE,
          retryable: true,
        },
      };
    }
    const { context, record: current } = ownership.data;
    if (current.state !== 'running' || !sameTerminalIdentity(current, record)) {
      return {
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'Terminal runtime mismatch',
          retryable: false,
        },
      };
    }
    let response: ControlPlaneControlResult;
    try {
      response = await deps.request(context.sandboxId, {
        operation: 'connect',
        session: context.session,
        payload,
      });
    } catch {
      return {
        ok: false,
        error: { code: 'not_ready', message: TERMINAL_UNAVAILABLE, retryable: true },
      };
    }
    if (response.ok && !sessionTerminalConnectResultSchema.safeParse(response.result).success) {
      return {
        ok: false,
        error: { code: 'protocol_error', message: 'Invalid terminal response', retryable: false },
      };
    }
    return response;
  }

  const bridge = createSandboxTerminalBridge({
    state: deps.state,
    getMetadata: async () => deps.getMetadata(),
    getTerminal,
    requestConnect,
    // V2 has no activity RPC: terminal input is a wrapper-side signal, reported
    // as heartbeat `active` only while input is recent (spec §6). The Session DO
    // therefore has nothing to forward from a socket message.
    reportActivity: async () => undefined,
    markEnded,
    resolveDirectory: () => deps.getDirectory(),
  });

  return {
    create,
    resize,
    close,
    requestConnect,
    getTerminal,
    markEnded,
    handleBrowserUpgrade: bridge.handleBrowserUpgrade,
    handleWrapperUpgrade: bridge.handleWrapperUpgrade,
    handleMessage: bridge.handleMessage,
    handleClose: bridge.handleClose,
    handleError: bridge.handleError,
    closeAll: bridge.closeAll,
    closeRuntime: bridge.closeRuntime,
    closeTerminal: bridge.closeTerminal,
  };
}

export type ControlPlaneTerminals = ReturnType<typeof createControlPlaneTerminals>;
