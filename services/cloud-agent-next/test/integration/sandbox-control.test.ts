import {
  SELF,
  abortAllDurableObjects,
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceDestroyControlPlaneSandbox } from '../../src/container-usage-context.js';
import type {
  AgentSelectionOverride,
  SubmittedSessionMessageRequest,
} from '../../src/execution/types.js';
import {
  serializeSessionMetadata,
  type SessionMetadata,
} from '../../src/persistence/session-metadata.js';
import { throwAdmissionError } from '../../src/session/queue-message.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
} from '../../src/sandbox-control/credential.js';
import {
  createCloudflareProviderAdapter,
  type CloudflareSandboxHandle,
} from '../../src/sandbox-control/cloudflare-provider.js';
import { DEADLINE_MS, type DeadlineId } from '../../src/sandbox-control/deadlines.js';
import {
  loadDeadlines,
  loadRouteTable,
  saveDeadlines,
  savePhysicalRecord,
  saveRouteTable,
} from '../../src/sandbox-control/durable-state.js';
import { beginStop } from '../../src/sandbox-control/physical-lifecycle.js';
import type { ProviderAdapter } from '../../src/sandbox-control/provider.js';
import { applyReportedSessionState } from '../../src/sandbox-control/session-routes.js';
import { SESSION_DELIVERY_TIMEOUT_MS } from '../../src/sandbox-session/control-dispatch.js';
import {
  createSessionMessageRecord,
  type SessionMessageRecord,
} from '../../src/sandbox-session/session-message-queue.js';
import { getPreparationSnapshots } from '../../src/session/preparation-history.js';
import { createEventQueries } from '../../src/session/queries/index.js';
import {
  requestFrameSchema,
  sessionPromptPayloadSchema,
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_AUTO_PONG,
  type RequestFrame,
  type ResponseFrame,
} from '../../src/shared/sandbox-control-protocol.js';

const sandboxId = 'sbx_control_smoke';

async function seedCredential(credential: string, id = sandboxId): Promise<void> {
  const stub = env.SANDBOX_CONTROL.getByName(id);
  await runInDurableObject(stub, async instance => {
    if ((await instance.getPhysicalRecord()).state === 'stopped') {
      await instance.claimCreate(`intent_${id}`);
    }
    await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
  });
}

