import { describe, expect, it, vi } from 'vitest';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import type {
  SandboxTerminalAccessInput,
  SandboxTerminalAccessResult,
} from '../sandbox-control/terminal-billing.js';
import { parseSessionMetadata, serializeSessionMetadata } from '../persistence/session-metadata.js';
import {
  sessionTerminalClosePayloadSchema,
  sessionTerminalCreatePayloadSchema,
  sessionTerminalResizePayloadSchema,
  type ResponseFrame,
} from '../shared/sandbox-control-protocol.js';
import {
  createSandboxTerminalLifecycle,
  SANDBOX_SESSION_LIFECYCLE_KEY,
  SANDBOX_SESSION_METADATA_KEY,
} from './terminal-lifecycle.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';
const WRAPPER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const REPLACEMENT_INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const FIRST_OPERATION_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const DIRECTORY = '/workspace/interactive-session';

function memoryStorage() {
  const values = new Map<string, unknown>();
  const kv: SyncKvStorage = {
    get: <T = unknown>(key: string): T | undefined => values.get(key) as T | undefined,
    put: <T>(key: string, value: T): void => {
      values.set(key, value);
    },
    delete: (key: string): boolean => values.delete(key),
    list: <T = unknown>(options?: SyncKvListOptions): Iterable<[string, T]> =>
      [...values.entries()]
        .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
        .map(([key, value]) => [key, value as T]),
  };
  const storage = {
    kv,
    transactionSync: <T>(callback: () => T): T => callback(),
  } as DurableObjectStorage;
  return { storage, values };
}

function response(result: unknown): ResponseFrame {
  return { type: 'response', requestId: 'request_1', ok: true, result };
}

function createFixture(
  options: {
    attached?: boolean;
    platform?: string;
    containment?: boolean;
    organizationId?: string;
    botId?: string;
    terminalCapable?: boolean;
  } = {}
) {
  const { storage, values } = memoryStorage();
  const metadata = parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: SESSION_ID,
      userId: 'user_1',
      createdOnPlatform: options.platform ?? 'cloud-agent-web',
      ...(options.organizationId ? { orgId: options.organizationId } : {}),
      ...(options.botId ? { botId: options.botId } : {}),
    },
    auth: { kiloSessionId: 'kilo_session_1' },
    agent: { mode: 'code', model: 'test-model' },
    workspace: {
      sandboxId: SANDBOX_ID,
      sandboxProvider: 'cloudflare',
      ...(options.containment
        ? {
            credentialContainment: {
              github: true,
              gitlab: false,
              bitbucket: false,
              kilocode: false,
            },
          }
        : {}),
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
  storage.kv.put(SANDBOX_SESSION_METADATA_KEY, serializeSessionMetadata(metadata));

  let wrapperInstanceId = options.terminalCapable === false ? undefined : WRAPPER_INSTANCE_ID;
  let nextPtyId = 'pty_1';
  const pty = (id: string) => ({
    id,
    title: 'Terminal',
    command: '/bin/sh',
    args: [],
    cwd: DIRECTORY,
    status: 'running' as const,
    pid: 1234,
  });
  const request = vi.fn(async (input: SandboxControlOutboundRequest): Promise<ResponseFrame> => {
    if (input.operation === 'session.terminal.create') {
      sessionTerminalCreatePayloadSchema.parse(input.payload);
      return response({ pty: pty(nextPtyId) });
    }
    if (input.operation === 'session.terminal.resize') {
      const parsed = sessionTerminalResizePayloadSchema.parse(input.payload);
      return response({ pty: pty(parsed.ptyId) });
    }
    if (input.operation === 'session.terminal.close') {
      sessionTerminalClosePayloadSchema.parse(input.payload);
      return response({ success: true });
    }
    if (input.operation === 'session.detach') return response({ detached: true });
    return response({ connected: true });
  });
  const control = {
    ensureReady: vi.fn(async () => ({
      connection: 'ready' as const,
      physical: 'running' as const,
    })),
    getStatus: vi.fn(async () => ({
      connection: 'ready' as const,
      physical: 'running' as const,
      ...(wrapperInstanceId ? { wrapperInstanceId } : {}),
    })),
    attachSession: vi.fn(async () => ({})),
    detachSession: vi.fn(async () => ({ existed: true })),
    validateTerminalAccess: vi.fn(
      async (_input: SandboxTerminalAccessInput): Promise<SandboxTerminalAccessResult> => ({
        allowed: true,
      })
    ),
    recordTerminalActivity: vi.fn(
      async (_input: SandboxTerminalAccessInput): Promise<SandboxTerminalAccessResult> => ({
        allowed: true,
      })
    ),
    request,
  };
  const closeTerminalBridge = vi.fn();
  const closeAllBridges = vi.fn();
  const closeRuntimeBridges = vi.fn();
  const lifecycle = createSandboxTerminalLifecycle({
    state: { storage },
    getSessionId: () => SESSION_ID,
    getControl: () => control,
    getDirectory: () => DIRECTORY,
    closeTerminalBridge,
    closeAllBridges,
    closeRuntimeBridges,
  });

  function attachCurrentRuntime(): boolean {
    return lifecycle.recordAttachment({
      metadata,
      sandboxId: SANDBOX_ID,
      wrapperInstanceId,
      epoch: lifecycle.captureEpoch() ?? -1,
    });
  }

  if (options.attached !== false && wrapperInstanceId) attachCurrentRuntime();

  return {
    storage,
    values,
    metadata,
    control,
    lifecycle,
    closeTerminalBridge,
    closeAllBridges,
    closeRuntimeBridges,
    attachCurrentRuntime,
    setWrapperInstanceId: (value: string | undefined) => {
      wrapperInstanceId = value;
    },
    setPtyId: (value: string) => {
      nextPtyId = value;
    },
  };
}

