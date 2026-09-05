import { z } from 'zod';
import type { WrapperPty } from '../kilo/wrapper-client.js';
import { parseSessionMetadata, type SessionMetadata } from '../persistence/session-metadata.js';
import type { OperationResult } from '../persistence/types.js';
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
  wrapperInstanceIdSchema,
  type ResponseFrame,
  type SessionRequestIdentity,
  type SessionTerminalConnectPayload,
  type SessionTerminalCreatePayload,
} from '../shared/sandbox-control-protocol.js';
import { isTerminalSessionPlatform } from '../terminal/access.js';
import type { sandboxControlRpc } from './control-rpc.js';
import type { SandboxTerminalRecord } from './terminal-bridge.js';

export const SANDBOX_SESSION_METADATA_KEY = 'session_metadata';
export const SANDBOX_SESSION_LIFECYCLE_KEY = 'session_lifecycle_fence';
export const SANDBOX_SESSION_DELETED_WORKTREE_KEY = 'deleted_worktree';

const ATTACHED_SESSION_KEY = 'terminal_attached_session';
const TERMINAL_PREFIX = 'terminal:';
const TERMINAL_OPERATION_PREFIX = 'terminal_operation:';
const TERMINAL_UNAVAILABLE = 'Terminal unavailable until the workspace is prepared';
const TERMINAL_ACCESS_DENIED = 'Terminal access denied:';

const terminalRecordSchema = z
  .object({
    ptyId: terminalPtyIdSchema,
    ownerId: z.string().min(1),
    sessionId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    directory: z.string().min(1),
    sandboxId: z.string().min(1),
    wrapperInstanceId: wrapperInstanceIdSchema,
    organizationId: z.string().min(1).optional(),
    state: z.enum(['running', 'ended']),
  })
  .strict();

const attachedSessionSchema = terminalRecordSchema.omit({ ptyId: true, state: true }).strict();