async function connect(credential: string, id = sandboxId): Promise<WebSocket> {
  const response = await SELF.fetch(`http://worker.test/sandbox-control/${id}`, {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${credential}`,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
  }
  response.webSocket.accept();
  return response.webSocket;
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };
    const onMessage = (event: MessageEvent) => {
      cleanup();
      resolve(typeof event.data === 'string' ? event.data : String(event.data));
    };
    const onError = () => {
      cleanup();
      reject(new Error('sandbox control websocket error'));
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`sandbox control websocket closed: ${event.code}`));
    };
    ws.addEventListener('message', onMessage, { once: true });
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', onClose, { once: true });
  });
}

function sendHello(
  ws: WebSocket,
  requestId: string,
  identity: { providerInstanceId?: string; wrapperInstanceId?: string } = {}
): void {
  ws.send(
    JSON.stringify({
      type: 'request',
      requestId,
      operation: 'sandbox.hello',
      payload: {
        protocolVersion: 1,
        providerInstanceId: identity.providerInstanceId ?? 'inst_1',
        ...(identity.wrapperInstanceId ? { wrapperInstanceId: identity.wrapperInstanceId } : {}),
      },
    })
  );
}

async function completeHello(
  ws: WebSocket,
  requestId: string,
  identity: { providerInstanceId?: string; wrapperInstanceId?: string } = {}
): Promise<void> {
  sendHello(ws, requestId, identity);
  await expect(nextMessage(ws)).resolves.toBe(
    JSON.stringify({
      type: 'response',
      requestId,
      ok: true,
      result: { protocolVersion: 1, handshakeComplete: true },
    })
  );
  const status = JSON.parse(await nextMessage(ws)) as {
    type: string;
    requestId: string;
    operation: string;
  };
  expect(status).toMatchObject({ type: 'request', operation: 'sandbox.status' });
  ws.send(
    JSON.stringify({
      type: 'response',
      requestId: status.requestId,
      ok: true,
    })
  );
}

type TerminalRuntimeFixture = {
  sandboxId: `usr-${string}`;
  ownerId: string;
  sessionId: `workspace_${string}`;
  wrapperInstanceId?: string;
};

async function initializeTerminalRuntime(fixture: TerminalRuntimeFixture) {
  const credential = generateSandboxCredential();
  await seedCredential(credential, fixture.sandboxId);
  const control = env.SANDBOX_CONTROL.getByName(fixture.sandboxId);
  const provider = await installProvider(control, fixture.sandboxId);
  await runInDurableObject(control, async instance => {
    await instance.initializeOwner(fixture.ownerId);
    await instance.attachSession({
      sessionId: fixture.sessionId,
      kiloSessionId: 'kilo_terminal',
      directory: '/workspace/terminal',
      ownerId: fixture.ownerId,
    });
  });
  const socket = await connect(credential, fixture.sandboxId);
  await completeHello(socket, `hello_${fixture.sandboxId}`, {
    providerInstanceId: fixture.sandboxId,
    ...(fixture.wrapperInstanceId ? { wrapperInstanceId: fixture.wrapperInstanceId } : {}),
  });
  return { control, credential, socket, ...provider };
}

function signalWrapperReady(socket: WebSocket): void {
  socket.send(
    JSON.stringify({
      type: 'event',
      event: 'sandbox.ready',
      payload: { kiloReady: true, globalFeedAttached: true },
    })
  );
}

async function waitForWrapperReady(fixture: TerminalRuntimeFixture): Promise<void> {
  const control = env.SANDBOX_CONTROL.getByName(fixture.sandboxId);
  await vi.waitFor(async () => {
    const status = await runInDurableObject(control, instance => instance.getStatus());
    expect(status).toMatchObject({
      connection: 'ready',
      ...(fixture.wrapperInstanceId ? { wrapperInstanceId: fixture.wrapperInstanceId } : {}),
    });
  });
}

async function seedTerminalSession(fixture: TerminalRuntimeFixture, ptyId = 'pty_original') {
  if (!fixture.wrapperInstanceId) throw new Error('Terminal fixture requires wrapper identity');
  const session = env.SANDBOX_SESSION.getByName(`${fixture.ownerId}:${fixture.sessionId}`);
  await runInDurableObject(session, async (instance, state) => {
    await instance.registerSession({
      identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
      auth: { kiloSessionId: 'kilo_terminal' },
      agent: {},
      workspace: { sandboxId: fixture.sandboxId },
    });
    const attachment = {
      ownerId: fixture.ownerId,
      sessionId: fixture.sessionId,
      kiloSessionId: 'kilo_terminal',
      directory: '/workspace/terminal',
      sandboxId: fixture.sandboxId,
      wrapperInstanceId: fixture.wrapperInstanceId,
    };
    state.storage.kv.put('terminal_attached_session', attachment);
    state.storage.kv.put(`terminal:${ptyId}`, { ...attachment, ptyId, state: 'running' });
  });
  return session;
}

function acceptControlRequest(socket: WebSocket, request: RequestFrame): void {
  let result: unknown;
  switch (request.operation) {
    case 'session.attach':
      result = { attached: true };
      break;
    case 'session.prompt':
      result = {
        messageId: sessionPromptPayloadSchema.parse(request.payload).messageId,
        status: 'accepted',
      };
      break;
    case 'session.abort':
      result = { status: 'aborted' };
      break;
    case 'session.detach':
      result = { detached: true };
      break;
    case 'session.sync':
      result = { status: { type: 'busy' }, questions: [], permissions: [] };
      break;
    default:
      throw new Error(`Unexpected control request: ${request.operation}`);
  }
  socket.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true, result }));
}

function captureAndAcceptControlRequests(
  socket: WebSocket,
  hold?: (request: RequestFrame) => boolean
): RequestFrame[] {
  const requests: RequestFrame[] = [];
  socket.addEventListener('message', event => {
    const request = requestFrameSchema.parse(JSON.parse(String(event.data)));
    requests.push(request);
    if (!hold?.(request)) acceptControlRequest(socket, request);
  });
  return requests;
}

async function installProvider(
  control: ReturnType<typeof env.SANDBOX_CONTROL.getByName>,
  initialRef?: string
) {
  const allocations = new Set(initialRef ? [initialRef] : []);
  const provider = {
    resumable: false,
    ensureBillingAdmission: vi.fn<ProviderAdapter['ensureBillingAdmission']>(async () => undefined),
    create: vi.fn<ProviderAdapter['create']>(async intent => {
      if (!intent.allocationName) throw new Error('Expected a persisted allocation name');
      allocations.add(intent.allocationName);
      return { providerRef: intent.allocationName };
    }),
    launch: vi.fn<ProviderAdapter['launch']>(async () => undefined),
    observe: vi.fn<ProviderAdapter['observe']>(async (ref, intent) => {
      const providerRef = ref ?? intent?.allocationName;
      return {
        status: providerRef && allocations.has(providerRef) ? 'active' : 'terminal',
        ...(providerRef ? { providerRef } : {}),
      };
    }),
    stop: vi.fn<ProviderAdapter['stop']>(async ref => {
      if (ref) allocations.delete(ref);
      return 'terminal';
    }),
    ensureLeaseAtLeast: vi.fn<ProviderAdapter['ensureLeaseAtLeast']>(async () => undefined),
    logs: vi.fn<ProviderAdapter['logs']>(async () => ''),
  } satisfies ProviderAdapter;
  await runInDurableObject(control, instance => {
    const prototype = Object.getPrototypeOf(instance) as {
      createProviderAdapter: () => ProviderAdapter;
    };
    vi.spyOn(prototype, 'createProviderAdapter').mockReturnValue(provider);
    Object.assign(instance, { provider });
  });
  return { provider, allocations };
}

async function fireControlDeadline(
  control: ReturnType<typeof env.SANDBOX_CONTROL.getByName>,
  id: DeadlineId
): Promise<void> {
  await runInDurableObject(control, async (_instance, state) => {
    const deadlines = await loadDeadlines(state.storage);
    expect(deadlines[id]).toEqual(expect.any(Number));
    await saveDeadlines(state.storage, { ...deadlines, [id]: Date.now() });
  });
  await expect(runDurableObjectAlarm(control)).resolves.toBe(true);
}

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe('SandboxControl in the Workers runtime', () => {
  it('rejects a missing credential', async () => {
    const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(response.status).toBe(401);
  });

  it('rejects a wrong credential', async () => {
    await seedCredential(generateSandboxCredential());
    const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${generateSandboxCredential()}`,
      },
    });
    expect(response.status).toBe(401);
  });

  it('accepts an authenticated hello but quarantines the runtime when its socket is replaced', async () => {
    const id = 'sbx_control_replaced';
    const credential = generateSandboxCredential();
    await seedCredential(credential, id);
    const control = env.SANDBOX_CONTROL.getByName(id);
    const { provider } = await installProvider(control, 'inst_1');
    provider.stop.mockResolvedValue('retryable');
    const first = await connect(credential, id);
    await completeHello(first, 'hello-1');
    await expect(control.getStatus()).resolves.toMatchObject({ connection: 'connected' });

    const firstClosed = new Promise<number>(resolve => {
      first.addEventListener('close', event => resolve(event.code), { once: true });
    });
    const second = await connect(credential, id);
    const secondClosed = new Promise<number>(resolve => {
      second.addEventListener('close', event => resolve(event.code), { once: true });
    });
    sendHello(second, 'hello-2');
    await expect(firstClosed).resolves.toBe(4000);
    await expect(secondClosed).resolves.toBe(4001);
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
    await expect(control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopping',
      providerRef: 'inst_1',
      stopTombstone: { reason: 'control_replaced', attempts: 1 },
    });
    await runInDurableObject(control, async instance => {
      await expect(instance.request({ operation: 'sandbox.status', payload: {} })).rejects.toThrow(
        'not ready'
      );
    });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('closes duplicate provisional sockets after a successful handshake', async () => {
    const id = 'sbx_control_provisional_duplicates';
    const credential = generateSandboxCredential();
    await seedCredential(credential, id);
    const stub = env.SANDBOX_CONTROL.getByName(id);
    await runInDurableObject(stub, async instance => {
      await instance.confirmInstance('inst_1');
    });

    const provisional = await connect(credential, id);
    const successful = await connect(credential, id);
    const provisionalClosed = new Promise<number>(resolve => {
      provisional.addEventListener('close', event => resolve(event.code), { once: true });
    });

    await completeHello(successful, 'hello-provisional-duplicates');
    await expect(provisionalClosed).resolves.toBe(1008);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.getStatus()).resolves.toMatchObject({
        physical: 'running',
        connection: 'connected',
      });
      expect((await loadDeadlines(state.storage)).socketHandshake).toBeUndefined();
    });

    successful.close();
  });

  it('closes the live socket when the credential hash rotates', async () => {
    const sandboxId = 'sbx_control_rotate';
    const firstCredential = generateSandboxCredential();
    await seedCredential(firstCredential, sandboxId);
    const first = await connect(firstCredential, sandboxId);
    await completeHello(first, 'hello-rotate');

    const firstClosed = new Promise<number>(resolve => {
      first.addEventListener('close', event => resolve(event.code), { once: true });
    });
    const nextCredential = generateSandboxCredential();
    await seedCredential(nextCredential, sandboxId);
    await expect(firstClosed).resolves.toBe(4001);

    const rejected = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${firstCredential}`,
      },
    });
    expect(rejected.status).toBe(401);

    const replacement = await connect(nextCredential, sandboxId);
    await completeHello(replacement, 'hello-rotated');
    replacement.close();
  });

  it('correlates an outbound request with the wrapper response', async () => {
    const sandboxId = 'sbx_control_rpc';
    const credential = generateSandboxCredential();
    await seedCredential(credential, sandboxId);
    const ws = await connect(credential, sandboxId);
    await completeHello(ws, 'hello-rpc');

    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
    signalWrapperReady(ws);
    await vi.waitFor(async () => {
      await expect(stub.getStatus()).resolves.toMatchObject({ connection: 'ready' });
    });
    const inbound = nextMessage(ws);
    const pending = runInDurableObject(stub, instance =>
      instance.request({ operation: 'sandbox.status', payload: {} })
    );
    const request = JSON.parse(await inbound) as {
      type: string;
      requestId: string;
      operation: string;
    };
    expect(request).toMatchObject({ type: 'request', operation: 'sandbox.status' });
    ws.send(
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: true,
        result: { healthy: true, state: 'idle', version: 'test' },
      })
    );
    await expect(pending).resolves.toMatchObject({
      type: 'response',
      requestId: request.requestId,
      ok: true,
    });
    ws.close();
  });
});

describe('SandboxControl auto-response ping', () => {
  it('registers a ping/pong pair that does not require a DO invocation', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_auto_ping');
    await runInDurableObject(stub, async (_instance, state) => {
      const pair = state.getWebSocketAutoResponse();
      expect(pair?.request).toBe(SANDBOX_CONTROL_AUTO_PING);
      expect(pair?.response).toBe(SANDBOX_CONTROL_AUTO_PONG);
    });
  });
});

describe('SandboxControl owner identity', () => {
  it('returns null before initialize', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_owner_null');
    await runInDurableObject(stub, async instance => {
      await expect(instance.getOwner()).resolves.toBeNull();
    });
  });

  it('stores the owner on first initialize', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_owner_init');
    await runInDurableObject(stub, async instance => {
      await expect(instance.initializeOwner('user-1')).resolves.toEqual({ ownerId: 'user-1' });
      await expect(instance.getOwner()).resolves.toBe('user-1');
    });
  });

  it('is idempotent for the same owner', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_owner_idempotent');
    await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('user-1');
      await expect(instance.initializeOwner('user-1')).resolves.toEqual({ ownerId: 'user-1' });
      await expect(instance.initializeOwner('  user-1  ')).resolves.toEqual({ ownerId: 'user-1' });
      await expect(instance.getOwner()).resolves.toBe('user-1');
    });
  });

  it('rejects a different owner and keeps the original', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_owner_mismatch');
    await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('user-1');
      await expect(instance.initializeOwner('user-2')).rejects.toThrow('Sandbox owner mismatch');
      await expect(instance.getOwner()).resolves.toBe('user-1');
    });
  });

  it('rejects an empty ownerId', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_owner_empty');
    await runInDurableObject(stub, async instance => {
      await expect(instance.initializeOwner('')).rejects.toThrow(
        'ownerId must be a non-empty string'
      );
      await expect(instance.initializeOwner('   ')).rejects.toThrow(
        'ownerId must be a non-empty string'
      );
      await expect(instance.getOwner()).resolves.toBeNull();
    });
  });
});

describe('SandboxControl recovery watchdogs', () => {
  it('repairs a partially persisted stop and its system alarm after a Durable Object reset', async () => {
    const id = 'usr-partial-stop';
    let control = env.SANDBOX_CONTROL.getByName(id);
    const { provider, allocations } = await installProvider(control, id);
    await control.initializeOwner('owner_partial_stop');
    await control.claimCreate('intent_partial_stop');
    const running = await control.confirmInstance(id);
    const wrapperInstanceId = crypto.randomUUID();
    const partial = beginStop(running, 'preparation_interrupted', Date.now(), wrapperInstanceId);
    await runInDurableObject(control, async (_instance, state) => {
      await savePhysicalRecord(state.storage, partial);
      await saveDeadlines(state.storage, {});
      await state.storage.put('wrapper_ready_at', Date.now());
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });

    await abortAllDurableObjects();
    control = env.SANDBOX_CONTROL.getByName(id);
    const repairedAt = await runInDurableObject(control, async (instance, state) => {
      await expect(instance.getPhysicalRecord()).resolves.toEqual(partial);
      const deadlines = await loadDeadlines(state.storage);
      expect(deadlines).toEqual({ stopAttempt: expect.any(Number) });
      expect(await state.storage.getAlarm()).toBe(deadlines.stopAttempt);
      expect(await state.storage.get('wrapper_ready_at')).toBeUndefined();
      return deadlines.stopAttempt;
    });
    await expect(
      control.quarantineRuntime({
        ownerId: 'owner_partial_stop',
        sessionId: 'workspace_partial_stop',
        wrapperInstanceId,
        reason: 'preparation_interrupted',
      })
    ).resolves.toEqual({ quarantined: true });
    await runInDurableObject(control, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(repairedAt);
    });
    expect(provider.stop).not.toHaveBeenCalled();

    await fireControlDeadline(control, 'stopAttempt');
    await expect(control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopped',
      providerRef: null,
      stopTombstone: null,
    });
    await runInDurableObject(control, async (_instance, state) => {
      expect(await loadDeadlines(state.storage)).toEqual({});
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(allocations.size).toBe(0);
    expect(provider.stop).toHaveBeenCalledExactlyOnceWith(id, partial.createIntent);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.launch).not.toHaveBeenCalled();
  });

  it('rolls back physical state, authority, deadlines, and the real alarm when retirement fails', async () => {
    const fixture = {
      sandboxId: 'usr-rollback-stop',
      ownerId: 'owner_rollback_stop',
      sessionId: 'workspace_rollback_stop',
      wrapperInstanceId: crypto.randomUUID(),
    } as const satisfies TerminalRuntimeFixture;
    const { control, socket, provider } = await initializeTerminalRuntime(fixture);
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      captureAndAcceptControlRequests(socket);
      await runInDurableObject(control, async (instance, state) => {
        const keys = [
          'physical_record',
          'wrapper_credential_hash',
          'active_wrapper_runtime',
          'wrapper_ready_at',
          'deadlines',
          'transition_log',
        ];
        const before = await state.storage.get(keys);
        const alarmAt = await state.storage.getAlarm();
        const setAlarm = state.storage.setAlarm.bind(state.storage);
        const failure = vi.spyOn(state.storage, 'setAlarm').mockImplementationOnce(async at => {
          await setAlarm(at);
          throw new Error('injected alarm commit failure');
        });
        try {
          await expect(instance.beginStop('rollback_test')).rejects.toThrow(
            'injected alarm commit failure'
          );
        } finally {
          failure.mockRestore();
        }
        expect(await state.storage.get(keys)).toEqual(before);
        expect(await state.storage.getAlarm()).toBe(alarmAt);
        await expect(instance.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: fixture.wrapperInstanceId,
        });
      });
      await expect(
        control.request({
          operation: 'session.sync',
          session: {
            sessionId: fixture.sessionId,
            kiloSessionId: 'kilo_terminal',
            directory: '/workspace/terminal',
          },
          payload: {},
        })
      ).resolves.toMatchObject({ ok: true, result: { status: { type: 'busy' } } });
      expect(provider.stop).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });

  it('retires a credential-rotated runtime when its replacement readiness alarm expires', async () => {
    const fixture = {
      sandboxId: 'usr-rotation-watchdog',
      ownerId: 'owner_rotation_watchdog',
      sessionId: 'workspace_rotation_watchdog',
      wrapperInstanceId: crypto.randomUUID(),
    } as const satisfies TerminalRuntimeFixture;
    const { control, socket, provider, allocations } = await initializeTerminalRuntime(fixture);
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      const rotatedAt = Date.now();
      await control.setWrapperCredentialHash(
        await hashSandboxCredential(generateSandboxCredential())
      );
      await runInDurableObject(control, async (instance, state) => {
        const deadlines = await loadDeadlines(state.storage);
        expect(deadlines).toEqual({ wrapperReadiness: expect.any(Number) });
        expect(deadlines.wrapperReadiness).toBeGreaterThanOrEqual(
          rotatedAt + DEADLINE_MS.wrapperReadiness
        );
        expect(await state.storage.getAlarm()).toBe(deadlines.wrapperReadiness);
        expect(await state.storage.get('active_wrapper_runtime')).toBeUndefined();
        await expect(instance.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'disconnected',
        });
      });
      await fireControlDeadline(control, 'wrapperReadiness');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'failed',
        stopTombstone: { reason: 'environment_failed', attempts: 0 },
      });
      await fireControlDeadline(control, 'stopAttempt');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({ state: 'stopped' });
      expect(allocations.size).toBe(0);
      expect(provider.stop).toHaveBeenCalledTimes(1);
      expect(provider.create).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });

  it('continues native reaping beyond one hour while the first underlying stop remains unresolved', async () => {
    const id = `usr-${crypto.randomUUID().replaceAll('-', '')}`;
    const control = env.SANDBOX_CONTROL.getByName(id);
    const { provider, allocations } = await installProvider(control, id);
    const firstNativeCall = Promise.withResolvers<void>();
    const nativeEntered = Promise.withResolvers<void>();
    let firstNativeSettled = false;
    let nativeAvailable = false;
    const native = {
      isContainerRunning: vi.fn(async () => allocations.has(id)),
      forceDestroyForControlPlane: vi.fn(async () => {
        if (!nativeAvailable) throw new Error('native stop temporarily unavailable');
        allocations.delete(id);
      }),
      destroy: vi.fn(async () => {
        throw new Error('Legacy SDK destruction must not be used');
      }),
    };
    native.forceDestroyForControlPlane.mockImplementationOnce(async () => {
      nativeEntered.resolve();
      await firstNativeCall.promise;
      firstNativeSettled = true;
    });
    const sandbox: Partial<CloudflareSandboxHandle> = native;
    const adapter = createCloudflareProviderAdapter({
      sandboxId: id,
      getSandbox: () => sandbox as CloudflareSandboxHandle,
      destroy: async allocationId => {
        expect(allocationId).toBe(id);
        await forceDestroyControlPlaneSandbox(native);
      },
    });
    provider.stop.mockImplementation((ref, intent) => adapter.stop(ref, intent));
    provider.observe.mockImplementation((ref, intent) => adapter.observe(ref, intent));
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      await control.claimCreate('intent_native_reaping');
      await control.confirmInstance(id);
      await control.beginStop('native_stop_unavailable');
      await runInDurableObject(control, async instance => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const first = instance.recordStopAttempt();
          await nativeEntered.promise;
          clock.mockReturnValue(startedAt + DEADLINE_MS.stopAttempt);
          vi.advanceTimersByTime(DEADLINE_MS.stopAttempt);
          await expect(first).resolves.toMatchObject({
            state: 'stopping',
            stopTombstone: { attempts: 1 },
          });
        } finally {
          vi.useRealTimers();
        }
      });
      expect(firstNativeSettled).toBe(false);
      expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(1);
      for (let attempt = 2; attempt <= DEADLINE_MS.stopAttemptLadder.length; attempt++) {
        await fireControlDeadline(control, 'stopAttempt');
        expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(attempt);
      }
      const exhausted = await control.getPhysicalRecord();
      expect(exhausted).toMatchObject({
        state: 'unknown',
        providerRef: id,
        stopTombstone: { createdAt: startedAt, attempts: 5 },
      });
      clock.mockReturnValue(startedAt + DEADLINE_MS.reconciliationWindow + 1);
      const nextPassAt = Date.now() + DEADLINE_MS.reconciliation;
      provider.observe.mockImplementationOnce(async (ref, intent) => {
        await runInDurableObject(control, async (_instance, state) => {
          expect(await loadDeadlines(state.storage)).toEqual({ reconciliation: nextPassAt });
          expect(await state.storage.getAlarm()).toBe(nextPassAt);
        });
        return adapter.observe(ref, intent);
      });
      await expect(runDurableObjectAlarm(control)).resolves.toBe(true);
      expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(6);
      expect(firstNativeSettled).toBe(false);
      await expect(control.getPhysicalRecord()).resolves.toEqual(exhausted);
      await expect(
        control.ensureReady({ ownerId: 'owner_native_reaping', allowCreate: true })
      ).resolves.toMatchObject({ physical: 'unknown' });
      await runInDurableObject(control, async (_instance, state) => {
        expect(await loadDeadlines(state.storage)).toEqual({ reconciliation: nextPassAt });
        expect(await state.storage.getAlarm()).toBe(nextPassAt);
      });
      expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(6);
      expect(allocations).toEqual(new Set([id]));

      nativeAvailable = true;
      clock.mockReturnValue(nextPassAt);
      await expect(runDurableObjectAlarm(control)).resolves.toBe(true);
      expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(7);
      expect(firstNativeSettled).toBe(false);
      expect(native.destroy).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.launch).not.toHaveBeenCalled();
      expect(allocations.size).toBe(0);
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        stopTombstone: null,
      });
      await runInDurableObject(control, async (_instance, state) => {
        expect(await loadDeadlines(state.storage)).toEqual({});
        expect(await state.storage.getAlarm()).toBeNull();
      });
    } finally {
      firstNativeCall.resolve();
      vi.useRealTimers();
      clock.mockRestore();
    }
  });

  it.each(['disconnected', 'ready'] as const)(
    'retains cleanup for an uncertain %s runtime and restores readiness watchdogs only on its replacement',
    async connection => {
      const id = crypto.randomUUID().replaceAll('-', '');
      const fixture = {
        sandboxId: `usr-${id}`,
        ownerId: 'owner_recovery_watchdog',
        sessionId: `workspace_watchdog_${id}`,
        wrapperInstanceId: crypto.randomUUID(),
      } as const satisfies TerminalRuntimeFixture;
      const credential = generateSandboxCredential();
      await seedCredential(credential, fixture.sandboxId);
      const control = env.SANDBOX_CONTROL.getByName(fixture.sandboxId);
      const { provider } = await installProvider(control, fixture.sandboxId);
      await control.confirmInstance(fixture.sandboxId);
      let socket: WebSocket | undefined;
      let replacement: WebSocket | undefined;
      try {
        if (connection === 'ready') {
          socket = await connect(credential, fixture.sandboxId);
          await completeHello(socket, 'hello_watchdog_original', {
            providerInstanceId: fixture.sandboxId,
            wrapperInstanceId: fixture.wrapperInstanceId,
          });
          signalWrapperReady(socket);
          await waitForWrapperReady(fixture);
        }
        await runInDurableObject(control, async (instance, state) => {
          const uncertain = await instance.observeProvider('unknown');
          expect(uncertain).toMatchObject({
            state: 'unknown',
            providerRef: fixture.sandboxId,
            stopTombstone: { reason: 'provider_unknown' },
          });
          const deadlines = await loadDeadlines(state.storage);
          expect(deadlines.wrapperReadiness).toBeUndefined();
          expect(deadlines.heartbeatExpiry).toBeUndefined();
          expect(deadlines.stopAttempt).toEqual(expect.any(Number));
          expect(await state.storage.getAlarm()).toBe(deadlines.stopAttempt);
          await expect(instance.observeProvider('active')).resolves.toEqual(uncertain);
          await expect(instance.observeProvider('active')).resolves.toEqual(uncertain);
          expect((await loadDeadlines(state.storage)).stopAttempt).toBe(deadlines.stopAttempt);
        });
        await expect(
          control.ensureReady({ ownerId: fixture.ownerId, allowCreate: false })
        ).resolves.toMatchObject({ physical: 'unknown', connection: 'disconnected' });
        expect(provider.create).not.toHaveBeenCalled();
        await expect(control.observeProvider('terminal')).resolves.toMatchObject({
          state: 'stopped',
          providerRef: null,
        });
        await control.ensureReady({ ownerId: fixture.ownerId, allowCreate: false });
        expect(provider.create).not.toHaveBeenCalled();
        await control.ensureReady({ ownerId: fixture.ownerId, allowCreate: true });
        const launch = provider.launch.mock.calls[0];
        if (!launch) throw new Error('Expected replacement wrapper launch');
        expect(launch[0]).not.toBe(fixture.sandboxId);
        replacement = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
        const recoveredAt = Date.now();
        const nextFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
        await completeHello(replacement, 'hello_watchdog_replacement', {
          providerInstanceId: launch[0],
          wrapperInstanceId: nextFixture.wrapperInstanceId,
        });
        await runInDurableObject(control, async (_instance, state) => {
          const deadlines = await loadDeadlines(state.storage);
          expect(deadlines.wrapperReadiness).toBeGreaterThanOrEqual(
            recoveredAt + DEADLINE_MS.wrapperReadiness
          );
          expect(deadlines.heartbeatExpiry).toBeUndefined();
          expect(await state.storage.getAlarm()).toBe(deadlines.wrapperReadiness);
        });
        signalWrapperReady(replacement);
        await waitForWrapperReady(nextFixture);
        await runInDurableObject(control, async (instance, state) => {
          const deadlines = await loadDeadlines(state.storage);
          expect(deadlines.heartbeatExpiry).toBeGreaterThanOrEqual(
            recoveredAt + DEADLINE_MS.heartbeatExpiry
          );
          expect(deadlines.wrapperReadiness).toBeUndefined();
          expect(await state.storage.getAlarm()).toBe(deadlines.heartbeatExpiry);
          await instance.observeProvider('active');
          expect((await loadDeadlines(state.storage)).heartbeatExpiry).toBe(
            deadlines.heartbeatExpiry
          );
        });
        expect(provider.create).toHaveBeenCalledTimes(1);
      } finally {
        socket?.close();
        replacement?.close();
      }
    }
  );
});

describe('SandboxControl acquisition receipts', () => {
  it('does not allocate twice after a lost acquisition response, reaping, and reset', async () => {
    const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '')}`;
    let control = env.SANDBOX_CONTROL.getByName(sandboxId);
    const { provider, allocations } = await installProvider(control);
    let responseHeld = false;
    const releaseResponse = Promise.withResolvers<void>();
    const acquisition = {
      id: crypto.randomUUID(),
      deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
    };
    const input = { ownerId: 'owner_lost_acquisition', acquisition };
    const responseSpy = await runInDurableObject(control, instance => {
      const prototype = Object.getPrototypeOf(instance) as typeof instance;
      const ensureReady = instance.ensureReady.bind(instance);
      return vi.spyOn(prototype, 'ensureReady').mockImplementationOnce(async request => {
        const result = await ensureReady(request);
        responseHeld = true;
        await releaseResponse.promise;
        return result;
      });
    });
    const lostResponse = control.ensureReady(input).then(
      () => null,
      (error: unknown) => error
    );
    try {
      await vi.waitFor(() => expect(responseHeld).toBe(true));
      const physical = await control.getPhysicalRecord();
      expect(physical).toMatchObject({ state: 'running', providerRef: expect.any(String) });
      const receipts = await runInDurableObject(control, (_instance, state) =>
        state.storage.get('acquisition_receipts')
      );
      expect(receipts).toEqual([
        { ...acquisition, allocation: { kind: 'intent', id: physical.createIntent?.intentId } },
      ]);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.launch).toHaveBeenCalledTimes(1);
      expect(allocations.size).toBe(1);
      await control.beginStop('lost_acquisition_response');
      await fireControlDeadline(control, 'stopAttempt');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        createIntent: null,
      });
      expect(allocations.size).toBe(0);

      await expect(
        runInDurableObject(control, (_instance, state) => state.abort('acquisition response lost'))
      ).rejects.toThrow('acquisition response lost');
      expect(await lostResponse).toMatchObject({ message: 'acquisition response lost' });
      responseSpy.mockRestore();
      releaseResponse.resolve();
      control = env.SANDBOX_CONTROL.getByName(sandboxId);
      await runInDurableObject(control, async (_instance, state) => {
        expect(await state.storage.get('acquisition_receipts')).toEqual(receipts);
        expect(await state.storage.getAlarm()).toBeNull();
      });
      await expect(
        Promise.resolve(control.ensureReady({ ...input, allowCreate: true }))
      ).rejects.toThrow('Sandbox acquisition no longer owns this allocation');
      await expect(
        Promise.resolve(
          control.ensureReady({
            ...input,
            acquisition: { ...acquisition, deadlineAt: acquisition.deadlineAt + 1 },
          })
        )
      ).rejects.toThrow('Sandbox acquisition deadline changed');
      await expect(
        Promise.resolve(
          control.ensureReady({
            ...input,
            acquisition: { id: crypto.randomUUID(), deadlineAt: Date.now() - 1 },
          })
        )
      ).rejects.toThrow('Sandbox acquisition expired');
      await expect(
        control.ensureReady({ ownerId: input.ownerId, allowCreate: false })
      ).resolves.toMatchObject({
        physical: 'stopped',
      });
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.launch).toHaveBeenCalledTimes(1);
      expect(allocations.size).toBe(0);

      const fresh = {
        id: crypto.randomUUID(),
        deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
      };
      await expect(control.ensureReady({ ...input, acquisition: fresh })).resolves.toMatchObject({
        physical: 'running',
      });
      const replacement = await control.getPhysicalRecord();
      expect(replacement.providerRef).not.toBe(physical.providerRef);
      expect(allocations).toEqual(new Set([replacement.providerRef]));
      expect(provider.create).toHaveBeenCalledTimes(2);
      expect(provider.launch).toHaveBeenCalledTimes(2);
      await expect(Promise.resolve(control.ensureReady(input))).rejects.toThrow(
        'Sandbox acquisition no longer owns this allocation'
      );
      expect(provider.ensureBillingAdmission).not.toHaveBeenCalled();
      await runInDurableObject(control, async (_instance, state) => {
        expect(await state.storage.get('acquisition_receipts')).toEqual([
          ...(receipts as unknown[]),
          { ...fresh, allocation: { kind: 'intent', id: replacement.createIntent?.intentId } },
        ]);
      });
    } finally {
      releaseResponse.resolve();
    }
  });
});

