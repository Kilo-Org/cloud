import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  generateSandboxCredential,
  hashSandboxCredential,
} from '../../src/sandbox-control/credential.js';
import {
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_AUTO_PONG,
} from '../../src/shared/sandbox-control-protocol.js';

const sandboxId = 'sbx_control_smoke';

async function seedCredential(credential: string): Promise<void> {
  const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
  await runInDurableObject(stub, async instance => {
    await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
  });
}

async function connect(credential: string): Promise<WebSocket> {
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