describe('SandboxSession terminal lifecycle', () => {
  it('requires successful runtime-bound session attachment without starting compute', async () => {
    const fixture = createFixture({ attached: false });

    await expect(
      fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID })
    ).resolves.toEqual({
      success: false,
      error: 'Terminal unavailable until the workspace is prepared',
    });
    expect(fixture.control.ensureReady).not.toHaveBeenCalled();
    expect(fixture.control.request).not.toHaveBeenCalled();

    expect(fixture.attachCurrentRuntime()).toBe(true);
    await expect(
      fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID })
    ).resolves.toMatchObject({
      success: true,
      data: { pty: { id: 'pty_1' } },
    });
  });

  it.each([
    [{ platform: 'code-review' }, 'interactive Cloud Agent sessions'],
    [{ containment: true }, 'credential containment'],
    [{ terminalCapable: false }, 'does not support terminals'],
  ])('permanently rejects unsupported terminal access', async (options, reason) => {
    const fixture = createFixture(options);

    await expect(
      fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(new RegExp(`^Terminal access denied:.*${reason}`)),
    });
    expect(fixture.control.request).not.toHaveBeenCalled();
    expect(fixture.control.ensureReady).not.toHaveBeenCalled();
  });

  it('verifies trusted billing attribution before creating a shell', async () => {
    const fixture = createFixture({ organizationId: 'org_1', botId: 'bot_1' });
    fixture.control.validateTerminalAccess.mockResolvedValue({
      allowed: false,
      reason: 'billing_context_unavailable',
    });

    await expect(
      fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID })
    ).resolves.toEqual({
      success: false,
      error: 'Terminal access denied: billing_context_unavailable',
    });
    expect(fixture.control.validateTerminalAccess).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      ownerId: 'user_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
      organizationId: 'org_1',
      botId: 'bot_1',
    });
    expect(fixture.control.request).not.toHaveBeenCalled();
  });

  it('keeps transient runtime changes retryable without treating them as billing denial', async () => {
    const fixture = createFixture();
    fixture.control.validateTerminalAccess.mockResolvedValue({
      allowed: false,
      reason: 'runtime_changed',
    });

    await expect(
      fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID })
    ).resolves.toEqual({
      success: false,
      error: 'Terminal unavailable until the workspace is prepared',
    });
    expect(fixture.control.request).not.toHaveBeenCalled();
  });

  it('persists exact terminal ownership and reuses completed creation operations', async () => {
    const fixture = createFixture({ organizationId: 'org_1' });
    const input = { operationId: FIRST_OPERATION_ID, cols: 80, rows: 24 };

    const first = await fixture.lifecycle.createTerminal(input);
    const repeated = await fixture.lifecycle.createTerminal(input);

    expect(first).toEqual(repeated);
    expect(fixture.control.request).toHaveBeenCalledOnce();
    expect(fixture.values.get('terminal:pty_1')).toEqual({
      ptyId: 'pty_1',
      ownerId: 'user_1',
      sessionId: SESSION_ID,
      kiloSessionId: 'kilo_session_1',
      directory: DIRECTORY,
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
      organizationId: 'org_1',
      state: 'running',
    });
    await expect(
      fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID, cols: 120, rows: 40 })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/^Terminal access denied:.*operation conflicts/),
    });
    expect(fixture.control.request).toHaveBeenCalledOnce();
  });

  it('joins concurrent creation retries without allocating a second shell', async () => {
    const fixture = createFixture();
    let finishCreation: (frame: ResponseFrame) => void = () => undefined;
    let notifyCreationStarted: () => void = () => undefined;
    const creationStarted = new Promise<void>(resolve => {
      notifyCreationStarted = resolve;
    });
    const delayedCreation = new Promise<ResponseFrame>(resolve => {
      finishCreation = resolve;
    });
    fixture.control.request.mockImplementationOnce(async () => {
      notifyCreationStarted();
      return delayedCreation;
    });

    const first = fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID });
    await creationStarted;
    const repeated = fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID });
    finishCreation(
      response({
        pty: {
          id: 'pty_1',
          title: 'Terminal',
          command: '/bin/sh',
          args: [],
          cwd: DIRECTORY,
          status: 'running',
          pid: 1234,
        },
      })
    );

    const [firstResult, repeatedResult] = await Promise.all([first, repeated]);
    expect(firstResult).toEqual(repeatedResult);
    expect(fixture.control.request).toHaveBeenCalledOnce();
  });

  it('rejects persisted terminals whose owner no longer matches session metadata', async () => {
    const fixture = createFixture();
    await fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID });
    const stored = fixture.values.get('terminal:pty_1');
    if (typeof stored !== 'object' || stored === null) throw new Error('Terminal record missing');
    fixture.values.set('terminal:pty_1', { ...stored, ownerId: 'user_other' });

    await expect(
      fixture.lifecycle.resizeTerminal({ ptyId: 'pty_1', cols: 100, rows: 30 })
    ).resolves.toEqual({
      success: false,
      error: 'Terminal access denied: terminal does not belong to this session',
    });
    expect(fixture.control.request).toHaveBeenCalledOnce();
  });

  it('ends the terminal only after the wrapper confirms PTY deletion', async () => {
    const fixture = createFixture();
    await fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID });
    let finishClose: (frame: ResponseFrame) => void = () => undefined;
    let notifyCloseStarted: () => void = () => undefined;
    const closeStarted = new Promise<void>(resolve => {
      notifyCloseStarted = resolve;
    });
    const delayedClose = new Promise<ResponseFrame>(resolve => {
      finishClose = resolve;
    });
    fixture.control.request.mockImplementationOnce(async () => {
      notifyCloseStarted();
      return delayedClose;
    });

    const pending = fixture.lifecycle.closeTerminal({ ptyId: 'pty_1' });
    await closeStarted;
    expect(fixture.values.get('terminal:pty_1')).toMatchObject({ state: 'running' });
    expect(fixture.values.has(`terminal_operation:${FIRST_OPERATION_ID}`)).toBe(true);
    expect(fixture.closeTerminalBridge).not.toHaveBeenCalled();

    finishClose(response({ success: true }));
    await expect(pending).resolves.toEqual({ success: true, data: { success: true } });
    expect(fixture.closeTerminalBridge).toHaveBeenCalledWith('pty_1', 1000, 'PTY session ended');
    expect(fixture.values.get('terminal:pty_1')).toMatchObject({ state: 'ended' });
    expect(fixture.values.has(`terminal_operation:${FIRST_OPERATION_ID}`)).toBe(false);
    expect(fixture.control.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'session.terminal.close',
        payload: { ptyId: 'pty_1' },
      })
    );
  });

  it.each([
    { failure: 'a rejected control request', result: new Error('wrapper unavailable') },
    {
      failure: 'an unsuccessful control response',
      result: {
        type: 'response',
        requestId: 'request_1',
        ok: false,
        error: { code: 'not_ready', message: 'Wrapper unavailable', retryable: true },
      } satisfies ResponseFrame,
    },
    { failure: 'failed PTY deletion', result: response({ success: false }) },
    { failure: 'an invalid close result', result: response({ success: 'true' }) },
  ])('preserves durable ownership for a close retry after $failure', async ({ result }) => {
    const fixture = createFixture();
    await fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID });
    if (result instanceof Error) {
      fixture.control.request.mockRejectedValueOnce(result);
    } else {
      fixture.control.request.mockResolvedValueOnce(result);
    }

    await expect(fixture.lifecycle.closeTerminal({ ptyId: 'pty_1' })).resolves.toEqual({
      success: false,
      error: 'Terminal closure failed; please retry',
    });
    expect(fixture.closeTerminalBridge).not.toHaveBeenCalled();
    expect(fixture.values.get('terminal:pty_1')).toMatchObject({ state: 'running' });
    expect(fixture.values.has(`terminal_operation:${FIRST_OPERATION_ID}`)).toBe(true);

    const restarted = createSandboxTerminalLifecycle({
      state: { storage: fixture.storage },
      getSessionId: () => SESSION_ID,
      getControl: () => fixture.control,
      getDirectory: () => DIRECTORY,
      closeTerminalBridge: fixture.closeTerminalBridge,
      closeAllBridges: fixture.closeAllBridges,
      closeRuntimeBridges: fixture.closeRuntimeBridges,
    });
    await expect(restarted.closeTerminal({ ptyId: 'pty_1' })).resolves.toEqual({
      success: true,
      data: { success: true },
    });
    expect(fixture.closeTerminalBridge).toHaveBeenCalledWith('pty_1', 1000, 'PTY session ended');
    expect(fixture.values.get('terminal:pty_1')).toMatchObject({ state: 'ended' });
    expect(fixture.values.has(`terminal_operation:${FIRST_OPERATION_ID}`)).toBe(false);
  });

  it('does not restore terminal records when close finishes after session deletion', async () => {
    const fixture = createFixture();
    await fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID });
    fixture.control.request.mockImplementationOnce(async () => {
      fixture.lifecycle.beginDeletion(fixture.metadata);
      fixture.lifecycle.purgeDeletedState();
      return response({ success: true });
    });

    await expect(fixture.lifecycle.closeTerminal({ ptyId: 'pty_1' })).resolves.toEqual({
      success: false,
      error: 'Session not found',
    });
    expect([...fixture.values.keys()]).toEqual([SANDBOX_SESSION_LIFECYCLE_KEY]);
    expect(fixture.closeTerminalBridge).not.toHaveBeenCalled();
  });

  it('invalidates only confirmed terminals belonging to the requested runtime', async () => {
    const fixture = createFixture();
    await fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID });
    fixture.setWrapperInstanceId(REPLACEMENT_INSTANCE_ID);
    fixture.setPtyId('pty_2');
    expect(fixture.attachCurrentRuntime()).toBe(true);
    await fixture.lifecycle.createTerminal({ operationId: SECOND_OPERATION_ID });

    fixture.lifecycle.invalidateRuntime({
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
      confirmed: false,
    });
    expect(fixture.values.get('terminal:pty_1')).toMatchObject({ state: 'running' });
    expect(fixture.closeRuntimeBridges).toHaveBeenLastCalledWith(
      WRAPPER_INSTANCE_ID,
      1011,
      'Terminal unavailable'
    );

    fixture.lifecycle.invalidateRuntime({
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
      confirmed: true,
    });
    expect(fixture.values.get('terminal:pty_1')).toMatchObject({ state: 'ended' });
    expect(fixture.values.get('terminal:pty_2')).toMatchObject({ state: 'running' });
    expect(fixture.values.has(`terminal_operation:${FIRST_OPERATION_ID}`)).toBe(false);
    expect(fixture.values.has(`terminal_operation:${SECOND_OPERATION_ID}`)).toBe(true);
    expect(fixture.closeRuntimeBridges).toHaveBeenLastCalledWith(
      WRAPPER_INSTANCE_ID,
      1000,
      'PTY session ended'
    );
  });

  it('compensates PTY creation that completes after a durable deletion fence', async () => {
    const fixture = createFixture();
    let finishCreation: (frame: ResponseFrame) => void = () => undefined;
    let notifyCreationStarted: () => void = () => undefined;
    const creationStarted = new Promise<void>(resolve => {
      notifyCreationStarted = resolve;
    });
    const delayedCreation = new Promise<ResponseFrame>(resolve => {
      finishCreation = resolve;
    });
    fixture.control.request.mockImplementationOnce(async () => {
      notifyCreationStarted();
      return delayedCreation;
    });

    const pending = fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID });
    await creationStarted;
    const records = fixture.lifecycle.beginDeletion(fixture.metadata);
    expect(records).toEqual([]);
    expect(fixture.values.get(SANDBOX_SESSION_LIFECYCLE_KEY)).toMatchObject({
      state: 'deleted',
      sandboxId: SANDBOX_ID,
    });
    expect(fixture.closeAllBridges).toHaveBeenCalledWith(1000, 'session access revoked');

    finishCreation(
      response({
        pty: {
          id: 'pty_1',
          title: 'Terminal',
          command: '/bin/sh',
          args: [],
          cwd: DIRECTORY,
          status: 'running',
          pid: 1234,
        },
      })
    );
    await expect(pending).resolves.toEqual({ success: false, error: 'Session not found' });
    expect(fixture.control.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'session.terminal.close' })
    );
    expect(fixture.values.has('terminal:pty_1')).toBe(false);
    expect(fixture.values.has(`terminal_operation:${FIRST_OPERATION_ID}`)).toBe(false);

    await fixture.lifecycle.cleanupSession(fixture.metadata, records);
    expect(fixture.control.detachSession).toHaveBeenCalledWith(SESSION_ID);
    fixture.lifecycle.purgeDeletedState();
    expect([...fixture.values.keys()]).toEqual([SANDBOX_SESSION_LIFECYCLE_KEY]);
    expect(fixture.lifecycle.captureEpoch()).toBeNull();
  });

  it('detaches the durable session route even when wrapper detachment fails', async () => {
    const fixture = createFixture({ organizationId: 'org_1' });
    await fixture.lifecycle.createTerminal({ operationId: FIRST_OPERATION_ID });
    const records = fixture.lifecycle.beginRevocation(fixture.metadata);
    fixture.control.request.mockRejectedValue(new Error('wrapper unavailable'));

    await fixture.lifecycle.cleanupSession(fixture.metadata, records);

    expect(fixture.control.detachSession).toHaveBeenCalledWith(SESSION_ID);
    expect(fixture.values.get('terminal:pty_1')).toMatchObject({ state: 'ended' });
    expect(fixture.values.has(`terminal_operation:${FIRST_OPERATION_ID}`)).toBe(false);
    await expect(
      fixture.lifecycle.createTerminal({ operationId: SECOND_OPERATION_ID })
    ).resolves.toEqual({
      success: false,
      error: 'Terminal access denied: session access revoked',
    });
  });
});