describe('SandboxControl durable remainder', () => {
  it('persists create intent before an instance ref exists', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_create_intent');
    await runInDurableObject(stub, async instance => {
      const record = await instance.claimCreate('intent_1');
      expect(record.state).toBe('creating');
      expect(record.createIntent?.intentId).toBe('intent_1');
      expect(record.providerRef).toBeNull();
      await expect(instance.getPhysicalRecord()).resolves.toEqual(record);
      await expect(instance.getStatus()).resolves.toMatchObject({
        reported: 'booting',
        physical: 'creating',
      });
    });
  });

  it('attaches a session route and rejects owner or directory conflicts', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_routes');
    await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('owner_1');
      const route = await instance.attachSession({
        sessionId: 'ses_1',
        kiloSessionId: 'kilo_1',
        directory: '/workspace/a',
        ownerId: 'owner_1',
      });
      expect(route.sessionId).toBe('ses_1');
      await expect(
        instance.attachSession({
          sessionId: 'ses_1',
          kiloSessionId: 'kilo_1',
          directory: '/workspace/a',
          ownerId: 'owner_1',
        })
      ).resolves.toMatchObject({ sessionId: 'ses_1' });
      await expect(
        instance.attachSession({
          sessionId: 'ses_2',
          kiloSessionId: 'kilo_2',
          directory: '/workspace/a',
          ownerId: 'owner_1',
        })
      ).rejects.toThrow('Directory already attached');
      await expect(
        instance.attachSession({
          sessionId: 'ses_3',
          kiloSessionId: 'kilo_3',
          directory: '/workspace/b',
          ownerId: 'owner_other',
        })
      ).rejects.toThrow('Sandbox owner mismatch');
    });
  });

  it('rearms idle stop when its final active session is detached', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_detach_last_active');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.initializeOwner('owner_1');
      await instance.claimCreate('intent_detach_last_active');
      await instance.confirmInstance('inst_1');
      await instance.attachSession({
        sessionId: 'workspace_last_active',
        kiloSessionId: 'kilo_last_active',
        directory: '/workspace/last-active',
        ownerId: 'owner_1',
      });
      const routes = await loadRouteTable(state.storage);
      applyReportedSessionState(
        routes,
        'kilo_last_active',
        { state: 'active', idleForMs: 0 },
        Date.now()
      );
      await saveRouteTable(state.storage, routes);
      expect((await loadDeadlines(state.storage)).idleStop).toBeUndefined();

      const detachedAt = Date.now();
      await expect(instance.detachSession('workspace_last_active')).resolves.toEqual({
        existed: true,
      });
      const idleStop = (await loadDeadlines(state.storage)).idleStop;
      expect(idleStop).toBeGreaterThanOrEqual(detachedAt + DEADLINE_MS.idleStop);
      await expect(instance.listRoutes()).resolves.toEqual([]);
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({ state: 'running' });

      await expect(instance.detachSession('workspace_last_active')).resolves.toEqual({
        existed: false,
      });
      expect((await loadDeadlines(state.storage)).idleStop).toBe(idleStop);
    });
  });

  it('projects shutting-down after beginStop and retains the tombstone without a ref', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_stop_tombstone');
    await runInDurableObject(stub, async instance => {
      await instance.claimCreate('intent_stop');
      const stopping = await instance.beginStop('idle');
      expect(stopping.state).toBe('stopping');
      expect(stopping.providerRef).toBeNull();
      expect(stopping.createIntent?.intentId).toBe('intent_stop');
      expect(stopping.stopTombstone?.reason).toBe('idle');
      await expect(instance.getStatus()).resolves.toMatchObject({
        reported: 'shutting-down',
        physical: 'stopping',
      });
    });
  });

  it('arms idle stop on ready, cancels it for active work, and rearms it when work becomes idle', async () => {
    const sandboxId = 'sbx_control_heartbeat_idle_stop';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(stub, async instance => {
      await instance.claimCreate(crypto.randomUUID());
      await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
      await instance.initializeOwner('owner_1');
      await instance.attachSession({
        sessionId: 'ses_1',
        kiloSessionId: 'kilo_1',
        directory: '/workspace/a',
        ownerId: 'owner_1',
      });
    });

    const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${credential}`,
      },
    });
    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
    }
    const ws = response.webSocket;
    ws.accept();
    await completeHello(ws, 'hello-heartbeat-idle-stop');

    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      })
    );
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (_instance, state) => {
        expect((await loadDeadlines(state.storage)).idleStop).toEqual(expect.any(Number));
      });
    });

    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'sandbox.heartbeat',
        payload: {
          state: 'active',
          pendingMessages: 0,
          kilo: { ready: true },
          sessions: [{ kiloSessionId: 'kilo_1', state: 'active', idleForMs: 0 }],
        },
      })
    );
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (instance, state) => {
        expect((await loadDeadlines(state.storage)).idleStop).toBeUndefined();
        expect(await instance.listRoutes()).toEqual([
          expect.objectContaining({ kiloSessionId: 'kilo_1', lastState: 'active' }),
        ]);
      });
    });

    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'sandbox.heartbeat',
        payload: {
          state: 'idle',
          pendingMessages: 0,
          kilo: { ready: true },
          sessions: [{ kiloSessionId: 'kilo_1', state: 'idle', idleForMs: 0 }],
        },
      })
    );
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (instance, state) => {
        expect((await loadDeadlines(state.storage)).idleStop).toEqual(expect.any(Number));
        expect(await instance.listRoutes()).toEqual([
          expect.objectContaining({ kiloSessionId: 'kilo_1', lastState: 'idle' }),
        ]);
      });
    });
    ws.close();
  });

  it.each(['session.attach', 'session.prompt'] as const)(
    'persists valid %s demand before forwarding at the idle boundary',
    async operation => {
      const fixture = {
        sandboxId: `usr-idle-${operation}`,
        ownerId: 'owner_idle_boundary',
        sessionId: 'workspace_idle_boundary',
        wrapperInstanceId: crypto.randomUUID(),
      } as const satisfies TerminalRuntimeFixture;
      const { control, socket, provider } = await initializeTerminalRuntime(fixture);
      const clock = vi.spyOn(Date, 'now');
      let held: RequestFrame | undefined;
      let pending: Promise<ResponseFrame> | undefined;
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        const idleStop = await runInDurableObject(control, async (_instance, state) => {
          const deadlines = await loadDeadlines(state.storage);
          if (deadlines.idleStop === undefined) throw new Error('Expected an idle deadline');
          await saveDeadlines(state.storage, {
            ...deadlines,
            heartbeatExpiry: deadlines.idleStop + DEADLINE_MS.heartbeatExpiry,
          });
          await state.storage.setAlarm(deadlines.idleStop);
          return deadlines.idleStop;
        });
        clock.mockReturnValue(idleStop - 1);
        const inbound = nextMessage(socket);
        pending = Promise.resolve(
          control.request({
            operation,
            session: {
              sessionId: fixture.sessionId,
              kiloSessionId: 'kilo_terminal',
              directory: '/workspace/terminal',
            },
            payload:
              operation === 'session.attach'
                ? { directory: '/workspace/terminal' }
                : {
                    messageId: 'msg_idle_boundary',
                    turn: { type: 'prompt', prompt: 'continue before idle expiry' },
                    agent: { mode: 'code', model: 'test' },
                  },
          })
        );
        held = requestFrameSchema.parse(JSON.parse(await inbound));
        expect(held.operation).toBe(operation);
        await runInDurableObject(control, async (_instance, state) => {
          const deadlines = await loadDeadlines(state.storage);
          expect(deadlines.idleStop).toBe(idleStop - 1 + DEADLINE_MS.idleStop);
          expect(deadlines.heartbeatExpiry).toBe(idleStop + DEADLINE_MS.heartbeatExpiry);
          expect(await state.storage.getAlarm()).toBe(deadlines.heartbeatExpiry);
        });
        acceptControlRequest(socket, held);
        held = undefined;
        await expect(pending).resolves.toMatchObject({ ok: true });
        clock.mockReturnValue(idleStop + 1);
        await expect(runDurableObjectAlarm(control)).resolves.toBe(true);
        await expect(control.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: fixture.wrapperInstanceId,
        });
        expect(provider.stop).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();
        socket.send(
          JSON.stringify({
            type: 'event',
            event: 'sandbox.heartbeat',
            payload: {
              state: 'active',
              kilo: { ready: true },
              sessions: [{ kiloSessionId: 'kilo_terminal', state: 'active', idleForMs: 0 }],
            },
          })
        );
        await vi.waitFor(async () => {
          await runInDurableObject(control, async (_instance, state) => {
            const deadlines = await loadDeadlines(state.storage);
            expect(deadlines.idleStop).toBeUndefined();
            expect(deadlines.heartbeatExpiry).toBe(idleStop + 1 + DEADLINE_MS.heartbeatExpiry);
            expect(await state.storage.getAlarm()).toBe(deadlines.heartbeatExpiry);
          });
        });
      } finally {
        if (held && socket.readyState === WebSocket.OPEN) acceptControlRequest(socket, held);
        await pending;
        clock.mockRestore();
        socket.close();
      }
    }
  );

  it('clears the transition log when the sandbox record is erased', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_erase_log');
    await runInDurableObject(stub, async instance => {
      await instance.claimCreate('intent_erase');
      expect(await instance.getTransitionLog()).not.toHaveLength(0);
      await instance.eraseRecord();
      expect(await instance.getTransitionLog()).toEqual([]);
      await expect(instance.getOwner()).resolves.toBeNull();
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({ state: 'stopped' });
    });
  });

  it('does not mutate or quarantine an unrelated route for an unroutable session.event', async () => {
    const sandboxId = 'sbx_control_event_unroutable';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(stub, async instance => {
      await instance.claimCreate(crypto.randomUUID());
      await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
      await instance.initializeOwner('owner_1');
      await instance.attachSession({
        sessionId: 'ses_1',
        kiloSessionId: 'kilo_1',
        directory: '/workspace/a',
        ownerId: 'owner_1',
      });
    });

    const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${credential}`,
      },
    });
    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
    }
    response.webSocket.accept();
    await completeHello(response.webSocket, 'hello-event');
    const before = await stub.listRoutes();
    response.webSocket.send(
      JSON.stringify({
        type: 'event',
        event: 'session.event',
        session: { directory: '/workspace/other', rootKiloSessionId: 'kilo_1' },
        payload: { type: 'message.updated', properties: { id: 'msg_1' } },
      })
    );
    await runInDurableObject(stub, async instance => {
      await expect(instance.listRoutes()).resolves.toEqual(before);
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        stopTombstone: null,
      });
    });
    response.webSocket.close();
  });

  it('isolates two session.prompt identities on one wrapper socket', async () => {
    const twoSessionId = 'sbx_control_two_session';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(twoSessionId);
    await runInDurableObject(stub, async instance => {
      await instance.claimCreate(crypto.randomUUID());
      await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
      await instance.initializeOwner('owner_1');
      await instance.attachSession({
        sessionId: 'ses_a',
        kiloSessionId: 'kilo_a',
        directory: '/workspace/a',
        ownerId: 'owner_1',
      });
      await instance.attachSession({
        sessionId: 'ses_b',
        kiloSessionId: 'kilo_b',
        directory: '/workspace/b',
        ownerId: 'owner_1',
      });
    });

    const response = await SELF.fetch(`http://worker.test/sandbox-control/${twoSessionId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${credential}`,
      },
    });
    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
    }
    response.webSocket.accept();
    await completeHello(response.webSocket, 'hello-two-session');
    signalWrapperReady(response.webSocket);
    await vi.waitFor(async () => {
      await expect(stub.getStatus()).resolves.toMatchObject({ connection: 'ready' });
    });

    const promptPayload = {
      messageId: 'msg_a',
      turn: { type: 'prompt', prompt: 'from a' },
      agent: { mode: 'code', model: 'test' },
    };

    async function prompt(
      sessionId: string,
      kiloSessionId: string,
      directory: string,
      messageId: string
    ) {
      const inbound = nextMessage(response.webSocket!);
      const pending = runInDurableObject(stub, instance =>
        instance.request({
          operation: 'session.prompt',
          session: { sessionId, kiloSessionId, directory },
          payload: { ...promptPayload, messageId },
        })
      );
      const request = JSON.parse(await inbound) as {
        operation: string;
        requestId: string;
        session: { sessionId: string; kiloSessionId: string; directory: string };
        payload: { messageId: string };
      };
      expect(request).toMatchObject({
        operation: 'session.prompt',
        session: { sessionId, kiloSessionId, directory },
        payload: { messageId },
      });
      response.webSocket!.send(
        JSON.stringify({
          type: 'response',
          requestId: request.requestId,
          ok: true,
          result: { messageId, status: 'accepted' },
        })
      );
      await expect(pending).resolves.toMatchObject({
        ok: true,
        result: { messageId, status: 'accepted' },
      });
    }

    await prompt('ses_a', 'kilo_a', '/workspace/a', 'msg_a');
    await prompt('ses_b', 'kilo_b', '/workspace/b', 'msg_b');
    response.webSocket.close();
  });
});

