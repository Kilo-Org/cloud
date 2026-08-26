import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it, vi } from 'vitest';
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
import type { SessionMessageRecord } from '../../src/sandbox-session/session-message-queue.js';
import { createEventQueries } from '../../src/session/queries/index.js';
import {
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_AUTO_PONG,
} from '../../src/shared/sandbox-control-protocol.js';

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

async function completeHello(ws: WebSocket, requestId: string): Promise<void> {
  ws.send(
    JSON.stringify({
      type: 'request',
      requestId,
      operation: 'sandbox.hello',
      payload: { protocolVersion: 1, providerInstanceId: 'inst_1' },
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
      if (request.operation !== 'session.abort') return;
      abortRequests.push({ operation: request.operation, session: request.session });
      ws.send(
        JSON.stringify({
          type: 'response',
          requestId: request.requestId,
          ok: true,
          result: { status: 'aborted' },
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
        { messageId: initialTurn.messageId, state: 'queued', turn: initialTurn },
        {
          messageId: followUpTurn.id,
          state: 'queued',
          turn: {
            type: 'command',
            messageId: followUpTurn.id,
            command: followUpTurn.command,
            arguments: followUpTurn.arguments,
          },
        },
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
