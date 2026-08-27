import { SELF, abortAllDurableObjects, env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKEND_URL } from '../../src/constants.js';
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
import { DEADLINE_MS } from '../../src/sandbox-control/deadlines.js';
import {
  loadDeadlines,
  loadRouteTable,
  saveDeadlines,
  saveRouteTable,
} from '../../src/sandbox-control/durable-state.js';
import { applyReportedSessionState } from '../../src/sandbox-control/session-routes.js';
import { createMemoryProviderAdapter } from '../../src/sandbox-control/provider.js';
import {
  createSessionMessageRecord,
  type SessionMessageRecord,
} from '../../src/sandbox-session/session-message-queue.js';
import { createEventQueries } from '../../src/session/queries/index.js';
import {
  requestFrameSchema,
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_AUTO_PONG,
  type RequestFrame,
} from '../../src/shared/sandbox-control-protocol.js';
import { gatewayModelIdCases, invalidCloudModelIds } from '../fixtures/gateway-model-ids.js';

const sandboxId = 'sbx_control_smoke';

async function seedCredential(credential: string, id = sandboxId): Promise<void> {
  const stub = env.SANDBOX_CONTROL.getByName(id);
  await runInDurableObject(stub, async instance => {
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
    const onMessage = (event: MessageEvent) => {
      ws.removeEventListener('error', onError);
      resolve(typeof event.data === 'string' ? event.data : String(event.data));
    };
    const onError = () => {
      ws.removeEventListener('message', onMessage);
      reject(new Error('sandbox control websocket error'));
    };
    ws.addEventListener('message', onMessage, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });
}

async function completeHello(
  ws: WebSocket,
  requestId: string,
  identity: { providerInstanceId?: string; wrapperInstanceId?: string } = {}
): Promise<void> {
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
  await runInDurableObject(control, async instance => {
    await instance.initializeOwner(fixture.ownerId);
    await instance.claimCreate(`intent_${fixture.sandboxId}`);
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
  return { control, credential, socket };
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

  it('accepts an authenticated socket, completes hello, and replaces the previous socket', async () => {
    const credential = generateSandboxCredential();
    await seedCredential(credential);

    const first = await connect(credential);
    await completeHello(first, 'hello-1');

    const firstClosed = new Promise<number>(resolve => {
      first.addEventListener('close', event => resolve(event.code), { once: true });
    });
    const second = await connect(credential);
    await completeHello(second, 'hello-2');
    await expect(firstClosed).resolves.toBe(4000);

    second.close();
  });

  it('closes duplicate provisional sockets after a successful handshake', async () => {
    const id = 'sbx_control_provisional_duplicates';
    const credential = generateSandboxCredential();
    await seedCredential(credential, id);
    const stub = env.SANDBOX_CONTROL.getByName(id);
    await runInDurableObject(stub, async instance => {
      await instance.claimCreate('intent_provisional_duplicates');
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
    const firstCredential = generateSandboxCredential();
    await seedCredential(firstCredential);
    const first = await connect(firstCredential);
    await completeHello(first, 'hello-rotate');

    const firstClosed = new Promise<number>(resolve => {
      first.addEventListener('close', event => resolve(event.code), { once: true });
    });
    const nextCredential = generateSandboxCredential();
    await seedCredential(nextCredential);
    await expect(firstClosed).resolves.toBe(4001);

    const rejected = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${firstCredential}`,
      },
    });
    expect(rejected.status).toBe(401);

    const replacement = await connect(nextCredential);
    await completeHello(replacement, 'hello-rotated');
    replacement.close();
  });

  it('correlates an outbound request with the wrapper response', async () => {
    const credential = generateSandboxCredential();
    await seedCredential(credential);
    const ws = await connect(credential);
    await completeHello(ws, 'hello-rpc');

    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
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
  it('restores and preserves wrapper readiness when an unknown provider recovers disconnected', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx_control_recovery_disconnected');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.claimCreate('intent_recovery_disconnected');
      await instance.confirmInstance('inst_1');
      await instance.observeProvider('unknown');
      expect((await loadDeadlines(state.storage)).wrapperReadiness).toBeUndefined();

      const recoveredAt = Date.now();
      await expect(instance.observeProvider('active')).resolves.toMatchObject({
        state: 'running',
        providerRef: 'inst_1',
      });
      const deadlines = await loadDeadlines(state.storage);
      expect(deadlines.wrapperReadiness).toBeGreaterThanOrEqual(
        recoveredAt + DEADLINE_MS.wrapperReadiness
      );
      expect(deadlines.heartbeatExpiry).toBeUndefined();
      expect(await state.storage.getAlarm()).toBe(deadlines.wrapperReadiness);

      await instance.observeProvider('unknown');
      await instance.observeProvider('active');
      expect((await loadDeadlines(state.storage)).wrapperReadiness).toBe(
        deadlines.wrapperReadiness
      );
    });
  });

  it('restores and preserves heartbeat expiry when an unknown provider recovers ready', async () => {
    const id = 'sbx_control_recovery_ready';
    const credential = generateSandboxCredential();
    await seedCredential(credential, id);
    const stub = env.SANDBOX_CONTROL.getByName(id);
    await runInDurableObject(stub, async instance => {
      await instance.claimCreate('intent_recovery_ready');
      await instance.confirmInstance('inst_1');
    });

    const ws = await connect(credential, id);
    await completeHello(ws, 'hello-recovery-ready');
    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      })
    );
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async instance => {
        await expect(instance.getStatus()).resolves.toMatchObject({ connection: 'ready' });
      });
    });

    await runInDurableObject(stub, async (instance, state) => {
      const initialDeadlines = await loadDeadlines(state.storage);
      expect(initialDeadlines.heartbeatExpiry).toEqual(expect.any(Number));
      delete initialDeadlines.heartbeatExpiry;
      await saveDeadlines(state.storage, initialDeadlines);
      await instance.observeProvider('unknown');

      const recoveredAt = Date.now();
      await expect(instance.observeProvider('active')).resolves.toMatchObject({
        state: 'running',
        providerRef: 'inst_1',
      });
      const deadlines = await loadDeadlines(state.storage);
      expect(deadlines.heartbeatExpiry).toBeGreaterThanOrEqual(
        recoveredAt + DEADLINE_MS.heartbeatExpiry
      );
      expect(deadlines.wrapperReadiness).toBeUndefined();
      expect(await state.storage.getAlarm()).toBe(deadlines.heartbeatExpiry);

      await instance.observeProvider('unknown');
      await instance.observeProvider('active');
      expect((await loadDeadlines(state.storage)).heartbeatExpiry).toBe(deadlines.heartbeatExpiry);
    });

    ws.close();
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

  it('does not mark needsSync for an unroutable session.event', async () => {
    const sandboxId = 'sbx_control_event_unroutable';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(stub, async instance => {
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
    response.webSocket.send(
      JSON.stringify({
        type: 'event',
        event: 'session.event',
        session: { directory: '/workspace/other', rootKiloSessionId: 'kilo_1' },
        payload: { type: 'message.updated', properties: { id: 'msg_1' } },
      })
    );
    await runInDurableObject(stub, async instance => {
      const routes = await instance.listRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0]?.needsSync).toBe(false);
    });
    response.webSocket.close();
  });

  it('isolates two session.prompt identities on one wrapper socket', async () => {
    const twoSessionId = 'sbx_control_two_session';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(twoSessionId);
    await runInDurableObject(stub, async instance => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureAndAcceptControlRequests(socket: WebSocket): RequestFrame[] {
    const requests: RequestFrame[] = [];
    socket.addEventListener('message', event => {
      const request = requestFrameSchema.parse(JSON.parse(String(event.data)));
      requests.push(request);
      socket.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true }));
    });
    return requests;
  }

  type SessionStub = ReturnType<typeof env.SANDBOX_SESSION.getByName>;

  const agentA = { mode: 'code', model: 'kilo/anthropic/claude-sonnet-4', variant: 'high' };
  const modelB = 'kilo/openai/gpt-4.1';

  function messageFixture() {
    const id = crypto.randomUUID().replaceAll('-', '');
    const fixture: TerminalRuntimeFixture = {
      sandboxId: `usr-${id}`,
      ownerId: 'owner_admission',
      sessionId: `workspace_admission_${id}`,
    };
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

  function completeTurn(session: SessionStub) {
    return session.receiveSandboxControlEvent({
      identity: { directory: '/workspace/terminal', kiloSessionId: 'kilo_terminal' },
      payload: { type: 'session.turn.close', properties: { sessionID: 'kilo_terminal' } },
    });
  }

  it.each(gatewayModelIdCases)(
    'delivers $cloudModel as $gatewayModelId for initial and follow-up prompts',
    async ({ cloudModel, gatewayModelId }) => {
      const id = crypto.randomUUID().replaceAll('-', '');
      const fixture: TerminalRuntimeFixture = {
        sandboxId: `usr-${id}`,
        ownerId: 'owner_gateway_model',
        sessionId: `workspace_gateway_model_${id}`,
      };
      const { socket } = await initializeTerminalRuntime(fixture);
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        const requests = captureAndAcceptControlRequests(socket);
        const session = env.SANDBOX_SESSION.getByName(`${fixture.ownerId}:${fixture.sessionId}`);
        await session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: 'kilo_terminal' },
          agent: { mode: 'architect', model: cloudModel, variant: 'high' },
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: {
            initialTurn: {
              type: 'prompt',
              messageId: 'msg_initial_model',
              prompt: 'initial prompt',
            },
          },
        });
        await vi.waitFor(async () => {
          await expect(session.getMessageResult('msg_initial_model')).resolves.toMatchObject({
            type: 'found',
            result: { status: 'running' },
          });
        });
        expect(globalThis.fetch).not.toHaveBeenCalled();
        await session.receiveSandboxControlEvent({
          identity: { directory: '/workspace/terminal', kiloSessionId: 'kilo_terminal' },
          payload: { type: 'session.turn.close', properties: { sessionID: 'kilo_terminal' } },
        });
        await session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_followup_model', prompt: 'follow-up prompt' },
        });
        await vi.waitFor(async () => {
          await expect(session.getMessageResult('msg_followup_model')).resolves.toMatchObject({
            type: 'found',
            result: { status: 'running' },
          });
        });
        expect(requests.filter(request => request.operation === 'session.prompt')).toMatchObject([
          {
            session: {
              sessionId: fixture.sessionId,
              kiloSessionId: 'kilo_terminal',
              directory: '/workspace/terminal',
            },
            payload: {
              messageId: 'msg_initial_model',
              turn: { type: 'prompt', prompt: 'initial prompt' },
              agent: { mode: 'architect', model: gatewayModelId, variant: 'high' },
            },
          },
          {
            session: {
              sessionId: fixture.sessionId,
              kiloSessionId: 'kilo_terminal',
              directory: '/workspace/terminal',
            },
            payload: {
              messageId: 'msg_followup_model',
              turn: { type: 'prompt', prompt: 'follow-up prompt' },
              agent: { mode: 'architect', model: gatewayModelId, variant: 'high' },
            },
          },
        ]);
        await expect(session.getMetadata()).resolves.toMatchObject({
          agent: { model: cloudModel },
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      } finally {
        socket.close();
      }
    }
  );

  it.each(['warning', undefined] as const)(
    'keeps initial gateThreshold %j in metadata but out of control turn finalization',
    async gateThreshold => {
      const { fixture, session } = messageFixture();
      const { socket } = await initializeTerminalRuntime(fixture);
      const finalization = { autoCommit: false, condenseOnComplete: true, gateThreshold };
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        const requests = captureAndAcceptControlRequests(socket);
        await expect(
          session.createSessionWithInitialAdmission({
            identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
            auth: { kiloSessionId: 'kilo_terminal' },
            agent: agentA,
            workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
            finalization,
            message: {
              initialTurn: {
                type: 'prompt',
                messageId: 'msg_initial_finalization',
                prompt: 'initial prompt with session policy',
              },
            },
          })
        ).resolves.toMatchObject({ success: true });
        await runInDurableObject(session, instance => instance.alarm());
        await expect(session.getMessageResult('msg_initial_finalization')).resolves.toMatchObject({
          type: 'found',
          result: { status: 'running' },
        });
        const state = await admissionState(session);
        expect(state.metadata?.finalization).toStrictEqual(finalization);
        expect(state.messages[0]?.intent?.finalization).toStrictEqual({
          autoCommit: false,
          condenseOnComplete: true,
        });
        expect(state.messages[0]?.promptFailures).toBeUndefined();
        expect(
          requests
            .filter(request => request.operation === 'session.prompt')
            .map(request => request.payload)
        ).toEqual([
          {
            messageId: 'msg_initial_finalization',
            turn: { type: 'prompt', prompt: 'initial prompt with session policy' },
            agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
            finalization: { autoCommit: false, condenseOnComplete: true },
          },
        ]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally {
        await session.markAsInterrupted();
        socket.close();
      }
    }
  );

  it('delivers frozen A then B after eviction and reconnect without replay rewinding defaults', async () => {
    const { fixture, session: originalSession } = messageFixture();
    let session = originalSession;
    const { credential, socket } = await initializeTerminalRuntime(fixture);
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
      expect(beforeReplay.messages.map(message => message.intent)).toEqual([
        { turn: { type: 'prompt', messageId: 'msg_a', prompt: 'A' }, agent: agentA },
        {
          turn: { type: 'prompt', messageId: 'msg_b', prompt: 'B' },
          agent: { mode: 'reviewer', model: modelB },
        },
        {
          turn: { type: 'prompt', messageId: 'msg_c', prompt: 'inherits B' },
          agent: { mode: 'code', model: modelB },
        },
      ]);
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
      });
      const requests = captureAndAcceptControlRequests(replacement);
      signalWrapperReady(replacement);
      await waitForWrapperReady(fixture);
      await runInDurableObject(session, instance => instance.alarm());
      await waitForAccepted(session, 'msg_a');
      await expect(session.admitSubmittedMessage(replay)).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'sent',
      });
      await completeTurn(session);
      await waitForAccepted(session, 'msg_b');
      await completeTurn(session);
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
      await expect(session.admitSubmittedMessage(replay)).resolves.toMatchObject({
        success: false,
        code: 'BAD_REQUEST',
      });
      expect((await session.getMetadata())?.agent).toEqual({ mode: 'code', model: modelB });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      socket.close();
      replacement?.close();
    }
  });

  it('preserves queued A/B intent through provider replacement and a new wrapper incarnation', async () => {
    const { fixture, session } = messageFixture();
    const originalWrapperId = crypto.randomUUID();
    const { control, socket } = await initializeTerminalRuntime({
      ...fixture,
      wrapperInstanceId: originalWrapperId,
    });
    let replacement: WebSocket | undefined;
    try {
      await control.detachSession(fixture.sessionId);
      const originalRequests = captureAndAcceptControlRequests(socket);
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: {
          initialTurn: { type: 'prompt', messageId: 'msg_replaced_a', prompt: 'queued A' },
        },
      });
      await runInDurableObject(session, instance => instance.alarm());
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_replaced_b', prompt: 'queued B' },
        agent: { model: modelB, mode: 'reviewer', variant: 'low' },
      });
      const queued = await admissionState(session);
      expect(queued.messages.map(message => message.state)).toEqual(['queued', 'queued']);
      await expect(control.listRoutes()).resolves.toEqual([]);
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        providerRef: fixture.sandboxId,
      });
      await runInDurableObject(control, instance => {
        const provider = createMemoryProviderAdapter();
        instance['createProviderAdapter'] = () => provider;
      });
      await control.markFailed();
      expect(await admissionState(session)).toEqual(queued);
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_replaced_a', prompt: 'queued A' },
        })
      ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'queued' });
      await runInDurableObject(session, instance => instance.alarm());
      const physical = await control.getPhysicalRecord();
      expect(physical.state).toBe('running');
      expect(physical.providerRef).not.toBe(fixture.sandboxId);
      if (!physical.providerRef) throw new Error('Expected replacement provider reference');
      expect(await admissionState(session)).toEqual(queued);
      expect(originalRequests).toEqual([]);
      const credential = generateSandboxCredential();
      await seedCredential(credential, fixture.sandboxId);
      replacement = await connect(credential, fixture.sandboxId);
      const replacementWrapperId = crypto.randomUUID();
      expect(replacementWrapperId).not.toBe(originalWrapperId);
      await completeHello(replacement, 'hello_provider_replacement', {
        providerInstanceId: physical.providerRef,
        wrapperInstanceId: replacementWrapperId,
      });
      const requests = captureAndAcceptControlRequests(replacement);
      signalWrapperReady(replacement);
      await waitForWrapperReady({ ...fixture, wrapperInstanceId: replacementWrapperId });
      await runInDurableObject(session, instance => instance.alarm());
      await waitForAccepted(session, 'msg_replaced_a');
      await completeTurn(session);
      await waitForAccepted(session, 'msg_replaced_b');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_replaced_a',
          turn: { type: 'prompt', prompt: 'queued A' },
          agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
        },
        {
          messageId: 'msg_replaced_b',
          turn: { type: 'prompt', prompt: 'queued B' },
          agent: { mode: 'reviewer', model: 'openai/gpt-4.1', variant: 'low' },
        },
      ]);
      const delivered = await admissionState(session);
      expect(delivered.metadata).toEqual(queued.metadata);
      expect(delivered.messages.map(message => message.intent)).toEqual(
        queued.messages.map(message => message.intent)
      );
      expect(delivered.messages.map(message => message.state)).toEqual(['completed', 'accepted']);
      await runInDurableObject(session, (_instance, state) => {
        expect(state.storage.kv.get('terminal_attached_session')).toMatchObject({
          wrapperInstanceId: replacementWrapperId,
        });
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await session.markAsInterrupted();
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

  it('inherits variants for aliases and preserves explicit mode and variant without changing mode defaults', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    await session.admitSubmittedMessage({
      userId: fixture.ownerId,
      turn: { type: 'prompt', id: 'msg_alias', prompt: 'same catalog ID' },
      agent: { model: ' anthropic/claude-sonnet-4 ', mode: 'architect' },
    });
    await session.admitSubmittedMessage({
      userId: fixture.ownerId,
      turn: { type: 'command', id: 'msg_variant', command: 'review', arguments: '--all' },
      agent: { model: modelB, mode: 'reviewer', variant: 'low' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    });
    await session.admitSubmittedMessage({
      userId: fixture.ownerId,
      turn: { type: 'prompt', id: 'msg_inherited', prompt: 'inherits B variant' },
    });
    const state = await admissionState(session);
    expect(state.messages.slice(1).map(message => message.intent)).toEqual([
      {
        turn: { type: 'prompt', messageId: 'msg_alias', prompt: 'same catalog ID' },
        agent: { model: ' anthropic/claude-sonnet-4 ', mode: 'architect', variant: 'high' },
      },
      {
        turn: { type: 'command', messageId: 'msg_variant', command: 'review', arguments: '--all' },
        agent: { model: modelB, mode: 'reviewer', variant: 'low' },
        finalization: { autoCommit: true, condenseOnComplete: false },
      },
      {
        turn: { type: 'prompt', messageId: 'msg_inherited', prompt: 'inherits B variant' },
        agent: { model: modelB, mode: 'code', variant: 'low' },
      },
    ]);
    expect(state.metadata?.agent).toEqual({ mode: 'code', model: modelB, variant: 'low' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('normalizes selected command models once and skips catalog preflight', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    try {
      const requests = captureAndAcceptControlRequests(socket);
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: { mode: 'reviewer', model: ' kilo/kilo/example ', variant: 'high' },
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: {
          initialTurn: {
            type: 'command',
            messageId: 'msg_command_a',
            command: 'review',
            arguments: '--all',
          },
        },
      });
      await waitForAccepted(session, 'msg_command_a');
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'command', id: 'msg_command_b', command: 'status', arguments: '' },
        agent: { mode: 'architect', model: 'kilo/vendor/team/Model:free~alias', variant: 'low' },
      });
      await completeTurn(session);
      await waitForAccepted(session, 'msg_command_b');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_command_a',
          turn: { type: 'command', command: 'review', arguments: '--all' },
          agent: { mode: 'reviewer', model: 'kilo/example', variant: 'high' },
        },
        {
          messageId: 'msg_command_b',
          turn: { type: 'command', command: 'status', arguments: '' },
          agent: { mode: 'architect', model: 'vendor/team/Model:free~alias', variant: 'low' },
        },
      ]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });

  it('keeps new model-less commands model-less after later prompt defaults are selected', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    try {
      const requests = captureAndAcceptControlRequests(socket);
      await session.registerSession({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: { mode: 'code' },
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
      });
      const metadata = await session.getMetadata();
      const command: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'command', id: 'msg_model_less', command: 'status', arguments: '--all' },
        agent: { mode: 'reviewer' },
      };
      await expect(session.admitSubmittedMessage(command)).resolves.toMatchObject({
        success: true,
      });
      expect(await session.getMetadata()).toEqual(metadata);
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_selected', prompt: 'B' },
        agent: { model: modelB },
      });
      const selectedMetadata = await session.getMetadata();
      await expect(session.admitSubmittedMessage(command)).resolves.toMatchObject({
        success: true,
      });
      await expect(
        session.admitSubmittedMessage({ ...command, agent: { model: modelB } })
      ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
      expect(await session.getMetadata()).toEqual(selectedMetadata);
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await runInDurableObject(session, instance => instance.alarm());
      await waitForAccepted(session, 'msg_model_less');
      await completeTurn(session);
      await waitForAccepted(session, 'msg_selected');
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
        {
          messageId: 'msg_selected',
          turn: { type: 'prompt', prompt: 'B' },
          agent: { mode: 'code', model: 'openai/gpt-4.1' },
        },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
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
      attempts: 1,
      retryable: false,
    },
    {
      status: 403,
      body: {},
      code: 'FORBIDDEN',
      publicCode: 'FORBIDDEN',
      error: 'Model catalog access denied for this cloud agent session',
      attempts: 1,
      retryable: false,
    },
    {
      status: 503,
      body: {},
      code: 'MODEL_VALIDATION_UNAVAILABLE',
      publicCode: 'SERVICE_UNAVAILABLE',
      error: 'Model availability could not be verified',
      attempts: 3,
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
      const requests = vi
        .mocked(globalThis.fetch)
        .mock.calls.map(([input, init]) => new Request(input, init));
      expect(requests).toHaveLength(outcome.attempts);
      for (const request of requests) {
        expect(request.url).toBe(
          `${DEFAULT_BACKEND_URL}/api/organizations/stored-org/models/validate`
        );
        expect(request.headers.get('Authorization')).toBe('Bearer stored-test-token');
        expect(request.headers.get('X-KiloCode-OrganizationId')).toBe('stored-org');
        expect(request.headers.get('X-KiloCode-Feature')).toBe('stored-platform');
        expect(await request.json()).toEqual({ modelId: 'openai/gpt-4.1' });
      }
    }
  );

  describe.each(['prompt', 'command'] as const)('%s validation', type => {
    it.each(invalidCloudModelIds)(
      'rejects explicit invalid model %j without a catalog request',
      async model => {
        const { fixture, session } = await seedBlockedAdmission();
        const before = await admissionState(session);
        const turn: SubmittedSessionMessageRequest['turn'] =
          type === 'prompt'
            ? { type, id: 'msg_invalid', prompt: 'invalid selection' }
            : { type, id: 'msg_invalid', command: 'status', arguments: '' };
        await expect(
          session.admitSubmittedMessage({ userId: fixture.ownerId, turn, agent: { model } })
        ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
        expect(await admissionState(session)).toEqual(before);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      }
    );
  });

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
      expect((await session.getMetadata())?.agent).toEqual({
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

  it('acknowledges an identical concurrent admission without changing the winner or its defaults', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const validation = pauseNextValidation();
    const input: SubmittedSessionMessageRequest = {
      userId: fixture.ownerId,
      turn: { type: 'prompt', id: 'msg_same', prompt: 'same immutable selection' },
    };
    const pending = session.admitSubmittedMessage(input);
    try {
      await validation.entered();
      await session.admitSubmittedMessage(input);
      const winner = await admissionState(session);
      validation.release();
      await expect(pending).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'queued',
      });
      expect(await admissionState(session)).toEqual(winner);
      expect(winner.messages.filter(message => message.messageId === 'msg_same')).toHaveLength(1);
    } finally {
      validation.release();
      await pending;
    }
  });

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

  it('freezes a mixed legacy queue against pre-update defaults and preserves accepted and terminal constraints', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    try {
      const requests = captureAndAcceptControlRequests(socket);
      await session.registerSession({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
      });
      const history: SessionMessageRecord[] = [
        {
          messageId: 'msg_old_accepted',
          state: 'accepted',
          prompt: 'accepted old content',
          acceptedAt: Date.now(),
        },
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
        {
          messageId: 'msg_old_command',
          state: 'queued',
          turn: {
            type: 'command',
            messageId: 'msg_old_command',
            command: 'review',
            arguments: '--all',
          },
        },
      ];
      await runInDurableObject(session, (_instance, state) => {
        state.storage.kv.put('session_messages', [...history, ...legacy]);
      });
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_new_b', prompt: 'new B' },
        agent: { model: modelB },
      });
      const frozen = await admissionState(session);
      expect(frozen.messages.slice(0, 2)).toEqual(history);
      expect(frozen.messages.slice(2, 5).map(message => message.intent?.agent)).toEqual([
        agentA,
        agentA,
        agentA,
      ]);
      expect(frozen.messages[2]).toMatchObject({
        attachFailures: 1,
        promptFailures: 2,
        preparationAttemptId: 'attempt_old_turn',
      });
      expect(frozen.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_old_accepted', prompt: 'accepted old content' },
          agent: { model: 'unknown-lost-selection', mode: 'unknown-lost-mode' },
        })
      ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'sent' });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_old_accepted', prompt: 'conflicting content' },
        })
      ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_old_failed', prompt: 'failed old content' },
        })
      ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
      expect(await admissionState(session)).toEqual(frozen);
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await completeTurn(session);
      for (const messageId of ['msg_old_turn', 'msg_old_prompt', 'msg_old_command', 'msg_new_b']) {
        await waitForAccepted(session, messageId);
        await completeTurn(session);
      }
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_old_turn',
          turn: { type: 'prompt', prompt: 'old turn A' },
          agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
        },
        {
          messageId: 'msg_old_prompt',
          turn: { type: 'prompt', prompt: 'old prompt A' },
          agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
        },
        {
          messageId: 'msg_old_command',
          turn: { type: 'command', command: 'review', arguments: '--all' },
          agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
        },
        {
          messageId: 'msg_new_b',
          turn: { type: 'prompt', prompt: 'new B' },
          agent: { mode: 'code', model: 'openai/gpt-4.1' },
        },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      socket.close();
    }
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
          {
            messageId: 'msg_upgrade_next',
            state: 'queued',
            turn: { type: 'prompt', messageId: 'msg_upgrade_next', prompt: 'next A' },
          },
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
      const stateBeforeNetwork = await admissionState(session);
      expect(stateBeforeNetwork.messages.map(message => message.intent?.agent)).toEqual([
        agentA,
        agentA,
      ]);
      await runInDurableObject(session, async (instance, state) => {
        const metadata = await instance.getMetadata();
        if (!metadata) throw new Error('Expected registered metadata');
        state.storage.kv.put(
          'session_metadata',
          serializeSessionMetadata({
            ...metadata,
            agent: { mode: 'architect', model: modelB },
          })
        );
      });
      released = true;
      await dispatch;
      await waitForAccepted(session, 'msg_upgrade_a');
      await completeTurn(session);
      await waitForAccepted(session, 'msg_upgrade_next');
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
        {
          messageId: 'msg_upgrade_next',
          turn: { type: 'prompt', prompt: 'next A' },
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

  it('shares in-flight dispatch across queued replays and alarms', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    const entered = Promise.withResolvers<RequestFrame>();
    const requests: RequestFrame[] = [];
    let alarm: Promise<void> | undefined;
    let held: RequestFrame | undefined;
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      socket.addEventListener('message', event => {
        const request = requestFrameSchema.parse(JSON.parse(String(event.data)));
        requests.push(request);
        if (request.operation === 'session.prompt') {
          held = request;
          entered.resolve(request);
        } else {
          socket.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true }));
        }
      });
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: 'kilo_terminal' },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: {
          initialTurn: {
            type: 'prompt',
            messageId: 'msg_single_flight',
            prompt: 'once while pending',
          },
        },
      });
      await entered.promise;
      const replay: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_single_flight', prompt: 'once while pending' },
      };
      alarm = runInDurableObject(session, instance => instance.alarm());
      await expect(
        Promise.all([session.admitSubmittedMessage(replay), session.admitSubmittedMessage(replay)])
      ).resolves.toEqual([
        {
          success: true,
          outcome: 'queued',
          messageId: 'msg_single_flight',
          compatibilityDelivery: 'queued',
        },
        {
          success: true,
          outcome: 'queued',
          messageId: 'msg_single_flight',
          compatibilityDelivery: 'queued',
        },
      ]);
      expect(requests.filter(request => request.operation === 'session.prompt')).toHaveLength(1);
      if (!held) throw new Error('Expected held prompt');
      socket.send(JSON.stringify({ type: 'response', requestId: held.requestId, ok: true }));
      held = undefined;
      await alarm;
      await waitForAccepted(session, 'msg_single_flight');
      await expect(session.admitSubmittedMessage(replay)).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'sent',
      });
      expect(requests.map(request => request.operation)).toEqual([
        'session.attach',
        'session.prompt',
      ]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      if (held)
        socket.send(JSON.stringify({ type: 'response', requestId: held.requestId, ok: true }));
      await alarm;
      socket.close();
    }
  });

  it.each(['rejected', 'disconnected'] as const)(
    'coalesces replays and alarms during a %s handoff and retries the same intent once',
    async failure => {
      const { fixture, session } = messageFixture();
      const { control, credential, socket } = await initializeTerminalRuntime(fixture);
      const requests: RequestFrame[] = [];
      const entered = Promise.withResolvers<RequestFrame>();
      let holdFirstPrompt = true;
      let held: RequestFrame | undefined;
      let alarm: Promise<void> | undefined;
      let replacement: WebSocket | undefined;
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
          socket.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true }));
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
          Promise.all([
            session.admitSubmittedMessage(replay),
            session.admitSubmittedMessage(replay),
          ])
        ).resolves.toMatchObject([
          { success: true, compatibilityDelivery: 'queued' },
          { success: true, compatibilityDelivery: 'queued' },
        ]);
        if (failure === 'rejected') {
          socket.send(
            JSON.stringify({ type: 'response', requestId: firstRequest.requestId, ok: false })
          );
        } else {
          await runInDurableObject(control, instance => {
            vi.spyOn(instance['provider'], 'observe').mockResolvedValue('active');
          });
          socket.close();
        }
        held = undefined;
        await alarm;
        expect((await admissionState(session)).messages[0]).toMatchObject({
          state: 'queued',
          promptFailures: 1,
          intent: original,
        });
        expect(requests.map(request => request.operation)).toEqual([
          'session.attach',
          'session.prompt',
        ]);
        await session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_retry_b', prompt: 'new B' },
          agent: { model: modelB },
        });
        let replacementRequests: RequestFrame[] = [];
        if (failure === 'disconnected') {
          await vi.waitFor(async () => {
            expect(await control.getStatus()).toMatchObject({ connection: 'disconnected' });
          });
          replacement = await connect(credential, fixture.sandboxId);
          await completeHello(replacement, 'hello_retry_reconnected', {
            providerInstanceId: fixture.sandboxId,
          });
          replacementRequests = captureAndAcceptControlRequests(replacement);
          signalWrapperReady(replacement);
          await waitForWrapperReady(fixture);
        }
        await runInDurableObject(session, instance => instance.alarm());
        await waitForAccepted(session, 'msg_retry_a');
        const delivered = [...requests, ...replacementRequests].filter(
          request => request.operation === 'session.prompt'
        );
        expect(delivered).toHaveLength(2);
        expect(delivered[0]?.payload).toEqual(delivered[1]?.payload);
        expect(delivered[1]?.payload).toMatchObject({
          agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
        });
        expect((await admissionState(session)).messages[0]).toMatchObject({
          state: 'accepted',
          promptFailures: 1,
          intent: original,
        });
        expect((await session.getMetadata())?.agent).toEqual({ mode: 'code', model: modelB });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      } finally {
        if (held)
          socket.send(JSON.stringify({ type: 'response', requestId: held.requestId, ok: true }));
        await alarm;
        await session.markAsInterrupted();
        socket.close();
        replacement?.close();
      }
    }
  );

  it('reconnects prompt and command snapshots from nested intent and both legacy formats', async () => {
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
      {
        messageId: 'msg_legacy_turn',
        state: 'queued',
        turn: { type: 'prompt', messageId: 'msg_legacy_turn', prompt: 'legacy turn' },
      },
      {
        messageId: 'msg_legacy_command',
        state: 'accepted',
        turn: {
          type: 'command',
          messageId: 'msg_legacy_command',
          command: 'status',
          arguments: '',
        },
        acceptedAt: 20,
      },
      { messageId: 'msg_legacy_prompt', state: 'queued', prompt: 'legacy prompt' },
      {
        messageId: 'msg_failed_snapshot',
        state: 'failed',
        prompt: 'failed prompt',
        failedReason: 'invalid_model',
      },
      {
        messageId: 'msg_completed_snapshot',
        state: 'completed',
        prompt: 'hidden completed prompt',
      },
    ];
    await runInDurableObject(session, (_instance, state) => {
      state.storage.kv.put('session_messages', records);
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await SELF.fetch(
        `http://worker.test/stream?sessionId=${fixture.sessionId}&userId=${fixture.ownerId}&replay=false`,
        {
          headers: { Upgrade: 'websocket' },
        }
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
            { messageId: 'msg_legacy_turn', content: 'legacy turn', delivery: 'queued' },
            { messageId: 'msg_legacy_command', content: '/status', delivery: 'queued' },
            { messageId: 'msg_legacy_prompt', content: 'legacy prompt', delivery: 'queued' },
            { messageId: 'msg_failed_snapshot', content: 'failed prompt', delivery: 'queued' },
          ]);
          expect(
            events
              .filter(event => event.streamEventType === 'cloud.message.failed')
              .map(event => event.data)
          ).toEqual([
            {
              messageId: 'msg_failed_snapshot',
              status: 'failed',
              delivery: 'queued',
              accepted: false,
              reason: 'invalid_model',
            },
          ]);
        });
      } finally {
        socket.close();
      }
    }
    expect((await admissionState(session)).messages).toEqual(records);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  describe.each(['turn', 'prompt'] as const)('legacy %s records', format => {
    it.each([undefined, ...invalidCloudModelIds])(
      'permanently fails a prompt with model %j before delivery',
      async model => {
        const id = crypto.randomUUID().replaceAll('-', '');
        const fixture: TerminalRuntimeFixture = {
          sandboxId: `usr-${id}`,
          ownerId: 'owner_invalid_model',
          sessionId: `workspace_invalid_model_${id}`,
        };
        const { socket } = await initializeTerminalRuntime(fixture);
        try {
          signalWrapperReady(socket);
          await waitForWrapperReady(fixture);
          const requests = captureAndAcceptControlRequests(socket);
          const session = env.SANDBOX_SESSION.getByName(`${fixture.ownerId}:${fixture.sessionId}`);
          const queued: SessionMessageRecord = {
            messageId: 'msg_invalid_model',
            state: 'queued',
            ...(format === 'turn'
              ? {
                  turn: {
                    type: 'prompt',
                    messageId: 'msg_invalid_model',
                    prompt: 'never deliver',
                  },
                }
              : { prompt: 'never deliver' }),
            attachFailures: 1,
            promptFailures: 2,
          };
          const completed = {
            messageId: 'msg_completed',
            state: 'completed',
          } satisfies SessionMessageRecord;
          await runInDurableObject(session, async (instance, state) => {
            await instance.registerSession({
              identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
              auth: { kiloSessionId: 'kilo_terminal' },
              agent: model === undefined ? {} : { model },
              workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
            });
            await state.storage.put('session_messages', [completed, queued]);
          });
          await runInDurableObject(session, instance => instance.alarm());
          await runInDurableObject(session, instance => instance.alarm());
          await runInDurableObject(session, async (instance, state) => {
            expect(await state.storage.get<SessionMessageRecord[]>('session_messages')).toEqual([
              completed,
              {
                ...queued,
                state: 'failed',
                failedReason: 'invalid_model',
                preparationAttemptId: expect.any(String),
                legacyIntentInvalid: true,
              },
            ]);
            await expect(instance.getCurrentMessageWork()).resolves.toBeNull();
            expect(await state.storage.getAlarm()).toBeNull();
            const events = createEventQueries(
              drizzle(state.storage, { logger: false }),
              state.storage.sql
            ).findByFilters({ eventTypes: ['cloud.message.failed'] });
            expect(events.map(event => JSON.parse(event.payload))).toEqual([
              {
                messageId: queued.messageId,
                status: 'failed',
                delivery: 'queued',
                accepted: false,
                reason: 'invalid_model',
                timestamp: expect.any(Number),
              },
            ]);
          });
          expect(requests).toEqual([]);
        } finally {
          socket.close();
        }
      }
    );
  });

  it('fails only the invalid prompt and still delivers a model-less command', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-c001',
      ownerId: 'owner_model_less_command',
      sessionId: 'workspace_model_less_command',
    };
    const { socket } = await initializeTerminalRuntime(fixture);
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      const requests = captureAndAcceptControlRequests(socket);
      const session = env.SANDBOX_SESSION.getByName(`${fixture.ownerId}:${fixture.sessionId}`);
      await runInDurableObject(session, async (instance, state) => {
        await instance.registerSession({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: 'kilo_terminal' },
          agent: {},
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        });
        await state.storage.put('session_messages', [
          { messageId: 'msg_invalid_model', state: 'queued', prompt: 'never deliver' },
          {
            messageId: 'msg_model_less_command',
            state: 'queued',
            turn: {
              type: 'command',
              messageId: 'msg_model_less_command',
              command: 'status',
              arguments: '--all',
            },
          },
        ] satisfies SessionMessageRecord[]);
      });
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_later_default', prompt: 'new B cannot rescue old input' },
        agent: { model: modelB },
      });
      expect((await session.getMetadata())?.agent?.model).toBe(modelB);
      await runInDurableObject(session, instance => instance.alarm());
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_model_less_command',
          turn: { type: 'command', command: 'status', arguments: '--all' },
          agent: { mode: 'code' },
        },
      ]);
      await runInDurableObject(session, async (_instance, state) => {
        expect(await state.storage.get<SessionMessageRecord[]>('session_messages')).toMatchObject([
          {
            messageId: 'msg_invalid_model',
            state: 'failed',
            failedReason: 'invalid_model',
            legacyIntentInvalid: true,
          },
          { messageId: 'msg_model_less_command', state: 'accepted' },
          { messageId: 'msg_later_default', state: 'queued', intent: { agent: { model: modelB } } },
        ]);
      });
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
    await runInDurableObject(control, async (instance, state) => {
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
      const routes = await loadRouteTable(state.storage);
      for (const kiloSessionId of ['kilo_deleted', 'kilo_sibling']) {
        applyReportedSessionState(
          routes,
          kiloSessionId,
          { state: 'active', idleForMs: 0 },
          Date.now()
        );
      }
      await saveRouteTable(state.storage, routes);
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
    await completeHello(ws, 'hello-shared-delete');
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
      await runInDurableObject(stub, async (instance, state) => {
        await instance.registerSession({
          identity: { sessionId, userId },
          auth: { kiloSessionId: 'kilo_root' },
          agent: { mode: 'code', model: 'test' },
        });
        const accepted = {
          messageId: 'msg_parent',
          state: 'accepted',
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
    const { control, credential, socket } = await initializeTerminalRuntime(fixture);

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

    const replacement = await connect(credential, fixture.sandboxId);
    await completeHello(replacement, 'hello_same_wrapper', {
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

  it('preserves PTYs on same-wrapper reconnect and invalidates only replaced runtimes', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a004',
      ownerId: 'owner_runtime_replacement',
      sessionId: 'workspace_runtime_replacement',
      wrapperInstanceId: '2ece7e1a-6f7f-40b3-a4d8-307304eaaf93',
    };
    const { control, credential, socket } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    const sameWrapper = await connect(credential, fixture.sandboxId);
    await completeHello(sameWrapper, 'hello_preserved_runtime', {
      providerInstanceId: fixture.sandboxId,
      wrapperInstanceId: fixture.wrapperInstanceId,
    });
    await runInDurableObject(session, (_instance, state) => {
      expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
        state: 'running',
      });
    });

    const newWrapperInstanceId = '0acff5cd-f58d-49fa-8f70-3182940194f5';
    const newWrapper = await connect(credential, fixture.sandboxId);
    await completeHello(newWrapper, 'hello_replacement_runtime', {
      providerInstanceId: fixture.sandboxId,
      wrapperInstanceId: newWrapperInstanceId,
    });
    await runInDurableObject(session, (_instance, state) => {
      expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
        state: 'ended',
      });
      expect(state.storage.kv.get('terminal_attached_session')).toBeUndefined();
    });
    await runInDurableObject(control, async instance => {
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
    });

    const replacementFixture = { ...fixture, wrapperInstanceId: newWrapperInstanceId };
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
    });
    newWrapper.close();
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

  it('invalidates active PTYs when the physical runtime fails', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a008',
      ownerId: 'owner_failed_runtime',
      sessionId: 'workspace_failed_runtime',
      wrapperInstanceId: '84114e6b-77c0-4792-88b9-2db90d789fe1',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      await expect(instance.markFailed()).resolves.toMatchObject({ state: 'failed' });
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
    });
    await runInDurableObject(session, (_instance, state) => {
      expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
        state: 'ended',
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