describe('SandboxSession control-plane regressions', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ valid: true }));
  });

  type SessionStub = ReturnType<typeof env.SANDBOX_SESSION.getByName>;

  const agentA = { mode: 'code', model: 'kilo/anthropic/claude-sonnet-4', variant: 'high' };
  const modelB = 'kilo/openai/gpt-4.1';

  function messageFixture() {
    const id = crypto.randomUUID().replaceAll('-', '');
    const fixture = {
      sandboxId: `usr-${id}`,
      ownerId: 'user_admission',
      sessionId: `workspace_admission_${id}`,
      wrapperInstanceId: crypto.randomUUID(),
    } as const satisfies TerminalRuntimeFixture;
    const session = env.SANDBOX_SESSION.getByName(`${fixture.ownerId}:${fixture.sessionId}`);
    return { fixture, session };
  }

  async function seedBlockedAdmission(agent: AgentSelectionOverride = agentA) {
    const { fixture, session } = messageFixture();
    await session.registerSession({
      identity: {
        sessionId: fixture.sessionId,
        userId: fixture.ownerId,
        orgId: 'stored-org',
        createdOnPlatform: 'stored-platform',
      },
      auth: { kiloSessionId: 'kilo_terminal', kilocodeToken: 'stored-test-token' },
      agent,
    });
    await runInDurableObject(session, (_instance, state) => {
      state.storage.kv.put('session_messages', [
        { messageId: 'msg_blocker', state: 'accepted', acceptedAt: Date.now() },
      ] satisfies SessionMessageRecord[]);
    });
    return { fixture, session };
  }

  function admissionState(session: SessionStub) {
    return runInDurableObject(session, (_instance, state) => ({
      metadata: state.storage.kv.get<SessionMetadata>('session_metadata'),
      messages: state.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [],
    }));
  }

  async function waitForAccepted(session: SessionStub, messageId: string) {
    await vi.waitFor(async () => {
      await expect(session.getMessageResult(messageId)).resolves.toMatchObject({
        type: 'found',
        result: { status: 'running' },
      });
    });
  }

  function completeTurn(session: SessionStub, messageId: string, wrapperInstanceId: string) {
    return session.receiveSandboxControlEvent({
      identity: { directory: '/workspace/terminal', kiloSessionId: 'kilo_terminal' },
      wrapperInstanceId,
      payload: { type: 'session.message.outcome', properties: { messageId, status: 'completed' } },
    });
  }

  function sendOutcome(
    socket: WebSocket,
    messageId: string,
    status: 'completed' | 'failed' | 'cancelled' = 'completed'
  ): void {
    socket.send(
      JSON.stringify({
        type: 'event',
        event: 'session.event',
        session: { directory: '/workspace/terminal', kiloSessionId: 'kilo_terminal' },
        payload: { type: 'session.message.outcome', properties: { messageId, status } },
      })
    );
  }

  function lifecycleEvents(session: SessionStub) {
    return runInDurableObject(session, (_instance, state) =>
      createEventQueries(drizzle(state.storage, { logger: false }), state.storage.sql)
        .findByFilters({
          eventTypes: ['cloud.message.sent', 'cloud.message.completed', 'cloud.message.failed'],
        })
        .map(event => ({
          type: event.stream_event_type,
          data: JSON.parse(event.payload) as Record<string, unknown>,
        }))
    );
  }

  function preparationSnapshots(session: SessionStub) {
    return runInDurableObject(session, (_instance, state) =>
      getPreparationSnapshots(
        createEventQueries(drizzle(state.storage, { logger: false }), state.storage.sql)
      ).map(event => JSON.parse(event.payload) as Record<string, unknown>)
    );
  }

  it('settles cancelled preparation and delivers B with its original acquisition after failed cleanup transfer and reset', async () => {
    const { fixture, session: originalSession } = messageFixture();
    let session = originalSession;
    const { control, socket, provider, allocations } = await initializeTerminalRuntime(fixture);
    const attach = Promise.withResolvers<RequestFrame>();
    const acquisitions: Parameters<typeof control.ensureReady>[0][] = [];
    let transferUnavailable = true;
    let held: RequestFrame | undefined;
    let dispatch: Promise<void> | undefined;
    let replacement: WebSocket | undefined;
    let stream: WebSocket | undefined;
    provider.stop.mockResolvedValue('retryable');
    await runInDurableObject(control, instance => {
      const prototype = Object.getPrototypeOf(instance) as typeof instance;
      const quarantine = instance.quarantineRuntime.bind(instance);
      const ensureReady = instance.ensureReady.bind(instance);
      vi.spyOn(prototype, 'quarantineRuntime').mockImplementation(async input => {
        if (transferUnavailable) throw new Error('temporary quarantine transfer failure');
        return quarantine(input);
      });
      vi.spyOn(prototype, 'ensureReady').mockImplementation(input => {
        acquisitions.push(input);
        return ensureReady(input);
      });
    });
    const requests = captureAndAcceptControlRequests(socket, request => {
      if (request.operation !== 'session.attach') return false;
      held = request;
      attach.resolve(request);
      return true;
    });
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: { initialTurn: { type: 'prompt', messageId: 'msg_cancelled_a', prompt: 'A' } },
      });
      const attachment = await attach.promise;
      const preparing = (await admissionState(session)).messages[0];
      if (!preparing?.preparationAttemptId) throw new Error('Expected preparation attempt A');
      expect(await preparationSnapshots(session)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'attempt_snapshot',
            attempt: expect.objectContaining({
              id: preparing.preparationAttemptId,
              status: 'running',
            }),
          }),
          expect.objectContaining({
            action: 'step_snapshot',
            stepSnapshot: expect.objectContaining({ status: 'running' }),
          }),
        ])
      );
      let joined = false;
      dispatch = runInDurableObject(session, instance => {
        joined = true;
        return instance.alarm();
      });
      await vi.waitFor(() => expect(joined).toBe(true));
      await expect(session.interruptExecution()).resolves.toEqual({ success: true });
      const cancelled = await preparationSnapshots(session);
      expect(cancelled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'attempt_snapshot',
            attempt: expect.objectContaining({
              id: preparing.preparationAttemptId,
              status: 'failed',
              safeError: 'The message was interrupted',
            }),
          }),
          expect.objectContaining({
            action: 'step_snapshot',
            stepSnapshot: expect.objectContaining({
              status: 'failed',
              safeError: 'The message was interrupted',
            }),
          }),
        ])
      );
      for (const snapshot of cancelled) {
        if (snapshot.action === 'step_snapshot') {
          expect(snapshot.stepSnapshot).not.toMatchObject({ status: 'running' });
        }
      }
      const cleanup = await runInDurableObject(session, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
        return state.storage.kv.get('pending_runtime_cleanup');
      });
      expect(cleanup).toMatchObject({
        wrapperInstanceId: fixture.wrapperInstanceId,
        reason: 'preparation_interrupted',
      });
      const admittedAt = Date.now();
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_after_cancel_b', prompt: 'B' },
        })
      ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'queued' });
      await vi.waitFor(async () => {
        expect((await admissionState(session)).messages[1]).toMatchObject({
          state: 'queued',
          preparationAttemptId: expect.any(String),
          deliveryDeadlineAt: expect.any(Number),
        });
      });
      acceptControlRequest(socket, attachment);
      held = undefined;
      await dispatch;
      const beforeReset = await admissionState(session);
      const b = beforeReset.messages[1];
      if (!b?.preparationAttemptId || b.deliveryDeadlineAt === undefined)
        throw new Error('Expected bounded acquisition B');
      const acquisitionB = { id: b.preparationAttemptId, deadlineAt: b.deliveryDeadlineAt };
      expect(b.deliveryDeadlineAt).toBeGreaterThanOrEqual(admittedAt + SESSION_DELIVERY_TIMEOUT_MS);
      expect(acquisitions.map(input => input.acquisition?.id)).toEqual([
        preparing.preparationAttemptId,
      ]);
      expect(beforeReset.messages[0]).toMatchObject({
        messageId: 'msg_cancelled_a',
        state: 'cancelled',
      });
      expect(requests.filter(request => request.operation === 'session.prompt')).toEqual([]);
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.stop).not.toHaveBeenCalled();

      await expect(
        runInDurableObject(session, (_instance, state) => state.abort('cleanup continuation reset'))
      ).rejects.toThrow('cleanup continuation reset');
      session = env.SANDBOX_SESSION.getByName(`${fixture.ownerId}:${fixture.sessionId}`);
      expect(await admissionState(session)).toEqual(beforeReset);
      expect(await preparationSnapshots(session)).toEqual(cancelled);
      await runInDurableObject(session, (_instance, state) => {
        expect(state.storage.kv.get('pending_runtime_cleanup')).toEqual(cleanup);
      });
      await session.receiveSandboxControlPreparing({
        identity: { directory: '/workspace/terminal', kiloSessionId: 'kilo_terminal' },
        wrapperInstanceId: fixture.wrapperInstanceId,
        payload: {
          version: 2,
          attemptId: preparing.preparationAttemptId,
          triggerMessageId: 'msg_cancelled_a',
          revision: 1000,
          timestamp: Date.now(),
          step: 'ready',
          message: 'late preparation completion',
          action: 'attempt_completed',
        },
      });
      expect(await preparationSnapshots(session)).toEqual(cancelled);
      const response = await SELF.fetch(
        `http://worker.test/stream?sessionId=${fixture.sessionId}&userId=${fixture.ownerId}&replay=false`,
        { headers: { Upgrade: 'websocket' } }
      );
      stream = response.webSocket ?? undefined;
      if (response.status !== 101 || !stream) throw new Error('Expected session stream');
      const events: { streamEventType: string; data: unknown }[] = [];
      stream.addEventListener('message', event => {
        events.push(JSON.parse(String(event.data)));
      });
      stream.accept();
      await vi.waitFor(() => {
        expect(
          events.filter(event => event.streamEventType === 'preparing').map(event => event.data)
        ).toEqual(cancelled);
      });
      stream.close();

      transferUnavailable = false;
      await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
      await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopping',
        providerRef: fixture.sandboxId,
      });
      await runInDurableObject(session, (_instance, state) => {
        expect(state.storage.kv.get('pending_runtime_cleanup')).toBeUndefined();
      });
      expect(acquisitions.at(-1)?.acquisition).toEqual(acquisitionB);
      expect(provider.create).not.toHaveBeenCalled();
      await runInDurableObject(control, async (_instance, state) => {
        expect(await state.storage.get('acquisition_receipts')).toEqual([
          expect.objectContaining({ id: preparing.preparationAttemptId }),
        ]);
      });

      allocations.delete(fixture.sandboxId);
      await fireControlDeadline(control, 'stopAttempt');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
      });
      await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
      expect(provider.launch).toHaveBeenCalledTimes(1);
      const launch = provider.launch.mock.calls[0];
      if (!launch) throw new Error('Expected one replacement launch for B');
      const replacementFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
      replacement = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
      await completeHello(replacement, 'hello_after_cancel', {
        providerInstanceId: launch[0],
        wrapperInstanceId: replacementFixture.wrapperInstanceId,
      });
      const replacementRequests = captureAndAcceptControlRequests(replacement);
      signalWrapperReady(replacement);
      await waitForWrapperReady(replacementFixture);
      await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
      await waitForAccepted(session, 'msg_after_cancel_b');
      await session.failWaitingMessages(
        'late_cancelled_runtime_failure',
        fixture.wrapperInstanceId
      );
      await expect(
        control.quarantineRuntime({
          ownerId: fixture.ownerId,
          sessionId: fixture.sessionId,
          wrapperInstanceId: fixture.wrapperInstanceId,
          reason: 'late_cancelled_runtime_cleanup',
        })
      ).resolves.toEqual({ quarantined: false });
      expect((await admissionState(session)).messages).toMatchObject([
        { messageId: 'msg_cancelled_a', state: 'cancelled' },
        {
          ...b,
          state: 'accepted',
          wrapperInstanceId: replacementFixture.wrapperInstanceId,
        },
      ]);
      const continuations = acquisitions.filter(input => input.acquisition?.id === acquisitionB.id);
      expect(continuations).toHaveLength(3);
      expect(continuations.map(input => input.acquisition)).toEqual([
        acquisitionB,
        acquisitionB,
        acquisitionB,
      ]);
      expect(continuations.every(input => input.allowCreate === undefined)).toBe(true);
      expect(
        replacementRequests
          .filter(request => request.operation === 'session.prompt')
          .map(request => sessionPromptPayloadSchema.parse(request.payload).messageId)
      ).toEqual(['msg_after_cancel_b']);
      expect(requests.filter(request => request.operation === 'session.prompt')).toEqual([]);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.stop).toHaveBeenCalledTimes(2);
      expect(allocations).toEqual(new Set([launch[0]]));
    } finally {
      if (held && socket.readyState === WebSocket.OPEN) acceptControlRequest(socket, held);
      await dispatch;
      await session.interruptExecution();
      stream?.close();
      socket.close();
      replacement?.close();
    }
  });

  it.each(['session.attach', 'session.prompt'] as const)(
    'rejects delayed cancelled A %s RPCs without reaching or renewing replacement B',
    async operation => {
      const { fixture, session } = messageFixture();
      const { control, socket, provider, allocations } = await initializeTerminalRuntime(fixture);
      const release = Promise.withResolvers<void>();
      let heldRequest: Parameters<typeof control.request>[0] | undefined;
      let delayedResponse: ResponseFrame | undefined;
      let delayedError: unknown;
      let transferUnavailable = true;
      let dispatchA: Promise<void> | undefined;
      let dispatchB: Promise<boolean> | undefined;
      let replacement: WebSocket | undefined;
      let replacementAttachment: RequestFrame | undefined;
      const clock = vi.spyOn(Date, 'now');
      provider.stop.mockResolvedValue('retryable');
      await runInDurableObject(control, instance => {
        const prototype = Object.getPrototypeOf(instance) as typeof instance;
        const request = instance.request.bind(instance);
        const quarantine = instance.quarantineRuntime.bind(instance);
        vi.spyOn(prototype, 'request').mockImplementation(async input => {
          if (heldRequest || input.operation !== operation) return request(input);
          heldRequest = input;
          await release.promise;
          try {
            delayedResponse = await request(input);
            return delayedResponse;
          } catch (error) {
            delayedError = error;
            throw error;
          }
        });
        vi.spyOn(prototype, 'quarantineRuntime').mockImplementation(input => {
          if (transferUnavailable) throw new Error('temporary quarantine transfer failure');
          return quarantine(input);
        });
      });
      const oldRequests = captureAndAcceptControlRequests(socket);
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        await session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: 'kilo_terminal' },
          agent: agentA,
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: { initialTurn: { type: 'prompt', messageId: 'msg_delayed_a', prompt: 'A' } },
        });
        await vi.waitFor(() => expect(heldRequest).toBeDefined());
        expect(heldRequest).toMatchObject({
          operation,
          session: {
            sessionId: fixture.sessionId,
            kiloSessionId: 'kilo_terminal',
            directory: '/workspace/terminal',
          },
        });
        expect(oldRequests.filter(request => request.operation === operation)).toEqual([]);
        let joined = false;
        dispatchA = runInDurableObject(session, instance => {
          joined = true;
          return instance.alarm();
        });
        await vi.waitFor(() => expect(joined).toBe(true));
        await expect(session.interruptExecution()).resolves.toEqual({ success: true });
        await expect(session.getMessageResult('msg_delayed_a')).resolves.toMatchObject({
          type: 'found',
          result: { status: 'interrupted' },
        });
        await runInDurableObject(session, (_instance, state) => {
          expect(state.storage.kv.get('pending_runtime_cleanup')).toMatchObject({
            wrapperInstanceId: fixture.wrapperInstanceId,
            reason: 'preparation_interrupted',
          });
        });
        await expect(
          session.admitSubmittedMessage({
            userId: fixture.ownerId,
            turn: { type: 'prompt', id: 'msg_replacement_b', prompt: 'B' },
          })
        ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'queued' });
        await vi.waitFor(async () => {
          expect((await admissionState(session)).messages[1]).toMatchObject({
            state: 'queued',
            preparationAttemptId: expect.any(String),
            deliveryDeadlineAt: expect.any(Number),
          });
        });
        expect(provider.stop).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();
        expect(delayedResponse).toBeUndefined();
        expect(delayedError).toBeUndefined();

        transferUnavailable = false;
        await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
        await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
        await expect(control.getPhysicalRecord()).resolves.toMatchObject({
          state: 'stopping',
          providerRef: fixture.sandboxId,
        });
        allocations.delete(fixture.sandboxId);
        await fireControlDeadline(control, 'stopAttempt');
        await expect(control.getPhysicalRecord()).resolves.toMatchObject({
          state: 'stopped',
          providerRef: null,
        });
        await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
        expect(provider.launch).toHaveBeenCalledTimes(1);
        const launch = provider.launch.mock.calls[0];
        if (!launch) throw new Error('Expected a replacement allocation for B');
        expect(launch[0]).not.toBe(fixture.sandboxId);
        const replacementFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
        replacement = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
        await completeHello(replacement, 'hello_delayed_rpc_replacement', {
          providerInstanceId: launch[0],
          wrapperInstanceId: replacementFixture.wrapperInstanceId,
        });
        const replacementRequests = captureAndAcceptControlRequests(replacement, request => {
          if (request.operation !== 'session.attach' || replacementAttachment) return false;
          replacementAttachment = request;
          return true;
        });
        signalWrapperReady(replacement);
        await waitForWrapperReady(replacementFixture);
        dispatchB = runDurableObjectAlarm(session);
        await vi.waitFor(() => expect(replacementAttachment).toBeDefined());
        if (!replacementAttachment) throw new Error('Expected B attachment before its prompt');
        expect(replacementAttachment).toMatchObject({
          operation: 'session.attach',
          payload: { preparation: { triggerMessageId: 'msg_replacement_b' } },
        });
        const beforeDelivery = await admissionState(session);
        expect(beforeDelivery.messages).toMatchObject([
          { messageId: 'msg_delayed_a', state: 'cancelled' },
          {
            messageId: 'msg_replacement_b',
            state: 'queued',
            wrapperInstanceId: replacementFixture.wrapperInstanceId,
          },
        ]);
        const deadlinesBefore = await runInDurableObject(control, async (_instance, state) => ({
          deadlines: await loadDeadlines(state.storage),
          alarmAt: await state.storage.getAlarm(),
        }));
        expect(deadlinesBefore.deadlines.idleStop).toEqual(expect.any(Number));
        clock.mockReturnValue(Date.now() + 1_000);
        await runInDurableObject(control, () => release.resolve());
        await dispatchA;
        expect([...replacementRequests]).toEqual([replacementAttachment]);
        expect(delayedResponse).toBeUndefined();
        expect(delayedError).toMatchObject({ message: 'Sandbox wrapper runtime changed' });
        expect(await admissionState(session)).toEqual(beforeDelivery);
        await runInDurableObject(control, async (_instance, state) => {
          expect(await loadDeadlines(state.storage)).toEqual(deadlinesBefore.deadlines);
          expect(await state.storage.getAlarm()).toBe(deadlinesBefore.alarmAt);
        });
        clock.mockRestore();

        acceptControlRequest(replacement, replacementAttachment);
        replacementAttachment = undefined;
        await expect(dispatchB).resolves.toBe(true);
        await waitForAccepted(session, 'msg_replacement_b');
        expect(replacementRequests.map(request => request.operation)).toEqual([
          'session.attach',
          'session.prompt',
        ]);
        expect(
          replacementRequests
            .filter(request => request.operation === 'session.prompt')
            .map(request => sessionPromptPayloadSchema.parse(request.payload).messageId)
        ).toEqual(['msg_replacement_b']);
        expect(oldRequests.filter(request => request.operation === operation)).toEqual([]);
        expect((await admissionState(session)).messages).toMatchObject([
          { messageId: 'msg_delayed_a', state: 'cancelled' },
          {
            ...beforeDelivery.messages[1],
            state: 'accepted',
            wrapperInstanceId: replacementFixture.wrapperInstanceId,
          },
        ]);
        await expect(control.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: replacementFixture.wrapperInstanceId,
        });
        expect(provider.create).toHaveBeenCalledTimes(1);
        expect(provider.stop).toHaveBeenCalledTimes(2);
        expect(allocations).toEqual(new Set([launch[0]]));
      } finally {
        release.resolve();
        if (replacementAttachment && replacement?.readyState === WebSocket.OPEN) {
          acceptControlRequest(replacement, replacementAttachment);
        }
        await dispatchA;
        await dispatchB;
        clock.mockRestore();
        await session.interruptExecution();
        socket.close();
        replacement?.close();
      }
    }
  );

  it('persists an admission alarm before the first RPC and recovers the head on a fresh ID after reset', async () => {
    const { fixture, session: originalSession } = messageFixture();
    let session = originalSession;
    const { control, socket, provider } = await initializeTerminalRuntime(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);
    const requests = captureAndAcceptControlRequests(socket);
    let entered = false;
    const release = Promise.withResolvers<void>();
    await runInDurableObject(control, instance => {
      const prototype = Object.getPrototypeOf(instance) as typeof instance;
      const getStatus = instance.getStatus.bind(instance);
      vi.spyOn(prototype, 'getStatus').mockImplementationOnce(async () => {
        entered = true;
        await release.promise;
        return getStatus();
      });
    });
    try {
      const admittedAt = Date.now();
      await expect(
        session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: 'kilo_terminal' },
          agent: agentA,
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: { initialTurn: { type: 'prompt', messageId: 'msg_stranded', prompt: 'head A' } },
        })
      ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'queued' });
      await vi.waitFor(() => expect(entered).toBe(true));
      const before = await admissionState(session);
      const alarmAt = await runInDurableObject(session, (_instance, state) =>
        state.storage.getAlarm()
      );
      expect(alarmAt).toBeGreaterThanOrEqual(admittedAt);
      expect(before.messages).toMatchObject([
        {
          messageId: 'msg_stranded',
          state: 'queued',
          deliveryDeadlineAt: expect.any(Number),
          preparationAttemptId: expect.any(String),
        },
      ]);
      expect(before.messages[0]?.deliveryDeadlineAt).toBeGreaterThanOrEqual(
        admittedAt + SESSION_DELIVERY_TIMEOUT_MS
      );
      expect(provider.create).not.toHaveBeenCalled();

      await expect(
        runInDurableObject(session, (_instance, state) => state.abort('admission reset'))
      ).rejects.toThrow('admission reset');
      release.resolve();
      session = env.SANDBOX_SESSION.get(env.SANDBOX_SESSION.idFromString(session.id.toString()));
      expect(await admissionState(session)).toEqual(before);
      expect(
        await runInDurableObject(session, (_instance, state) => state.storage.getAlarm())
      ).toBe(alarmAt);
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_fresh', command: 'status', arguments: '' },
        })
      ).resolves.toMatchObject({ success: true });
      await waitForAccepted(session, 'msg_stranded');
      const recovered = await admissionState(session);
      expect(recovered.messages).toMatchObject([
        {
          ...before.messages[0],
          state: 'accepted',
          wrapperInstanceId: fixture.wrapperInstanceId,
        },
        { messageId: 'msg_fresh', state: 'queued' },
      ]);
      expect(requests.filter(request => request.operation === 'session.prompt')).toHaveLength(1);
      sendOutcome(socket, 'msg_stranded');
      await waitForAccepted(session, 'msg_fresh');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => sessionPromptPayloadSchema.parse(request.payload).messageId)
      ).toEqual(['msg_stranded', 'msg_fresh']);
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.launch).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await session.interruptExecution();
      socket.close();
    }
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'persists an early %s outcome and never resurrects it when acknowledgement arrives late',
    async status => {
      const { fixture, session } = messageFixture();
      const { control, socket, provider } = await initializeTerminalRuntime(fixture);
      const prompt = Promise.withResolvers<RequestFrame>();
      let held: RequestFrame | undefined;
      let dispatch: Promise<void> | undefined;
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        captureAndAcceptControlRequests(socket, request => {
          if (
            request.operation !== 'session.prompt' ||
            sessionPromptPayloadSchema.parse(request.payload).messageId !== 'msg_early'
          )
            return false;
          held = request;
          prompt.resolve(request);
          return true;
        });
        await session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: 'kilo_terminal' },
          agent: agentA,
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: {
            initialTurn: {
              type: 'command',
              messageId: 'msg_early',
              command: 'review',
              arguments: '--all',
            },
          },
        });
        const request = await prompt.promise;
        await session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_after_early', command: 'status', arguments: '' },
        });
        let joined = false;
        dispatch = runInDurableObject(session, instance => {
          joined = true;
          return instance.alarm();
        });
        await vi.waitFor(() => expect(joined).toBe(true));
        sendOutcome(socket, 'msg_early', status);
        await vi.waitFor(async () => {
          await expect(session.getMessageResult('msg_early')).resolves.toMatchObject({
            type: 'found',
            result: { status: status === 'cancelled' ? 'interrupted' : status },
          });
        });
        await waitForAccepted(session, 'msg_after_early');
        const terminal = await admissionState(session);
        const events = await lifecycleEvents(session);
        expect(events.filter(event => event.data.messageId === 'msg_early')).toMatchObject([
          {
            type: status === 'completed' ? 'cloud.message.completed' : 'cloud.message.failed',
            data: {
              messageId: 'msg_early',
              status: status === 'cancelled' ? 'interrupted' : status,
              delivery: 'sent',
              accepted: true,
            },
          },
        ]);
        acceptControlRequest(socket, request);
        held = undefined;
        await dispatch;
        expect(await admissionState(session)).toEqual(terminal);
        expect(await lifecycleEvents(session)).toEqual(events);
        await expect(
          session.admitSubmittedMessage({
            userId: fixture.ownerId,
            turn: { type: 'command', id: 'msg_early', command: 'review', arguments: '--all' },
          })
        ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
        await expect(control.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: fixture.wrapperInstanceId,
        });
        expect(provider.stop).not.toHaveBeenCalled();
      } finally {
        if (held && socket.readyState === WebSocket.OPEN) acceptControlRequest(socket, held);
        await dispatch;
        await session.interruptExecution();
        socket.close();
      }
    }
  );

  it('ignores an old outcome and late preparation after B is accepted without quarantining B', async () => {
    const { fixture, session } = messageFixture();
    const { control, socket, provider } = await initializeTerminalRuntime(fixture);
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      captureAndAcceptControlRequests(socket);
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: { initialTurn: { type: 'prompt', messageId: 'msg_old_a', prompt: 'A' } },
      });
      await waitForAccepted(session, 'msg_old_a');
      const attemptId = (await admissionState(session)).messages[0]?.preparationAttemptId;
      expect(attemptId).toEqual(expect.any(String));
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'command', id: 'msg_current_b', command: 'status', arguments: '' },
      });
      sendOutcome(socket, 'msg_old_a');
      await waitForAccepted(session, 'msg_current_b');
      const events = await lifecycleEvents(session);
      sendOutcome(socket, 'msg_old_a');
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'session.preparing',
          session: { directory: '/workspace/terminal', kiloSessionId: 'kilo_terminal' },
          payload: {
            version: 2,
            attemptId,
            triggerMessageId: 'msg_old_a',
            revision: 100,
            timestamp: Date.now(),
            step: 'workspace_setup',
            message: 'late setup result',
            action: 'update',
          },
        })
      );
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'session.event',
          session: { directory: '/workspace/terminal', kiloSessionId: 'kilo_terminal' },
          payload: {
            type: 'session.status',
            properties: { sessionID: 'kilo_terminal', status: { type: 'busy' } },
          },
        })
      );
      await vi.waitFor(async () => {
        await runInDurableObject(session, (_instance, state) => {
          const stored = createEventQueries(
            drizzle(state.storage, { logger: false }),
            state.storage.sql
          ).findByFilters({ eventTypes: ['kilocode'] });
          expect(stored.map(event => JSON.parse(event.payload))).toContainEqual(
            expect.objectContaining({ type: 'session.status' })
          );
        });
      });
      expect((await admissionState(session)).messages).toMatchObject([
        { messageId: 'msg_old_a', state: 'completed' },
        {
          messageId: 'msg_current_b',
          state: 'accepted',
          wrapperInstanceId: fixture.wrapperInstanceId,
        },
      ]);
      expect(await lifecycleEvents(session)).toEqual(events);
      await expect(control.getStatus()).resolves.toMatchObject({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: fixture.wrapperInstanceId,
      });
      expect(provider.stop).not.toHaveBeenCalled();
      sendOutcome(socket, 'msg_current_b');
      await vi.waitFor(async () => {
        await expect(session.getMessageResult('msg_current_b')).resolves.toMatchObject({
          type: 'found',
          result: { status: 'completed' },
        });
      });
    } finally {
      await session.interruptExecution();
      socket.close();
    }
  });

  it.each(['execution', 'setup'] as const)(
    'actually stops %s when markAsInterrupted precedes interruptExecution',
    async phase => {
      const { fixture, session } = messageFixture();
      const { control, socket, provider, allocations } = await initializeTerminalRuntime(fixture);
      const entered = Promise.withResolvers<void>();
      let activeWork = false;
      let held: RequestFrame | undefined;
      provider.stop.mockImplementation(async ref => {
        activeWork = false;
        if (ref) allocations.delete(ref);
        return 'terminal';
      });
      const requests = captureAndAcceptControlRequests(socket, request => {
        if (request.operation === 'session.attach' && phase === 'setup') {
          activeWork = true;
          held = request;
          entered.resolve();
          return true;
        }
        if (request.operation === 'session.prompt') {
          activeWork = true;
          entered.resolve();
        }
        if (request.operation === 'session.abort') activeWork = false;
        return false;
      });
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        await session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: 'kilo_terminal' },
          agent: agentA,
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: {
            initialTurn: { type: 'prompt', messageId: 'msg_interrupt', prompt: 'interrupt me' },
          },
        });
        await entered.promise;
        if (phase === 'execution') await waitForAccepted(session, 'msg_interrupt');
        await session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_cancel_follower', command: 'status', arguments: '' },
        });
        expect(activeWork).toBe(true);
        if (phase === 'setup') {
          await expect(control.detachSession(fixture.sessionId)).resolves.toEqual({
            existed: true,
          });
        }
        await session.markAsInterrupted();
        await expect(session.interruptExecution()).resolves.toMatchObject({ success: true });
        await vi.waitFor(() => expect(activeWork).toBe(false));
        expect((await admissionState(session)).messages).toMatchObject([
          { messageId: 'msg_interrupt', state: 'cancelled' },
          { messageId: 'msg_cancel_follower', state: 'cancelled' },
        ]);
        if (phase === 'execution') {
          expect(requests.filter(request => request.operation === 'session.abort')).toMatchObject([
            {
              session: {
                sessionId: fixture.sessionId,
                kiloSessionId: 'kilo_terminal',
                directory: '/workspace/terminal',
              },
              payload: { messageId: 'msg_interrupt' },
            },
          ]);
          expect(provider.stop).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(async () => {
            await expect(control.getPhysicalRecord()).resolves.toMatchObject({
              state: 'stopped',
              providerRef: null,
            });
          });
          expect(provider.stop).toHaveBeenCalledTimes(1);
          expect(provider.stop.mock.calls[0]?.[0]).toBe(fixture.sandboxId);
          expect(requests.filter(request => request.operation === 'session.prompt')).toEqual([]);
        }
        const events = await lifecycleEvents(session);
        const failures = events.filter(event => event.type === 'cloud.message.failed');
        expect(failures.map(event => event.data.messageId).sort()).toEqual([
          'msg_cancel_follower',
          'msg_interrupt',
        ]);
        expect(
          failures.find(event => event.data.messageId === 'msg_interrupt')?.data
        ).toMatchObject({
          status: 'interrupted',
          accepted: phase === 'execution',
        });
        expect(
          failures.find(event => event.data.messageId === 'msg_cancel_follower')?.data
        ).toMatchObject({
          status: 'interrupted',
          accepted: false,
        });
        await runInDurableObject(session, instance => instance.alarm());
        expect(provider.create).not.toHaveBeenCalled();
      } finally {
        if (held && socket.readyState === WebSocket.OPEN) acceptControlRequest(socket, held);
        await session.interruptExecution();
        socket.close();
      }
    }
  );

  it('continues slow physical cleanup and waits for a fresh message to create a replacement', async () => {
    const { fixture, session } = messageFixture();
    const { control, socket, provider, allocations } = await initializeTerminalRuntime(fixture);
    provider.stop.mockResolvedValue('retryable');
    let replacement: WebSocket | undefined;
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      captureAndAcceptControlRequests(socket);
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: { initialTurn: { type: 'prompt', messageId: 'msg_unhealthy', prompt: 'A' } },
      });
      await waitForAccepted(session, 'msg_unhealthy');
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'sandbox.heartbeat',
          payload: { state: 'active', kilo: { ready: false }, sessions: [] },
        })
      );
      await vi.waitFor(async () => {
        await expect(session.getMessageResult('msg_unhealthy')).resolves.toMatchObject({
          type: 'found',
          result: { status: 'failed' },
        });
        await runInDurableObject(control, async (instance, state) => {
          expect((await instance.getPhysicalRecord()).stopTombstone?.attempts).toBe(1);
          expect((await loadDeadlines(state.storage)).stopAttempt).toBeLessThan(
            Date.now() + DEADLINE_MS.stopAttempt
          );
        });
      });
      expect(
        (await lifecycleEvents(session)).filter(event => event.type === 'cloud.message.failed')
      ).toMatchObject([
        {
          data: {
            messageId: 'msg_unhealthy',
            accepted: true,
            delivery: 'sent',
            reason: 'kilo_unhealthy',
          },
        },
      ]);
      expect(provider.stop).toHaveBeenCalledTimes(1);
      for (let attempt = 2; attempt <= DEADLINE_MS.stopAttemptLadder.length; attempt++) {
        await fireControlDeadline(control, 'stopAttempt');
        expect(provider.stop.mock.calls.map(([ref]) => ref)).toEqual(
          Array.from({ length: attempt }, () => fixture.sandboxId)
        );
        expect((await control.getPhysicalRecord()).stopTombstone?.attempts).toBe(attempt);
      }
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'unknown',
        providerRef: fixture.sandboxId,
        stopTombstone: { attempts: 5, wrapperInstanceId: fixture.wrapperInstanceId },
      });
      await expect(control.getStatus()).resolves.toMatchObject({ connection: 'disconnected' });
      const observations = provider.observe.mock.calls.length;
      await fireControlDeadline(control, 'reconciliation');
      expect(provider.stop).toHaveBeenCalledTimes(6);
      await fireControlDeadline(control, 'reconciliation');
      expect(provider.observe).toHaveBeenCalledTimes(observations + 2);
      expect(provider.stop.mock.calls.map(([ref]) => ref)).toEqual(
        Array.from({ length: 7 }, () => fixture.sandboxId)
      );
      expect((await control.getPhysicalRecord()).stopTombstone?.attempts).toBe(5);
      expect(provider.create).not.toHaveBeenCalled();

      allocations.delete(fixture.sandboxId);
      await fireControlDeadline(control, 'reconciliation');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        stopTombstone: null,
      });
      await runInDurableObject(session, instance => instance.alarm());
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.launch).not.toHaveBeenCalled();
      const nextFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_recovered', prompt: 'try again' },
        })
      ).resolves.toMatchObject({ success: true });
      await vi.waitFor(() => expect(provider.launch).toHaveBeenCalledTimes(1));
      const launch = provider.launch.mock.calls[0];
      if (!launch) throw new Error('Expected replacement wrapper launch');
      expect(launch[0]).not.toBe(fixture.sandboxId);
      expect((await control.getPhysicalRecord()).providerRef).toBe(launch[0]);
      replacement = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
      await completeHello(replacement, 'hello_cleanup_recovery', {
        providerInstanceId: launch[0],
        wrapperInstanceId: nextFixture.wrapperInstanceId,
      });
      captureAndAcceptControlRequests(replacement);
      signalWrapperReady(replacement);
      await waitForWrapperReady(nextFixture);
      await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
      await waitForAccepted(session, 'msg_recovered');
      await session.failWaitingMessages('late_old_runtime_failure', fixture.wrapperInstanceId);
      expect((await admissionState(session)).messages).toMatchObject([
        { messageId: 'msg_unhealthy', state: 'failed', failedReason: 'kilo_unhealthy' },
        {
          messageId: 'msg_recovered',
          state: 'accepted',
          wrapperInstanceId: nextFixture.wrapperInstanceId,
        },
      ]);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.launch).toHaveBeenCalledTimes(1);
      expect(provider.stop).toHaveBeenCalledTimes(7);
      expect(provider.create.mock.calls[0]?.[0]).toMatchObject({
        createdAt: expect.any(Number),
        billing: { sandboxId: fixture.sandboxId, actor: { type: 'user', id: fixture.ownerId } },
      });
    } finally {
      await session.interruptExecution();
      socket.close();
      replacement?.close();
    }
  });

  it('normalizes initial and command models once without preflight or leaking session finalization', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    const finalization = {
      autoCommit: true,
      condenseOnComplete: true,
      gateThreshold: 'warning',
    } as const;
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      const requests = captureAndAcceptControlRequests(socket);
      await expect(
        session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: 'kilo_terminal' },
          agent: { mode: 'architect', model: 'kilo/fake-deterministic', variant: 'high' },
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          finalization,
          message: {
            initialTurn: {
              type: 'prompt',
              messageId: 'msg_initial_model',
              prompt: 'initial prompt',
            },
          },
        })
      ).resolves.toMatchObject({ success: true });
      await waitForAccepted(session, 'msg_initial_model');
      await completeTurn(session, 'msg_initial_model', fixture.wrapperInstanceId);
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_command_model', command: 'review', arguments: '--all' },
          agent: { mode: 'reviewer', model: ' kilo/kilo/example ', variant: 'low' },
        })
      ).resolves.toMatchObject({ success: true });
      await waitForAccepted(session, 'msg_command_model');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_initial_model',
          turn: { type: 'prompt', prompt: 'initial prompt' },
          agent: { mode: 'architect', model: 'fake-deterministic', variant: 'high' },
          finalization: { autoCommit: true, condenseOnComplete: true },
        },
        {
          messageId: 'msg_command_model',
          turn: { type: 'command', command: 'review', arguments: '--all' },
          agent: { mode: 'reviewer', model: 'kilo/example', variant: 'low' },
        },
      ]);
      expect((await admissionState(session)).metadata?.finalization).toEqual(finalization);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await session.interruptExecution();
      socket.close();
    }
  });

  it('delivers frozen A then B after eviction and reconnect without replay rewinding defaults', async () => {
    const { fixture, session: originalSession } = messageFixture();
    let session = originalSession;
    const credential = generateSandboxCredential();
    await seedCredential(credential, fixture.sandboxId);
    await installProvider(env.SANDBOX_CONTROL.getByName(fixture.sandboxId), fixture.sandboxId);
    const socket = await connect(credential, fixture.sandboxId);
    let replacement: WebSocket | undefined;
    try {
      const waitingRequests = captureAndAcceptControlRequests(socket);
      await expect(
        session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: 'kilo_terminal' },
          agent: agentA,
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: { initialTurn: { type: 'prompt', messageId: 'msg_a', prompt: 'A' } },
        })
      ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'queued' });
      await runInDurableObject(session, instance => instance.alarm());
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_b', prompt: 'B' },
          agent: { model: modelB, mode: 'reviewer' },
        })
      ).resolves.toMatchObject({ success: true });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_c', prompt: 'inherits B' },
        })
      ).resolves.toMatchObject({ success: true });
      const beforeReplay = await admissionState(session);
      expect(beforeReplay.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      const replay: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_a', prompt: 'A' },
        agent: { model: 'anthropic/claude-sonnet-4' },
      };
      await expect(session.admitSubmittedMessage(replay)).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'queued',
      });
      await expect(
        session.admitSubmittedMessage({ ...replay, agent: { model: modelB } })
      ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
      await runInDurableObject(session, instance => instance.alarm());
      expect(await admissionState(session)).toEqual(beforeReplay);
      expect(waitingRequests).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);

      await abortAllDurableObjects();
      session = env.SANDBOX_SESSION.get(env.SANDBOX_SESSION.idFromString(session.id.toString()));
      expect(await admissionState(session)).toEqual(beforeReplay);
      replacement = await connect(credential, fixture.sandboxId);
      await completeHello(replacement, 'hello_frozen_recreated', {
        providerInstanceId: fixture.sandboxId,
        wrapperInstanceId: fixture.wrapperInstanceId,
      });
      const requests = captureAndAcceptControlRequests(replacement);
      signalWrapperReady(replacement);
      await waitForWrapperReady(fixture);
      await runInDurableObject(session, instance => instance.alarm());
      await waitForAccepted(session, 'msg_a');
      const accepted = await admissionState(session);
      await expect(session.admitSubmittedMessage(replay)).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'sent',
      });
      expect(await admissionState(session)).toEqual(accepted);
      await completeTurn(session, 'msg_a', fixture.wrapperInstanceId);
      await waitForAccepted(session, 'msg_b');
      await completeTurn(session, 'msg_b', fixture.wrapperInstanceId);
      await waitForAccepted(session, 'msg_c');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_a',
          turn: { type: 'prompt', prompt: 'A' },
          agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
        },
        {
          messageId: 'msg_b',
          turn: { type: 'prompt', prompt: 'B' },
          agent: { mode: 'reviewer', model: 'openai/gpt-4.1' },
        },
        {
          messageId: 'msg_c',
          turn: { type: 'prompt', prompt: 'inherits B' },
          agent: { mode: 'code', model: 'openai/gpt-4.1' },
        },
      ]);
      const terminal = await admissionState(session);
      await expect(session.admitSubmittedMessage(replay)).resolves.toMatchObject({
        success: false,
        code: 'BAD_REQUEST',
      });
      expect(await admissionState(session)).toEqual(terminal);
      expect(terminal.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      socket.close();
      replacement?.close();
    }
  });

  it('uses only the preflighted initial agent even when registered defaults have changed', async () => {
    const { fixture, session } = await seedBlockedAdmission({
      mode: 'architect',
      model: modelB,
      variant: 'low',
    });
    await expect(
      session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: { mode: 'reviewer', model: agentA.model },
        message: { initialTurn: { type: 'prompt', messageId: 'msg_initial', prompt: 'initial' } },
      })
    ).resolves.toMatchObject({ success: true });
    const state = await admissionState(session);
    expect(state.messages[1]?.intent).toEqual({
      turn: { type: 'prompt', messageId: 'msg_initial', prompt: 'initial' },
      agent: { mode: 'reviewer', model: agentA.model },
    });
    expect(state.metadata?.agent).toEqual({ mode: 'architect', model: agentA.model });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('permanently fails a legacy prompt without a model while a new command stays model-less after defaults change', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    const legacy: SessionMessageRecord = {
      messageId: 'msg_invalid_model',
      state: 'queued',
      prompt: 'never deliver',
      attachFailures: 1,
      promptFailures: 2,
    };
    try {
      const requests = captureAndAcceptControlRequests(socket);
      await session.registerSession({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: { mode: 'code' },
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
      });
      await runInDurableObject(session, (_instance, state) => {
        state.storage.kv.put('session_messages', [legacy]);
      });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_model_less', command: 'status', arguments: '--all' },
          agent: { mode: 'reviewer' },
        })
      ).resolves.toMatchObject({ success: true });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_selected', prompt: 'new B cannot rescue old input' },
          agent: { model: modelB },
        })
      ).resolves.toMatchObject({ success: true });
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await runInDurableObject(session, instance => instance.alarm());
      await waitForAccepted(session, 'msg_model_less');
      const delivered = await admissionState(session);
      expect(delivered.messages[0]).toEqual({
        ...legacy,
        state: 'failed',
        failedReason: 'invalid_model',
        legacyIntentInvalid: true,
        preparationAttemptId: expect.any(String),
        deliveryDeadlineAt: expect.any(Number),
        terminalAt: expect.any(Number),
      });
      expect(delivered.messages.slice(1)).toMatchObject([
        { messageId: 'msg_model_less', state: 'accepted' },
        { messageId: 'msg_selected', state: 'queued', intent: { agent: { model: modelB } } },
      ]);
      expect(delivered.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      await runInDurableObject(session, instance => instance.alarm());
      await runInDurableObject(session, instance => instance.alarm());
      expect(await admissionState(session)).toEqual(delivered);
      expect(requests.map(request => request.operation)).toEqual([
        'session.attach',
        'session.prompt',
      ]);
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_model_less',
          turn: { type: 'command', command: 'status', arguments: '--all' },
          agent: { mode: 'reviewer' },
        },
      ]);
      await runInDurableObject(session, (_instance, state) => {
        const events = createEventQueries(
          drizzle(state.storage, { logger: false }),
          state.storage.sql
        ).findByFilters({ eventTypes: ['cloud.message.failed'] });
        expect(events.map(event => JSON.parse(event.payload))).toMatchObject([
          { messageId: 'msg_invalid_model', reason: 'invalid_model', accepted: false },
        ]);
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await session.interruptExecution();
      socket.close();
    }
  });

  it.each([
    {
      status: 200,
      body: { valid: false, reason: 'unavailable' },
      code: 'BAD_REQUEST',
      publicCode: 'BAD_REQUEST',
      error: 'Selected model is not available for this cloud agent session',
      retryable: false,
    },
    {
      status: 403,
      body: {},
      code: 'FORBIDDEN',
      publicCode: 'FORBIDDEN',
      error: 'Model catalog access denied for this cloud agent session',
      retryable: false,
    },
    {
      status: 503,
      body: {},
      code: 'MODEL_VALIDATION_UNAVAILABLE',
      publicCode: 'SERVICE_UNAVAILABLE',
      error: 'Model availability could not be verified',
      retryable: true,
    },
  ])(
    'preserves $code over real admission RPC without queue or metadata mutation',
    async outcome => {
      const { fixture, session } = await seedBlockedAdmission();
      await runInDurableObject(session, (_instance, state) => {
        const messages = state.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
        state.storage.kv.put('session_messages', [
          ...messages,
          { messageId: 'msg_legacy', state: 'queued', prompt: 'retain old format on rejection' },
        ] satisfies SessionMessageRecord[]);
      });
      const before = await admissionState(session);
      vi.mocked(globalThis.fetch).mockImplementation(async () =>
        Response.json(outcome.body, { status: outcome.status })
      );
      const result = await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_rejected', prompt: 'B' },
        agent: { model: modelB, mode: 'reviewer', variant: 'low' },
      });
      expect(result).toEqual({ success: false, code: outcome.code, error: outcome.error });
      expect(await admissionState(session)).toEqual(before);
      if (result.success) throw new Error('Expected model admission failure');
      expect(() => throwAdmissionError(result)).toThrowError(
        expect.objectContaining({
          code: outcome.publicCode,
          message: outcome.error,
          cause: expect.objectContaining({ error: outcome.code, retryable: outcome.retryable }),
        })
      );
      const [input, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/api/organizations/stored-org/models/validate');
      expect(request.headers.get('Authorization')).toBe('Bearer stored-test-token');
      expect(request.headers.get('X-KiloCode-OrganizationId')).toBe('stored-org');
      expect(request.headers.get('X-KiloCode-Feature')).toBe('stored-platform');
      expect(await request.json()).toEqual({ modelId: 'openai/gpt-4.1' });
    }
  );

  it('rejects an omitted prompt model without a stored default and does not mutate admission state', async () => {
    const { fixture, session } = await seedBlockedAdmission({ mode: 'code' });
    const before = await admissionState(session);
    await expect(
      session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_missing', prompt: 'missing selection' },
      })
    ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(await admissionState(session)).toEqual(before);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  function pauseNextValidation() {
    let entered = false;
    let released = false;
    let body: unknown;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async (_input, init) => {
      body = init?.body;
      entered = true;
      while (!released) await new Promise(resolve => setTimeout(resolve, 1));
      return Response.json({ valid: true });
    });
    return {
      entered: async () => {
        await vi.waitFor(() => expect(entered).toBe(true));
        if (typeof body !== 'string') throw new Error('Expected validation request body');
        return JSON.parse(body) as unknown;
      },
      release: () => {
        released = true;
      },
    };
  }

  it('keeps the validated selection frozen while concurrent admission changes defaults and metadata', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const validation = pauseNextValidation();
    const pending = session.admitSubmittedMessage({
      userId: fixture.ownerId,
      turn: { type: 'prompt', id: 'msg_slow_a', prompt: 'resolved A before validation' },
    });
    try {
      expect(await validation.entered()).toEqual({ modelId: 'anthropic/claude-sonnet-4' });
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'command', id: 'msg_fast_b', command: 'review', arguments: '' },
        agent: { model: modelB, mode: 'reviewer', variant: 'low' },
      });
      await session.tryUpdate({ callbackTarget: { url: 'https://example.com/updated-callback' } });
      expect((await admissionState(session)).metadata?.agent).toEqual({
        mode: 'code',
        model: modelB,
        variant: 'low',
      });
      validation.release();
      await expect(pending).resolves.toMatchObject({ success: true });
      const state = await admissionState(session);
      expect(state.messages.slice(1).map(message => message.intent?.agent)).toEqual([
        { mode: 'reviewer', model: modelB, variant: 'low' },
        agentA,
      ]);
      expect(state.metadata?.agent).toEqual(agentA);
      expect(state.metadata?.callback).toEqual({
        target: { url: 'https://example.com/updated-callback' },
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      validation.release();
      await pending;
    }
  });

  it.each([
    { conflict: 'model', initialAgent: agentA, nextAgent: { model: modelB } },
    {
      conflict: 'absent variant',
      initialAgent: { mode: 'code', model: agentA.model },
      nextAgent: { model: agentA.model, variant: 'low' },
    },
  ])(
    'rechecks a concurrent duplicate with a different $conflict after validation',
    async ({ initialAgent, nextAgent }) => {
      const { fixture, session } = await seedBlockedAdmission(initialAgent);
      const validation = pauseNextValidation();
      const input: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_concurrent', prompt: 'same submitted content' },
      };
      const pending = session.admitSubmittedMessage(input);
      try {
        await validation.entered();
        await session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_change_default', command: 'review', arguments: '' },
          agent: nextAgent,
        });
        await expect(session.admitSubmittedMessage(input)).resolves.toMatchObject({
          success: true,
        });
        const winner = await admissionState(session);
        validation.release();
        await expect(pending).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
        expect(await admissionState(session)).toEqual(winner);
        expect(
          winner.messages.filter(message => message.messageId === 'msg_concurrent')
        ).toMatchObject([{ intent: { agent: nextAgent } }]);
      } finally {
        validation.release();
        await pending;
      }
    }
  );

  it('returns sent when a concurrent duplicate is accepted before validation completes without rewinding newer defaults', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    const validation = pauseNextValidation();
    let pending: ReturnType<SessionStub['admitSubmittedMessage']> | undefined;
    try {
      const requests = captureAndAcceptControlRequests(socket);
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await session.registerSession({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
      });
      const input: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_winner', prompt: 'accepted concurrent winner' },
      };
      pending = session.admitSubmittedMessage(input);
      await validation.entered();
      await session.admitSubmittedMessage(input);
      await waitForAccepted(session, 'msg_winner');
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'command', id: 'msg_new_defaults', command: 'review', arguments: '' },
        agent: { model: modelB },
      });
      const winner = await admissionState(session);
      validation.release();
      await expect(pending).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'sent',
      });
      expect(await admissionState(session)).toEqual(winner);
      expect(winner.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      expect(requests.filter(request => request.operation === 'session.prompt')).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      validation.release();
      await pending;
      socket.close();
    }
  });

  it('does not resurrect a duplicate message terminalized while validation is pending', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const validation = pauseNextValidation();
    const input: SubmittedSessionMessageRequest = {
      userId: fixture.ownerId,
      turn: { type: 'prompt', id: 'msg_terminal', prompt: 'cancel before validation returns' },
    };
    const pending = session.admitSubmittedMessage(input);
    try {
      await validation.entered();
      await session.admitSubmittedMessage(input);
      await session.markAsInterrupted();
      await session.interruptExecution();
      const terminal = await admissionState(session);
      validation.release();
      await expect(pending).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
      expect(await admissionState(session)).toEqual(terminal);
      expect(terminal.messages.find(message => message.messageId === 'msg_terminal')?.state).toBe(
        'cancelled'
      );
    } finally {
      validation.release();
      await pending;
    }
  });

  it('fences pending validation when the session is deleted', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const validation = pauseNextValidation();
    const pending = session.admitSubmittedMessage({
      userId: fixture.ownerId,
      turn: { type: 'prompt', id: 'msg_deleted_validation', prompt: 'do not recreate state' },
      agent: { model: modelB },
    });
    try {
      await validation.entered();
      await session.deleteSession();
      validation.release();
      await expect(pending).resolves.toEqual({
        success: false,
        code: 'NOT_FOUND',
        error: 'Session not found',
      });
      expect(await admissionState(session)).toEqual({ metadata: undefined, messages: [] });
      await expect(session.getMetadata()).resolves.toBeNull();
    } finally {
      validation.release();
      await pending;
    }
  });

  it('freezes both legacy queue formats before updating defaults and preserves history and retries', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const history: SessionMessageRecord[] = [
      ...(await admissionState(session)).messages,
      { messageId: 'msg_old_failed', state: 'failed', prompt: 'failed old content' },
    ];
    const legacy: SessionMessageRecord[] = [
      {
        messageId: 'msg_old_turn',
        state: 'queued',
        turn: { type: 'prompt', messageId: 'msg_old_turn', prompt: 'old turn A' },
        attachFailures: 1,
        promptFailures: 2,
        preparationAttemptId: 'attempt_old_turn',
      },
      { messageId: 'msg_old_prompt', state: 'queued', prompt: 'old prompt A' },
    ];
    await runInDurableObject(session, (_instance, state) => {
      state.storage.kv.put('session_messages', [...history, ...legacy]);
    });
    await expect(
      session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_new_b', prompt: 'new B' },
        agent: { model: modelB },
      })
    ).resolves.toMatchObject({ success: true });
    const frozen = await admissionState(session);
    expect(frozen.messages.slice(0, 2)).toEqual(history);
    expect(frozen.messages.slice(2).map(message => message.intent)).toEqual([
      { turn: { type: 'prompt', messageId: 'msg_old_turn', prompt: 'old turn A' }, agent: agentA },
      {
        turn: { type: 'prompt', messageId: 'msg_old_prompt', prompt: 'old prompt A' },
        agent: agentA,
      },
      {
        turn: { type: 'prompt', messageId: 'msg_new_b', prompt: 'new B' },
        agent: { mode: 'code', model: modelB },
      },
    ]);
    expect(frozen.messages[2]).toMatchObject({
      attachFailures: 1,
      promptFailures: 2,
      preparationAttemptId: 'attempt_old_turn',
    });
    expect(frozen.metadata?.agent).toEqual({ mode: 'code', model: modelB });
  });

  it('upgrades legacy queued delivery before awaiting control RPC even without new admission', async () => {
    const { fixture, session } = messageFixture();
    const { control, socket } = await initializeTerminalRuntime(fixture);
    let entered = false;
    let released = false;
    let dispatch: Promise<void> | undefined;
    try {
      const requests = captureAndAcceptControlRequests(socket);
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await session.registerSession({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
      });
      await runInDurableObject(session, (_instance, state) => {
        state.storage.kv.put('session_messages', [
          { messageId: 'msg_upgrade_a', state: 'queued', prompt: 'old A' },
        ] satisfies SessionMessageRecord[]);
      });
      await runInDurableObject(control, instance => {
        const prototype = Object.getPrototypeOf(instance) as typeof instance;
        const getStatus = instance.getStatus.bind(instance);
        vi.spyOn(prototype, 'getStatus').mockImplementationOnce(async () => {
          entered = true;
          while (!released) await new Promise(resolve => setTimeout(resolve, 1));
          return getStatus();
        });
      });
      dispatch = runInDurableObject(session, instance => instance.alarm());
      await vi.waitFor(() => expect(entered).toBe(true));
      expect((await admissionState(session)).messages[0]?.intent?.agent).toEqual(agentA);
      await runInDurableObject(session, async (instance, state) => {
        const metadata = await instance.getMetadata();
        if (!metadata) throw new Error('Expected registered metadata');
        state.storage.kv.put(
          'session_metadata',
          serializeSessionMetadata({ ...metadata, agent: { mode: 'architect', model: modelB } })
        );
      });
      released = true;
      await dispatch;
      await waitForAccepted(session, 'msg_upgrade_a');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_upgrade_a',
          turn: { type: 'prompt', prompt: 'old A' },
          agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
        },
      ]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      released = true;
      await dispatch;
      socket.close();
    }
  });

  it('coalesces replays and alarms during a rejected handoff and retries the same intent once', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    const requests: RequestFrame[] = [];
    const entered = Promise.withResolvers<RequestFrame>();
    let holdFirstPrompt = true;
    let held: RequestFrame | undefined;
    let alarm: Promise<void> | undefined;
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      socket.addEventListener('message', event => {
        const request = requestFrameSchema.parse(JSON.parse(String(event.data)));
        requests.push(request);
        if (request.operation === 'session.prompt' && holdFirstPrompt) {
          holdFirstPrompt = false;
          held = request;
          entered.resolve(request);
          return;
        }
        acceptControlRequest(socket, request);
      });
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: { initialTurn: { type: 'prompt', messageId: 'msg_retry_a', prompt: 'retry A' } },
      });
      const firstRequest = await entered.promise;
      const original = (await admissionState(session)).messages[0]?.intent;
      let alarmStarted = false;
      alarm = runInDurableObject(session, instance => {
        alarmStarted = true;
        return instance.alarm();
      });
      await vi.waitFor(() => expect(alarmStarted).toBe(true));
      const replay: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_retry_a', prompt: 'retry A' },
      };
      await expect(
        Promise.all([session.admitSubmittedMessage(replay), session.admitSubmittedMessage(replay)])
      ).resolves.toMatchObject([
        { success: true, compatibilityDelivery: 'queued' },
        { success: true, compatibilityDelivery: 'queued' },
      ]);
      expect(requests.map(request => request.operation)).toEqual([
        'session.attach',
        'session.prompt',
      ]);
      socket.send(
        JSON.stringify({
          type: 'response',
          requestId: firstRequest.requestId,
          ok: false,
          error: { code: 'not_ready', message: 'Retry prompt delivery', retryable: true },
        })
      );
      held = undefined;
      await alarm;
      expect((await admissionState(session)).messages[0]).toMatchObject({
        state: 'queued',
        promptFailures: 1,
        intent: original,
      });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_retry_b', prompt: 'new B' },
          agent: { model: modelB },
        })
      ).resolves.toMatchObject({ success: true });
      await runInDurableObject(session, instance => instance.alarm());
      await waitForAccepted(session, 'msg_retry_a');
      await runInDurableObject(session, instance => instance.alarm());
      const delivered = requests.filter(request => request.operation === 'session.prompt');
      expect(delivered).toHaveLength(2);
      expect(delivered[0]?.payload).toEqual(delivered[1]?.payload);
      expect(delivered[1]?.payload).toEqual({
        messageId: 'msg_retry_a',
        turn: { type: 'prompt', prompt: 'retry A' },
        agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
      });
      const accepted = await admissionState(session);
      expect(accepted.messages).toMatchObject([
        { messageId: 'msg_retry_a', state: 'accepted', promptFailures: 1, intent: original },
        { messageId: 'msg_retry_b', state: 'queued' },
      ]);
      expect(accepted.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      if (held) acceptControlRequest(socket, held);
      await alarm;
      await session.interruptExecution();
      socket.close();
    }
  });

  it('reconnects prompt and model-less command snapshots from nested intent', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const records: SessionMessageRecord[] = [
      createSessionMessageRecord({
        turn: { type: 'prompt', messageId: 'msg_v2_prompt', prompt: 'nested prompt' },
        agent: agentA,
      }),
      createSessionMessageRecord({
        turn: {
          type: 'command',
          messageId: 'msg_v2_command',
          command: 'review',
          arguments: '--all',
        },
        agent: { mode: 'code' },
      }),
    ];
    await runInDurableObject(session, (_instance, state) => {
      state.storage.kv.put('session_messages', records);
    });
    const response = await SELF.fetch(
      `http://worker.test/stream?sessionId=${fixture.sessionId}&userId=${fixture.ownerId}&replay=false`,
      { headers: { Upgrade: 'websocket' } }
    );
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) throw new Error('Expected session stream');
    const events: { streamEventType: string; data: unknown }[] = [];
    socket.addEventListener('message', event => {
      events.push(JSON.parse(String(event.data)));
    });
    socket.accept();
    try {
      await vi.waitFor(() => {
        expect(
          events
            .filter(event => event.streamEventType === 'cloud.message.queued')
            .map(event => event.data)
        ).toEqual([
          { messageId: 'msg_v2_prompt', content: 'nested prompt', delivery: 'queued' },
          { messageId: 'msg_v2_command', content: '/review --all', delivery: 'queued' },
        ]);
      });
      expect((await admissionState(session)).messages).toEqual(records);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });

  it('aborts and detaches a deleted session without stopping active sibling work', async () => {
    const userId = 'user_control_delete';
    const sessionId = 'workspace_control_deleted';
    const siblingSessionId = 'workspace_control_sibling';
    const controlId = 'usr-de1e7ed';
    const credential = generateSandboxCredential();
    const control = env.SANDBOX_CONTROL.getByName(controlId);
    const { provider } = await installProvider(control, 'inst_1');
    await runInDurableObject(control, async instance => {
      await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
      await instance.initializeOwner(userId);
      await instance.claimCreate('intent_shared_delete');
      await instance.confirmInstance('inst_1');
      await instance.attachSession({
        sessionId,
        kiloSessionId: 'kilo_deleted',
        directory: '/workspace/deleted',
        ownerId: userId,
      });
      await instance.attachSession({
        sessionId: siblingSessionId,
        kiloSessionId: 'kilo_sibling',
        directory: '/workspace/sibling',
        ownerId: userId,
      });
    });

    const session = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
    await runInDurableObject(session, async (instance, state) => {
      await instance.registerSession({
        identity: { sessionId, userId },
        auth: { kiloSessionId: 'kilo_deleted' },
        agent: { mode: 'code', model: 'test' },
        workspace: { sandboxId: controlId, workspacePath: '/workspace/deleted' },
      });
      await state.storage.put('session_messages', [
        {
          messageId: 'msg_deleted',
          state: 'accepted',
          acceptedAt: 1,
          lastActivityAt: 1,
        } satisfies SessionMessageRecord,
      ]);
    });

    const ws = await connect(credential, controlId);
    await completeHello(ws, 'hello-shared-delete', { wrapperInstanceId: crypto.randomUUID() });
    signalWrapperReady(ws);
    await vi.waitFor(async () => {
      await expect(control.getStatus()).resolves.toMatchObject({ connection: 'ready' });
    });
    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'sandbox.heartbeat',
        payload: {
          state: 'active',
          kilo: { ready: true },
          sessions: ['kilo_deleted', 'kilo_sibling'].map(kiloSessionId => ({
            kiloSessionId,
            state: 'active',
            idleForMs: 0,
          })),
        },
      })
    );
    await vi.waitFor(async () => {
      await runInDurableObject(control, async (_instance, state) => {
        expect((await loadDeadlines(state.storage)).idleStop).toBeUndefined();
      });
    });
    const abortRequests: {
      operation: string;
      session: { sessionId: string; kiloSessionId: string; directory: string };
    }[] = [];
    ws.addEventListener('message', event => {
      const request = JSON.parse(String(event.data)) as {
        operation?: string;
        requestId: string;
        session: { sessionId: string; kiloSessionId: string; directory: string };
      };
      if (request.operation === 'session.abort') {
        abortRequests.push({ operation: request.operation, session: request.session });
        ws.send(
          JSON.stringify({
            type: 'response',
            requestId: request.requestId,
            ok: true,
            result: { status: 'aborted' },
          })
        );
        return;
      }
      if (request.operation !== 'session.detach') return;
      ws.send(
        JSON.stringify({
          type: 'response',
          requestId: request.requestId,
          ok: true,
          result: { detached: true },
        })
      );
    });

    await runInDurableObject(session, instance => instance.deleteSession());
    await runInDurableObject(control, async (instance, state) => {
      await expect(instance.listRoutes()).resolves.toEqual([
        expect.objectContaining({
          sessionId: siblingSessionId,
          kiloSessionId: 'kilo_sibling',
          lastState: 'active',
        }),
      ]);
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({ state: 'running' });
      expect((await loadDeadlines(state.storage)).idleStop).toBeUndefined();
    });
    await runInDurableObject(session, async instance => {
      await expect(instance.getMetadata()).resolves.toBeNull();
    });
    expect(abortRequests).toEqual([
      {
        operation: 'session.abort',
        session: {
          sessionId,
          kiloSessionId: 'kilo_deleted',
          directory: '/workspace/deleted',
        },
      },
    ]);
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    ws.close();
  });

  it('preserves repository branches and structured initial and follow-up command turns', async () => {
    const userId = 'user_control_commands' as const;
    const sessionId = 'workspace_control_commands';
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
    await runInDurableObject(stub, async (instance, state) => {
      const blocker = {
        messageId: 'msg_blocker',
        state: 'accepted',
        acceptedAt: 1,
        lastActivityAt: 1,
      } satisfies SessionMessageRecord;
      await state.storage.put('session_messages', [blocker]);

      const repository = {
        type: 'github',
        repo: 'acme/demo',
        branch: 'feature/commands',
      } as const;
      const initialTurn = {
        type: 'command',
        messageId: 'msg_initial_command',
        command: 'review',
        arguments: '--all changes',
      } as const;
      await expect(
        instance.createSessionWithInitialAdmission({
          identity: { sessionId, userId },
          auth: { kiloSessionId: 'kilo_root' },
          agent: { mode: 'code', model: 'test' },
          repository,
          message: { initialTurn },
        })
      ).resolves.toMatchObject({ success: true, messageId: initialTurn.messageId });
      await expect(instance.getMetadata()).resolves.toMatchObject({
        repository: {
          type: 'github',
          repo: repository.repo,
          upstreamBranch: repository.branch,
        },
      });

      const followUpTurn = {
        type: 'command',
        id: 'msg_followup_command',
        command: 'compact',
        arguments: '--aggressive',
      } as const;
      await expect(
        instance.admitSubmittedMessage({ userId, turn: followUpTurn })
      ).resolves.toMatchObject({ success: true, messageId: followUpTurn.id });
      expect(await state.storage.get<SessionMessageRecord[]>('session_messages')).toEqual([
        blocker,
        createSessionMessageRecord({
          turn: initialTurn,
          agent: { mode: 'code', model: 'test' },
        }),
        createSessionMessageRecord({
          turn: {
            type: 'command',
            messageId: followUpTurn.id,
            command: followUpTurn.command,
            arguments: followUpTurn.arguments,
          },
          agent: { mode: 'code', model: 'test' },
        }),
      ]);
    });
  });

  it.each(['session.turn.close', 'session.error'])(
    'preserves parent work and the persisted child %s event',
    async eventType => {
      const userId = 'user_control_child';
      const sessionId = `workspace_control_child_${eventType.replaceAll('.', '_')}`;
      const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
      const wrapperInstanceId = crypto.randomUUID();
      await runInDurableObject(stub, async (instance, state) => {
        await instance.registerSession({
          identity: { sessionId, userId },
          auth: { kiloSessionId: 'kilo_root' },
          agent: { mode: 'code', model: 'test' },
          workspace: { workspacePath: '/workspace/root' },
        });
        const accepted = {
          messageId: 'msg_parent',
          state: 'accepted',
          wrapperInstanceId,
          acceptedAt: 1,
          lastActivityAt: 2,
          turn: { type: 'prompt', messageId: 'msg_parent', prompt: 'parent turn' },
        } satisfies SessionMessageRecord;
        const queued = {
          messageId: 'msg_next',
          state: 'queued',
          turn: { type: 'command', messageId: 'msg_next', command: 'status', arguments: '' },
        } satisfies SessionMessageRecord;
        await state.storage.put('session_messages', [accepted, queued]);

        const observedAt = Date.now();
        await expect(
          instance.receiveSandboxControlEvent({
            identity: {
              directory: '/workspace/root',
              kiloSessionId: 'kilo_child',
              rootKiloSessionId: 'kilo_root',
            },
            payload: { type: eventType, properties: { sessionID: 'kilo_child' } },
            wrapperInstanceId,
          })
        ).resolves.toEqual({ applied: true });

        const messages = await state.storage.get<SessionMessageRecord[]>('session_messages');
        expect(messages).toEqual([{ ...accepted, lastActivityAt: expect.any(Number) }, queued]);
        expect(messages?.[0]?.lastActivityAt).toBeGreaterThanOrEqual(observedAt);
        await expect(instance.getCurrentMessageWork()).resolves.toEqual({
          messageId: accepted.messageId,
          status: 'running',
          health: 'healthy',
        });

        const events = createEventQueries(
          drizzle(state.storage, { logger: false }),
          state.storage.sql
        ).findByFilters({ eventTypes: ['kilocode'] });
        expect(events.map(event => JSON.parse(event.payload))).toEqual([
          {
            type: eventType,
            event: eventType,
            properties: { sessionID: 'kilo_child' },
          },
        ]);
      });
    }
  );
});