const lifecycleFenceSchema = z
  .object({
    epoch: z.number().int().nonnegative(),
    state: z.enum(['revoked', 'deleted']),
    sandboxId: z.string().min(1).optional(),
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

type TerminalControl = Pick<
  ReturnType<typeof sandboxControlRpc>,
  'getStatus' | 'request' | 'detachSession' | 'validateTerminalAccess' | 'recordTerminalActivity'
>;
type LifecycleFence = z.infer<typeof lifecycleFenceSchema>;
type AttachedSession = z.infer<typeof attachedSessionSchema>;
type CompletedCreation = z.infer<typeof completedCreationSchema>;
type TerminalCreationInput = {
  cols?: number;
  rows?: number;
  operationId?: string;
};
type TerminalResizeInput = {
  ptyId?: string;
  cols?: number;
  rows?: number;
};
type LifecycleSnapshot = {
  epoch: number;
  metadata: SessionMetadata;
};
type ReadyTerminalContext = LifecycleSnapshot & {
  control: TerminalControl;
  session: SessionRequestIdentity;
  sandboxId: string;
  wrapperInstanceId: string;
};
type TerminalLifecycleDeps = {
  state: Pick<DurableObjectState, 'storage'>;
  getSessionId(): string;
  getControl(sandboxId: string): TerminalControl;
  getDirectory(metadata: SessionMetadata): string;
  closeTerminalBridge(ptyId: string, code?: number, reason?: string): void;
  closeAllBridges(code?: number, reason?: string): void;
  closeRuntimeBridges(wrapperInstanceId: string, code?: number, reason?: string): void;
};
type InFlightCreation = {
  fingerprint: string;
  promise: Promise<OperationResult<{ pty: WrapperPty }>>;
};

function terminalError<T>(error: string): OperationResult<T> {
  return { success: false, error };
}

function denied<T>(reason: string): OperationResult<T> {
  return terminalError(`${TERMINAL_ACCESS_DENIED} ${reason}`);
}

function sameTerminalIdentity(left: SandboxTerminalRecord, right: SandboxTerminalRecord): boolean {
  return (
    left.ptyId === right.ptyId &&
    left.ownerId === right.ownerId &&
    left.sessionId === right.sessionId &&
    left.kiloSessionId === right.kiloSessionId &&
    left.directory === right.directory &&
    left.sandboxId === right.sandboxId &&
    left.wrapperInstanceId === right.wrapperInstanceId &&
    left.organizationId === right.organizationId
  );
}

function sameAttachment(
  record: Omit<SandboxTerminalRecord, 'ptyId' | 'state'>,
  attachment: AttachedSession
): boolean {
  return (
    record.ownerId === attachment.ownerId &&
    record.sessionId === attachment.sessionId &&
    record.kiloSessionId === attachment.kiloSessionId &&
    record.directory === attachment.directory &&
    record.sandboxId === attachment.sandboxId &&
    record.wrapperInstanceId === attachment.wrapperInstanceId &&
    record.organizationId === attachment.organizationId
  );
}

export function createSandboxTerminalLifecycle(deps: TerminalLifecycleDeps) {
  const storage = deps.state.storage;
  const inFlightCreations = new Map<string, InFlightCreation>();

  function readFence(): LifecycleFence | undefined {
    const value = storage.kv.get<unknown>(SANDBOX_SESSION_LIFECYCLE_KEY);
    if (value === undefined) {
      return storage.kv.get(SANDBOX_SESSION_DELETED_WORKTREE_KEY) === undefined
        ? undefined
        : { epoch: Number.MAX_SAFE_INTEGER, state: 'deleted' };
    }
    const parsed = lifecycleFenceSchema.safeParse(value);
    return parsed.success ? parsed.data : { epoch: Number.MAX_SAFE_INTEGER, state: 'deleted' };
  }

  function getStoredMetadata(): SessionMetadata | null {
    const raw = storage.kv.get<unknown>(SANDBOX_SESSION_METADATA_KEY);
    if (raw === undefined) return null;
    try {
      return parseSessionMetadata(raw);
    } catch {
      return null;
    }
  }

  function snapshot(): LifecycleSnapshot | null {
    if (readFence() !== undefined) return null;
    const metadata = getStoredMetadata();
    return metadata?.identity.sessionId === deps.getSessionId() ? { epoch: 0, metadata } : null;
  }

  function isCurrent(epoch: number): boolean {
    return epoch === 0 && snapshot() !== null;
  }

  function unavailableSession<T>(): OperationResult<T> {
    const fence = readFence();
    return fence?.state === 'revoked'
      ? denied('session access revoked')
      : terminalError('Session not found');
  }

  function readAttachedSession(): AttachedSession | null {
    const raw = storage.kv.get<unknown>(ATTACHED_SESSION_KEY);
    if (raw === undefined) return null;
    const parsed = attachedSessionSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  function readTerminal(ptyId: string): SandboxTerminalRecord | null {
    if (!terminalPtyIdSchema.safeParse(ptyId).success) return null;
    const raw = storage.kv.get<unknown>(`${TERMINAL_PREFIX}${ptyId}`);
    if (raw === undefined) return null;
    const parsed = terminalRecordSchema.safeParse(raw);
    return parsed.success && parsed.data.ptyId === ptyId ? parsed.data : null;
  }

  function matchesMetadata(record: AttachedSession, metadata: SessionMetadata): boolean {
    return (
      record.ownerId === metadata.identity.userId &&
      record.sessionId === metadata.identity.sessionId &&
      record.kiloSessionId === metadata.auth.kiloSessionId &&
      record.directory === deps.getDirectory(metadata) &&
      record.sandboxId === metadata.workspace?.sandboxId &&
      record.organizationId === metadata.identity.orgId
    );
  }

  function getAttachedWrapperInstanceId(): string | undefined {
    const current = snapshot();
    const attached = readAttachedSession();
    return current && attached && matchesMetadata(attached, current.metadata)
      ? attached.wrapperInstanceId
      : undefined;
  }

  function clearCompletedCreations(ptyId: string): void {
    for (const [key, raw] of storage.kv.list<unknown>({ prefix: TERMINAL_OPERATION_PREFIX })) {
      const operation = completedCreationSchema.safeParse(raw);
      if (!operation.success || operation.data.record.ptyId === ptyId) {
        storage.kv.delete(key);
      }
    }
  }

  function markEnded(record: SandboxTerminalRecord): void {
    const current = readTerminal(record.ptyId);
    if (!current || !sameTerminalIdentity(current, record)) return;
    storage.transactionSync(() => {
      storage.kv.put(`${TERMINAL_PREFIX}${current.ptyId}`, { ...current, state: 'ended' });
      clearCompletedCreations(current.ptyId);
    });
  }

  function makeAttachment(context: ReadyTerminalContext): AttachedSession {
    return {
      ownerId: context.metadata.identity.userId,
      sessionId: context.session.sessionId,
      kiloSessionId: context.session.kiloSessionId,
      directory: context.session.directory,
      sandboxId: context.sandboxId,
      wrapperInstanceId: context.wrapperInstanceId,
      ...(context.metadata.identity.orgId
        ? { organizationId: context.metadata.identity.orgId }
        : {}),
    };
  }

  function accessIdentity(context: ReadyTerminalContext) {
    return {
      sessionId: context.session.sessionId,
      ownerId: context.metadata.identity.userId,
      wrapperInstanceId: context.wrapperInstanceId,
      ...(context.metadata.identity.orgId
        ? { organizationId: context.metadata.identity.orgId }
        : {}),
      ...(context.metadata.identity.botId ? { botId: context.metadata.identity.botId } : {}),
    };
  }

  async function readyContext(
    current: LifecycleSnapshot,
    options: { validateAccess: boolean }
  ): Promise<OperationResult<{ context: ReadyTerminalContext }>> {
    const metadata = current.metadata;
    const sandboxId = metadata.workspace?.sandboxId;
    const kiloSessionId = metadata.auth.kiloSessionId;
    if (!sandboxId || !kiloSessionId) return terminalError(TERMINAL_UNAVAILABLE);

    const control = deps.getControl(sandboxId);
    let status: Awaited<ReturnType<TerminalControl['getStatus']>>;
    try {
      status = await control.getStatus();
    } catch {
      return isCurrent(current.epoch) ? terminalError(TERMINAL_UNAVAILABLE) : unavailableSession();
    }
    if (!isCurrent(current.epoch)) return unavailableSession();
    if (status.physical !== 'running' || status.connection !== 'ready') {
      return terminalError(TERMINAL_UNAVAILABLE);
    }
    const wrapperInstance = wrapperInstanceIdSchema.safeParse(status.wrapperInstanceId);
    if (!wrapperInstance.success) {
      return denied('the running wrapper does not support terminals');
    }

    const context: ReadyTerminalContext = {
      ...current,
      control,
      sandboxId,
      wrapperInstanceId: wrapperInstance.data,
      session: {
        sessionId: metadata.identity.sessionId,
        kiloSessionId,
        directory: deps.getDirectory(metadata),
      },
    };
    const attached = readAttachedSession();
    if (!attached || !sameAttachment(makeAttachment(context), attached)) {
      return terminalError(TERMINAL_UNAVAILABLE);
    }
    if (!options.validateAccess) return { success: true, data: { context } };

    let access: Awaited<ReturnType<TerminalControl['validateTerminalAccess']>>;
    try {
      access = await control.validateTerminalAccess(accessIdentity(context));
    } catch {
      return denied('runtime access or billing could not be verified');
    }
    if (!isCurrent(current.epoch)) return unavailableSession();
    if (!access.allowed) {
      if (
        access.reason === 'session_not_attached' ||
        access.reason === 'runtime_not_running' ||
        access.reason === 'runtime_not_ready' ||
        access.reason === 'runtime_changed' ||
        access.reason === 'wrapper_instance_mismatch'
      ) {
        return terminalError(TERMINAL_UNAVAILABLE);
      }
      return denied(access.reason ?? 'runtime access or billing could not be verified');
    }
    const latestAttachment = readAttachedSession();
    if (!latestAttachment || !sameAttachment(makeAttachment(context), latestAttachment)) {
      return terminalError(TERMINAL_UNAVAILABLE);
    }
    return { success: true, data: { context } };
  }

  async function closeWrapperTerminal(
    control: TerminalControl,
    session: SessionRequestIdentity,
    ptyId: string
  ): Promise<boolean> {
    const payload = sessionTerminalClosePayloadSchema.parse({ ptyId });
    try {
      const response = await control.request({
        operation: 'session.terminal.close',
        session,
        payload,
      });
      if (!response.ok) return false;
      const result = sessionTerminalCloseResultSchema.safeParse(response.result);
      return result.success && result.data.success;
    } catch {
      return false;
    }
  }

  function completedCreation(
    operationId: string,
    context: ReadyTerminalContext,
    payload: SessionTerminalCreatePayload
  ): OperationResult<{ pty: WrapperPty }> | undefined {
    const raw = storage.kv.get<unknown>(`${TERMINAL_OPERATION_PREFIX}${operationId}`);
    if (raw === undefined) return undefined;
    const parsed = completedCreationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.operationId !== operationId) {
      return denied('terminal creation operation is invalid');
    }
    const completion = parsed.data;
    const expected: SandboxTerminalRecord = {
      ...makeAttachment(context),
      ptyId: completion.result.pty.id,
      state: 'running',
    };
    const stored = readTerminal(completion.result.pty.id);
    if (
      !sameTerminalIdentity(completion.record, expected) ||
      completion.cols !== payload.cols ||
      completion.rows !== payload.rows ||
      !stored ||
      stored.state !== 'running' ||
      !sameTerminalIdentity(stored, expected)
    ) {
      return denied('terminal creation operation conflicts with its existing identity');
    }
    return { success: true, data: completion.result };
  }

  function creationFingerprint(
    context: ReadyTerminalContext,
    payload: SessionTerminalCreatePayload
  ): string {
    return JSON.stringify([
      context.metadata.identity.userId,
      context.session.sessionId,
      context.session.kiloSessionId,
      context.session.directory,
      context.sandboxId,
      context.wrapperInstanceId,
      context.metadata.identity.orgId ?? null,
      payload.cols ?? null,
      payload.rows ?? null,
    ]);
  }

  async function performCreation(
    context: ReadyTerminalContext,
    payload: SessionTerminalCreatePayload
  ): Promise<OperationResult<{ pty: WrapperPty }>> {
    if (!isCurrent(context.epoch)) return unavailableSession();
    let response: ResponseFrame;
    try {
      response = await context.control.request({
        operation: 'session.terminal.create',
        session: context.session,
        payload,
      });
    } catch {
      return isCurrent(context.epoch) ? terminalError(TERMINAL_UNAVAILABLE) : unavailableSession();
    }

    if (!response.ok) {
      return terminalError(response.error?.message ?? TERMINAL_UNAVAILABLE);
    }
    const result = sessionTerminalCreateResultSchema.safeParse(response.result);
    if (!result.success) return terminalError('Terminal is unavailable');
    const pty = result.data.pty;
    if (
      !isCurrent(context.epoch) ||
      pty.cwd !== context.session.directory ||
      pty.status !== 'running'
    ) {
      await closeWrapperTerminal(context.control, context.session, pty.id);
      return isCurrent(context.epoch)
        ? denied('the wrapper returned an invalid terminal workspace')
        : unavailableSession();
    }

    let status: Awaited<ReturnType<TerminalControl['getStatus']>>;
    try {
      status = await context.control.getStatus();
    } catch {
      await closeWrapperTerminal(context.control, context.session, pty.id);
      return terminalError(TERMINAL_UNAVAILABLE);
    }
    if (
      !isCurrent(context.epoch) ||
      status.physical !== 'running' ||
      status.connection !== 'ready' ||
      status.wrapperInstanceId !== context.wrapperInstanceId
    ) {
      await closeWrapperTerminal(context.control, context.session, pty.id);
      return isCurrent(context.epoch) ? terminalError(TERMINAL_UNAVAILABLE) : unavailableSession();
    }

    const record: SandboxTerminalRecord = {
      ...makeAttachment(context),
      ptyId: pty.id,
      state: 'running',
    };
    const attached = readAttachedSession();
    if (!attached || !sameAttachment(record, attached)) {
      await closeWrapperTerminal(context.control, context.session, pty.id);
      return terminalError(TERMINAL_UNAVAILABLE);
    }
    const existing = readTerminal(pty.id);
    if (existing && !sameTerminalIdentity(existing, record)) {
      await closeWrapperTerminal(context.control, context.session, pty.id);
      return denied('the wrapper returned a terminal owned by another session');
    }
    const completion: CompletedCreation = {
      operationId: payload.operationId,
      record,
      result: result.data,
      ...(payload.cols === undefined ? {} : { cols: payload.cols }),
      ...(payload.rows === undefined ? {} : { rows: payload.rows }),
    };
    storage.transactionSync(() => {
      if (!isCurrent(context.epoch)) return;
      storage.kv.put(`${TERMINAL_PREFIX}${pty.id}`, record);
      storage.kv.put(`${TERMINAL_OPERATION_PREFIX}${payload.operationId}`, completion);
    });
    if (!isCurrent(context.epoch)) {
      await closeWrapperTerminal(context.control, context.session, pty.id);
      return unavailableSession();
    }
    return { success: true, data: result.data };
  }

  async function createTerminal(
    input: TerminalCreationInput = {}
  ): Promise<OperationResult<{ pty: WrapperPty }>> {
    const parsed = sessionTerminalCreatePayloadSchema.safeParse({
      operationId: input.operationId ?? crypto.randomUUID(),
      ...(input.cols === undefined ? {} : { cols: input.cols }),
      ...(input.rows === undefined ? {} : { rows: input.rows }),
    });
    if (!parsed.success) return denied('invalid terminal creation request');
    const current = snapshot();
    if (!current) return unavailableSession();
    if (!isTerminalSessionPlatform(current.metadata.identity.createdOnPlatform)) {
      return denied('terminals are only available for interactive Cloud Agent sessions');
    }

    const ready = await readyContext(current, { validateAccess: true });
    if (!ready.success || !ready.data) return terminalError(ready.error ?? TERMINAL_UNAVAILABLE);
    const context = ready.data.context;
    const completed = completedCreation(parsed.data.operationId, context, parsed.data);
    if (completed) return completed;

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

  async function getTerminal(ptyId: string): Promise<SandboxTerminalRecord | undefined> {
    const current = snapshot();
    if (!current) return undefined;
    const record = readTerminal(ptyId);
    if (!record || !matchesMetadata(record, current.metadata)) return undefined;
    if (record.state === 'ended') return record;
    const attached = readAttachedSession();
    return attached && sameAttachment(record, attached) ? record : undefined;
  }

  async function ownedTerminalContext(
    ptyId: string,
    options: { validateAccess: boolean }
  ): Promise<OperationResult<{ context: ReadyTerminalContext; record: SandboxTerminalRecord }>> {
    const current = snapshot();
    if (!current) return unavailableSession();
    const record = readTerminal(ptyId);
    if (!record || !matchesMetadata(record, current.metadata)) {
      return denied('terminal does not belong to this session');
    }
    if (record.state !== 'running') return terminalError('PTY session ended');
    const ready = await readyContext(current, options);
    if (!ready.success || !ready.data) return terminalError(ready.error ?? TERMINAL_UNAVAILABLE);
    const context = ready.data.context;
    if (record.wrapperInstanceId !== context.wrapperInstanceId) {
      return denied('terminal does not belong to the current runtime');
    }
    const latest = readTerminal(ptyId);
    if (!latest || latest.state !== 'running' || !sameTerminalIdentity(latest, record)) {
      return denied('terminal does not belong to the current runtime');
    }
    return { success: true, data: { context, record: latest } };
  }

  async function resizeTerminal(
    input: TerminalResizeInput = {}
  ): Promise<OperationResult<{ pty: WrapperPty }>> {
    const parsed = sessionTerminalResizePayloadSchema.safeParse(input);
    if (!parsed.success) return denied('invalid terminal resize request');
    const ownership = await ownedTerminalContext(parsed.data.ptyId, { validateAccess: true });
    if (!ownership.success || !ownership.data) {
      return terminalError(ownership.error ?? TERMINAL_UNAVAILABLE);
    }
    const { context, record } = ownership.data;
    if (!isCurrent(context.epoch)) return unavailableSession();
    const current = readTerminal(record.ptyId);
    if (!current || current.state !== 'running' || !sameTerminalIdentity(current, record)) {
      return denied('terminal does not belong to the current runtime');
    }
    let response: ResponseFrame;
    try {
      response = await context.control.request({
        operation: 'session.terminal.resize',
        session: context.session,
        payload: parsed.data,
      });
    } catch {
      return terminalError(TERMINAL_UNAVAILABLE);
    }
    if (!isCurrent(context.epoch)) return unavailableSession();
    const latest = readTerminal(record.ptyId);
    if (!latest || latest.state !== 'running' || !sameTerminalIdentity(latest, record)) {
      return denied('terminal does not belong to the current runtime');
    }
    if (!response.ok) return terminalError(response.error?.message ?? TERMINAL_UNAVAILABLE);
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

  async function closeTerminal(
    input: { ptyId?: string } = {}
  ): Promise<OperationResult<{ success: boolean }>> {
    const parsed = sessionTerminalClosePayloadSchema.safeParse(input);
    if (!parsed.success) return denied('invalid terminal close request');
    const ownership = await ownedTerminalContext(parsed.data.ptyId, { validateAccess: false });
    if (!ownership.success || !ownership.data) {
      return terminalError(ownership.error ?? TERMINAL_UNAVAILABLE);
    }
    const { context, record } = ownership.data;
    if (!isCurrent(context.epoch)) return unavailableSession();
    const closed = await closeWrapperTerminal(context.control, context.session, record.ptyId);
    if (!isCurrent(context.epoch)) return unavailableSession();
    if (!closed) return terminalError('Terminal closure failed; please retry');
    markEnded(record);
    deps.closeTerminalBridge(record.ptyId, 1000, 'PTY session ended');
    return { success: true, data: { success: true } };
  }

  async function requestConnect(
    record: SandboxTerminalRecord,
    input: SessionTerminalConnectPayload
  ): Promise<ResponseFrame> {
    const payload = sessionTerminalConnectPayloadSchema.parse(input);
    if (payload.ptyId !== record.ptyId || payload.ownerId !== record.ownerId) {
      throw new Error(`${TERMINAL_ACCESS_DENIED} terminal connection identity mismatch`);
    }
    const ownership = await ownedTerminalContext(record.ptyId, { validateAccess: true });
    if (!ownership.success || !ownership.data) {
      throw new Error(ownership.error ?? TERMINAL_UNAVAILABLE);
    }
    const { context, record: current } = ownership.data;
    if (
      !isCurrent(context.epoch) ||
      current.state !== 'running' ||
      !sameTerminalIdentity(current, record)
    ) {
      throw new Error(`${TERMINAL_ACCESS_DENIED} terminal runtime mismatch`);
    }
    const response = await context.control.request({
      operation: 'session.terminal.connect',
      session: context.session,
      payload,
    });
    if (!isCurrent(context.epoch)) {
      throw new Error(`${TERMINAL_ACCESS_DENIED} session access revoked`);
    }
    if (response.ok && !sessionTerminalConnectResultSchema.safeParse(response.result).success) {
      throw new Error('Terminal connection response is invalid');
    }
    return response;
  }

  async function reportActivity(record: SandboxTerminalRecord): Promise<void> {
    const current = snapshot();
    if (!current || !matchesMetadata(record, current.metadata)) return;
    const stored = readTerminal(record.ptyId);
    if (!stored || stored.state !== 'running' || !sameTerminalIdentity(stored, record)) return;
    const sandboxId = current.metadata.workspace?.sandboxId;
    if (!sandboxId || sandboxId !== record.sandboxId) return;
    try {
      const result = await deps.getControl(sandboxId).recordTerminalActivity({
        sessionId: record.sessionId,
        ownerId: record.ownerId,
        wrapperInstanceId: record.wrapperInstanceId,
        ...(record.organizationId ? { organizationId: record.organizationId } : {}),
        ...(current.metadata.identity.botId ? { botId: current.metadata.identity.botId } : {}),
      });
      const latest = readTerminal(record.ptyId);
      if (
        isCurrent(current.epoch) &&
        latest?.state === 'running' &&
        sameTerminalIdentity(latest, record) &&
        !result.allowed
      ) {
        deps.closeTerminalBridge(record.ptyId, 1000, 'session access revoked');
      }
    } catch {
      const latest = readTerminal(record.ptyId);
      if (
        isCurrent(current.epoch) &&
        latest?.state === 'running' &&
        sameTerminalIdentity(latest, record)
      ) {
        deps.closeTerminalBridge(record.ptyId, 1011, 'Terminal unavailable');
      }
    }
  }

  function recordAttachment(input: {
    metadata: SessionMetadata;
    sandboxId: string;
    wrapperInstanceId?: string;
    epoch: number;
  }): boolean {
    if (!isCurrent(input.epoch)) return false;
    const wrapperInstance = wrapperInstanceIdSchema.safeParse(input.wrapperInstanceId);
    if (!wrapperInstance.success || !input.metadata.auth.kiloSessionId) {
      storage.kv.delete(ATTACHED_SESSION_KEY);
      return false;
    }
    const attachment: AttachedSession = {
      ownerId: input.metadata.identity.userId,
      sessionId: input.metadata.identity.sessionId,
      kiloSessionId: input.metadata.auth.kiloSessionId,
      directory: deps.getDirectory(input.metadata),
      sandboxId: input.sandboxId,
      wrapperInstanceId: wrapperInstance.data,
      ...(input.metadata.identity.orgId ? { organizationId: input.metadata.identity.orgId } : {}),
    };
    storage.kv.put(ATTACHED_SESSION_KEY, attachment);
    return true;
  }

  function endTerminals(predicate: (record: SandboxTerminalRecord) => boolean) {
    const records: SandboxTerminalRecord[] = [];
    for (const [, raw] of storage.kv.list<unknown>({ prefix: TERMINAL_PREFIX })) {
      const parsed = terminalRecordSchema.safeParse(raw);
      if (!parsed.success || parsed.data.state !== 'running' || !predicate(parsed.data)) continue;
      records.push(parsed.data);
    }
    for (const record of records) markEnded(record);
    return records;
  }

  function beginFence(state: LifecycleFence['state'], metadata: SessionMetadata | null) {
    const previous =
      storage.kv.get(SANDBOX_SESSION_LIFECYCLE_KEY) === undefined ? undefined : readFence();
    if (previous?.state === 'deleted') return previous;
    const fence: LifecycleFence = {
      epoch: (previous?.epoch ?? 0) + 1,
      state,
      ...(metadata?.workspace?.sandboxId
        ? { sandboxId: metadata.workspace.sandboxId }
        : previous?.sandboxId
          ? { sandboxId: previous.sandboxId }
          : {}),
    };
    storage.kv.put(SANDBOX_SESSION_LIFECYCLE_KEY, fence);
    return fence;
  }

  function beginRevocation(metadata: SessionMetadata): SandboxTerminalRecord[] {
    beginFence('revoked', metadata);
    deps.closeAllBridges(1000, 'session access revoked');
    const records = endTerminals(() => true);
    storage.kv.delete(ATTACHED_SESSION_KEY);
    return records;
  }

  function beginDeletion(metadata: SessionMetadata | null): SandboxTerminalRecord[] {
    beginFence('deleted', metadata);
    deps.closeAllBridges(1000, 'session access revoked');
    const records = endTerminals(() => true);
    storage.kv.delete(ATTACHED_SESSION_KEY);
    return records;
  }

  async function cleanupSession(
    metadata: SessionMetadata | null,
    records: readonly SandboxTerminalRecord[]
  ): Promise<void> {
    const sandboxId = metadata?.workspace?.sandboxId ?? readFence()?.sandboxId;
    const sessionId = metadata?.identity.sessionId ?? records[0]?.sessionId ?? deps.getSessionId();
    if (!sandboxId || !sessionId) return;
    const control = deps.getControl(sandboxId);
    try {
      for (const record of records) {
        await closeWrapperTerminal(
          control,
          {
            sessionId: record.sessionId,
            kiloSessionId: record.kiloSessionId,
            directory: record.directory,
          },
          record.ptyId
        );
      }
    } finally {
      await control.detachSession(sessionId);
    }
  }

  function invalidateRuntime(input: {
    sandboxId: string;
    wrapperInstanceId: string;
    confirmed: boolean;
  }): void {
    const metadata = getStoredMetadata();
    if (
      !metadata ||
      metadata.workspace?.sandboxId !== input.sandboxId ||
      !wrapperInstanceIdSchema.safeParse(input.wrapperInstanceId).success
    ) {
      return;
    }
    deps.closeRuntimeBridges(
      input.wrapperInstanceId,
      input.confirmed ? 1000 : 1011,
      input.confirmed ? 'PTY session ended' : 'Terminal unavailable'
    );
    if (!input.confirmed) return;
    endTerminals(
      record =>
        record.sandboxId === input.sandboxId && record.wrapperInstanceId === input.wrapperInstanceId
    );
    const attached = readAttachedSession();
    if (
      attached?.sandboxId === input.sandboxId &&
      attached.wrapperInstanceId === input.wrapperInstanceId
    ) {
      storage.kv.delete(ATTACHED_SESSION_KEY);
    }
  }

  function clearAttachedWrapperAfterRecovery(wrapperInstanceId: string): boolean {
    const attached = readAttachedSession();
    if (!attached || attached.wrapperInstanceId !== wrapperInstanceId) return false;
    for (const [, raw] of storage.kv.list<unknown>({ prefix: TERMINAL_PREFIX })) {
      const terminal = terminalRecordSchema.safeParse(raw);
      if (
        terminal.success &&
        terminal.data.state === 'running' &&
        terminal.data.wrapperInstanceId === wrapperInstanceId
      ) {
        return false;
      }
    }
    storage.kv.delete(ATTACHED_SESSION_KEY);
    return true;
  }

  function purgeDeletedState(): void {
    if (readFence()?.state !== 'deleted') return;
    const keys = Array.from(storage.kv.list<unknown>(), ([key]) => key);
    for (const key of keys) {
      if (key !== SANDBOX_SESSION_LIFECYCLE_KEY) storage.kv.delete(key);
    }
  }

  return {
    beginDeletion,
    beginRevocation,
    clearAttachedWrapperAfterRecovery,
    captureEpoch: () => snapshot()?.epoch ?? null,
    cleanupSession,
    closeTerminal,
    createTerminal,
    getAttachedWrapperInstanceId,
    getStoredMetadata,
    getTerminal,
    invalidateRuntime,
    isBlocked: () => readFence() !== undefined,
    isCurrent,
    isDeleted: () => readFence()?.state === 'deleted',
    markEnded: async (record: SandboxTerminalRecord) => markEnded(record),
    purgeDeletedState,
    recordAttachment,
    reportActivity,
    requestConnect,
    resizeTerminal,
  };
}