describe('SandboxControl terminal runtime coordination', () => {
  it('exposes a wrapper instance only for the ready current connection', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a001',
      ownerId: 'owner_wrapper_readiness',
      sessionId: 'workspace_wrapper_readiness',
      wrapperInstanceId: 'b40b8d7b-789f-4c2a-82ce-0c5c9aed4621',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);

    await runInDurableObject(control, async instance => {
      const status = await instance.getStatus();
      expect(status).toMatchObject({ physical: 'running', connection: 'connected' });
      expect(status).not.toHaveProperty('wrapperInstanceId');
    });

    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);
    await runInDurableObject(control, async (_instance, state) => {
      const persisted = await state.storage.get<{
        connectionId: string;
        readyConnectionId?: string;
        wrapperInstanceId?: string;
      }>('active_wrapper_runtime');
      expect(persisted).toMatchObject({ wrapperInstanceId: fixture.wrapperInstanceId });
      expect(persisted?.readyConnectionId).toBe(persisted?.connectionId);
    });

    const rotatedCredential = generateSandboxCredential();
    await seedCredential(rotatedCredential, fixture.sandboxId);
    const replacement = await connect(rotatedCredential, fixture.sandboxId);
    await completeHello(replacement, 'hello_rotated_wrapper', {
      providerInstanceId: fixture.sandboxId,
      wrapperInstanceId: fixture.wrapperInstanceId,
    });
    await runInDurableObject(control, async (instance, state) => {
      const status = await instance.getStatus();
      expect(status.connection).toBe('connected');
      expect(status).not.toHaveProperty('wrapperInstanceId');
      expect(
        await state.storage.get<{ readyConnectionId?: string }>('active_wrapper_runtime')
      ).not.toHaveProperty('readyConnectionId');
      expect(await state.storage.get('wrapper_ready_at')).toBeUndefined();
      expect(await state.storage.get('deadlines')).not.toHaveProperty('heartbeatExpiry');
    });

    signalWrapperReady(replacement);
    await waitForWrapperReady(fixture);
    replacement.close();
  });

  it('preserves ready chat for older wrappers without granting terminal capability', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a002',
      ownerId: 'owner_legacy_wrapper',
      sessionId: 'workspace_legacy_wrapper',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      const status = await instance.getStatus();
      expect(status).toMatchObject({ physical: 'running', connection: 'ready' });
      expect(status).not.toHaveProperty('wrapperInstanceId');
      await expect(
        instance.validateTerminalAccess({
          sessionId: fixture.sessionId,
          ownerId: fixture.ownerId,
          wrapperInstanceId: '27cbf2d6-aeef-42d0-8992-1a61e83e95a5',
        })
      ).resolves.toEqual({ allowed: false, reason: 'terminal_not_supported' });
    });
    socket.close();
  });

  it('validates the current session route, owner, and wrapper incarnation', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a003',
      ownerId: 'owner_terminal_access',
      sessionId: 'workspace_terminal_access',
      wrapperInstanceId: '22c38b5a-5394-4a71-9c88-e3e998565fdb',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      const input = {
        sessionId: fixture.sessionId,
        ownerId: fixture.ownerId,
        wrapperInstanceId: fixture.wrapperInstanceId ?? '',
      };
      await expect(instance.validateTerminalAccess(input)).resolves.toEqual({ allowed: true });
      await expect(
        instance.validateTerminalAccess({ ...input, ownerId: 'owner_other' })
      ).resolves.toEqual({ allowed: false, reason: 'owner_mismatch' });
      await expect(
        instance.validateTerminalAccess({ ...input, sessionId: 'workspace_other' })
      ).resolves.toEqual({ allowed: false, reason: 'session_not_attached' });
      await expect(
        instance.validateTerminalAccess({
          ...input,
          wrapperInstanceId: 'd4e4d7ee-4456-4038-b64d-a564e96e054d',
        })
      ).resolves.toEqual({ allowed: false, reason: 'wrapper_instance_mismatch' });
      await expect(instance.detachSession(fixture.sessionId)).resolves.toEqual({ existed: true });
      await expect(instance.validateTerminalAccess(input)).resolves.toEqual({
        allowed: false,
        reason: 'session_not_attached',
      });
    });
    socket.close();
  });

  it('never provisions or wakes a stopped runtime for terminal access or activity', async () => {
    const control = env.SANDBOX_CONTROL.getByName('usr-a00a');
    const input = {
      sessionId: 'workspace_stopped_access',
      ownerId: 'owner_stopped_access',
      wrapperInstanceId: '594b4020-64a5-42d4-bcf0-7915af4a099d',
    };

    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(input.ownerId);
      await instance.attachSession({
        sessionId: input.sessionId,
        kiloSessionId: 'kilo_terminal',
        directory: '/workspace/terminal',
        ownerId: input.ownerId,
      });
      await expect(instance.validateTerminalAccess(input)).resolves.toEqual({
        allowed: false,
        reason: 'runtime_not_running',
      });
      await expect(instance.recordTerminalActivity(input)).resolves.toEqual({
        allowed: false,
        reason: 'runtime_not_running',
      });
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        createIntent: null,
      });
    });
  });

  it('ends PTYs after control replacement and fences late invalidation from the new runtime', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a004',
      ownerId: 'owner_runtime_replacement',
      sessionId: 'workspace_runtime_replacement',
      wrapperInstanceId: '2ece7e1a-6f7f-40b3-a4d8-307304eaaf93',
    };
    const { control, credential, socket, provider } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    let newWrapper: WebSocket | undefined;
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);
    const sameWrapper = await connect(credential, fixture.sandboxId);
    try {
      const replaced = new Promise<number>(resolve => {
        sameWrapper.addEventListener('close', event => resolve(event.code), { once: true });
      });
      sendHello(sameWrapper, 'hello_replaced_runtime', {
        providerInstanceId: fixture.sandboxId,
        wrapperInstanceId: fixture.wrapperInstanceId,
      });
      await expect(replaced).resolves.toBe(4001);
      await vi.waitFor(async () => {
        await expect(control.getPhysicalRecord()).resolves.toMatchObject({ state: 'stopped' });
        await runInDurableObject(session, (_instance, state) => {
          expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
            state: 'ended',
          });
          expect(state.storage.kv.get('terminal_attached_session')).toBeUndefined();
        });
      });
      expect(provider.stop).toHaveBeenCalledTimes(1);
      await control.ensureReady({ ownerId: fixture.ownerId, allowCreate: true });
      const launch = provider.launch.mock.calls[0];
      if (!launch) throw new Error('Expected replacement wrapper launch');
      expect(launch[0]).not.toBe(fixture.sandboxId);
      const replacementFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
      newWrapper = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
      await completeHello(newWrapper, 'hello_replacement_runtime', {
        providerInstanceId: launch[0],
        wrapperInstanceId: replacementFixture.wrapperInstanceId,
      });
      expect(await control.getStatus()).not.toHaveProperty('wrapperInstanceId');
      signalWrapperReady(newWrapper);
      await waitForWrapperReady(replacementFixture);
      await seedTerminalSession(replacementFixture, 'pty_current');
      await runInDurableObject(session, async (instance, state) => {
        await instance.invalidateTerminalRuntime({
          sandboxId: fixture.sandboxId,
          wrapperInstanceId: fixture.wrapperInstanceId ?? '',
          confirmed: true,
        });
        expect(state.storage.kv.get<{ state: string }>('terminal:pty_current')).toMatchObject({
          state: 'running',
        });
        expect(state.storage.kv.get('terminal_attached_session')).toMatchObject({
          wrapperInstanceId: replacementFixture.wrapperInstanceId,
        });
      });
      await expect(
        control.validateTerminalAccess({
          ownerId: fixture.ownerId,
          sessionId: fixture.sessionId,
          wrapperInstanceId: replacementFixture.wrapperInstanceId,
        })
      ).resolves.toEqual({ allowed: true });
    } finally {
      socket.close();
      sameWrapper.close();
      newWrapper?.close();
    }
  });

  it('keeps PTY ownership on uncertain physical observations', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a005',
      ownerId: 'owner_uncertain_runtime',
      sessionId: 'workspace_uncertain_runtime',
      wrapperInstanceId: '6d1a1a6c-1153-4856-b07b-58b5b4f245aa',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      await expect(instance.observeProvider('unknown')).resolves.toMatchObject({
        state: 'unknown',
      });
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
    });
    await runInDurableObject(session, (_instance, state) => {
      expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
        state: 'running',
      });
    });
    socket.close();
  });

  it('revokes terminal access on runtime failure and ends PTYs after confirmed cleanup', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a008',
      ownerId: 'owner_failed_runtime',
      sessionId: 'workspace_failed_runtime',
      wrapperInstanceId: '84114e6b-77c0-4792-88b9-2db90d789fe1',
    };
    const { control, socket, provider } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      await expect(instance.markFailed()).resolves.toMatchObject({ state: 'failed' });
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
      await expect(
        instance.validateTerminalAccess({
          ownerId: fixture.ownerId,
          sessionId: fixture.sessionId,
          wrapperInstanceId: fixture.wrapperInstanceId ?? '',
        })
      ).resolves.toEqual({ allowed: false, reason: 'runtime_not_running' });
      await expect(instance.recordStopAttempt()).resolves.toMatchObject({ state: 'stopped' });
    });
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(provider.stop.mock.calls[0]?.[0]).toBe(fixture.sandboxId);
    await vi.waitFor(async () => {
      await runInDurableObject(session, (_instance, state) => {
        expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
          state: 'ended',
        });
      });
    });
  });

  it('invalidates active PTYs when a physical stop is confirmed', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a009',
      ownerId: 'owner_stopped_runtime',
      sessionId: 'workspace_stopped_runtime',
      wrapperInstanceId: '78de88a1-a906-4e4f-bd9e-2447c21e6472',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      await instance.beginStop('test');
      await expect(instance.confirmStopped()).resolves.toMatchObject({ state: 'stopped' });
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
    });
    await runInDurableObject(session, (_instance, state) => {
      expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
        state: 'ended',
      });
    });
  });

  it('invalidates active PTYs when wrapper credentials rotate', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a006',
      ownerId: 'owner_credential_rotation',
      sessionId: 'workspace_credential_rotation',
      wrapperInstanceId: 'bf73c60f-fd06-43f1-a93e-3412790a5ca4',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await seedCredential(generateSandboxCredential(), fixture.sandboxId);
    await runInDurableObject(session, (_instance, state) => {
      expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
        state: 'ended',
      });
    });
    await runInDurableObject(control, async instance => {
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
    });
  });

  it('extends idle deadlines monotonically for authorized Cloudflare terminal activity', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a007',
      ownerId: 'owner_terminal_activity',
      sessionId: 'workspace_terminal_activity',
      wrapperInstanceId: '5d1e54ed-31db-4646-a478-4864e87162c3',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async (instance, state) => {
      const current = (await state.storage.get<{ idleStop?: number }>('deadlines')) ?? {};
      const later = Date.now() + 10 * 60_000;
      await state.storage.put('deadlines', { ...current, idleStop: later });
      const activity = {
        sessionId: fixture.sessionId,
        ownerId: fixture.ownerId,
        wrapperInstanceId: fixture.wrapperInstanceId ?? '',
      };
      await expect(
        instance.recordTerminalActivity({
          ...activity,
          wrapperInstanceId: '513ea14b-e0b7-4bd8-b6d3-76a05c509c11',
        })
      ).resolves.toEqual({ allowed: false, reason: 'wrapper_instance_mismatch' });
      expect((await state.storage.get<{ idleStop?: number }>('deadlines'))?.idleStop).toBe(later);
      await expect(instance.recordTerminalActivity(activity)).resolves.toEqual({ allowed: true });
      const after = await state.storage.get<{ idleStop?: number }>('deadlines');
      expect(after?.idleStop).toBeGreaterThanOrEqual(later);
    });
    socket.close();
  });
});
