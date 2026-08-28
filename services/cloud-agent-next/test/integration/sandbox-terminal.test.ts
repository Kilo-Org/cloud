import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateSandboxCredential,
  hashSandboxCredential,
} from '../../src/sandbox-control/credential.js';
import { getSandboxSessionStub } from '../../src/sandbox-session/session-stub.js';
import {
  requestFrameSchema,
  responseFrameSchema,
  sessionTerminalConnectPayloadSchema,
  type RequestFrame,
  type ResponseFrame,
  type SessionTerminalConnectPayload,
} from '../../src/shared/sandbox-control-protocol.js';
import type { SandboxId } from '../../src/types.js';
import { getSessionWorkspacePath } from '../../src/workspace.js';

type SocketFrame = string | ArrayBuffer;

type SocketInbox = {
  next: () => Promise<SocketFrame>;
};

type TerminalConnection = {
  payload: SessionTerminalConnectPayload;
  socket: WebSocket;
  inbox: SocketInbox;
  closed: Promise<CloseEvent>;
  unauthorizedStatuses: number[];
};

type BrowserConnection = {
  socket: WebSocket;
  inbox: SocketInbox;
  closed: Promise<CloseEvent>;
};

type ConnectionBehavior = {
  concurrentRedemption?: boolean;
  unauthorizedFirst?: boolean;
  initialOutput?: string;
};

type TerminalFixture = {
  ownerId: string;
  sessionId: string;
  kiloSessionId: string;
  sandboxId: SandboxId;
  wrapperInstanceId: string;
  directory: string;
  ptyId: string;
  control: WebSocket;
  connections: TerminalConnection[];
  browsers: BrowserConnection[];
  nextBehavior: ConnectionBehavior;
  nextCloseResponse?: Omit<ResponseFrame, 'type' | 'requestId'>;
  errors: Error[];
  openBrowser: (behavior?: ConnectionBehavior) => Promise<BrowserConnection>;
  reverseUrl: () => string;
  dispose: () => Promise<void>;
};

const fixtures = new Set<TerminalFixture>();

function createSocketInbox(socket: WebSocket): SocketInbox {
  const buffered: SocketFrame[] = [];
  const waiters: Array<(frame: SocketFrame) => void> = [];
  socket.addEventListener('message', event => {
    const data = event.data;
    if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(data);
      return;
    }
    buffered.push(data);
  });

  return {
    next: () => {
      const frame = buffered.shift();
      if (frame !== undefined) return Promise.resolve(frame);
      return new Promise(resolve => waiters.push(resolve));
    },
  };
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise(resolve => {
    socket.addEventListener('close', event => resolve(event), { once: true });
  });
}

function parseRequest(frame: SocketFrame): RequestFrame {
  if (typeof frame !== 'string') throw new Error('Expected a text control frame');
  return requestFrameSchema.parse(JSON.parse(frame));
}

function sendResponse(control: WebSocket, requestId: string, result: unknown): void {
  control.send(JSON.stringify({ type: 'response', requestId, ok: true, result }));
}

function terminalPty(ptyId: string, directory: string) {
  return {
    id: ptyId,
    title: 'Terminal',
    command: '/bin/sh',
    args: [],
    cwd: directory,
    status: 'running' as const,
    pid: 1234,
  };
}

async function createFixture(ownerId?: string, organizationId?: string): Promise<TerminalFixture> {
  const identity = crypto.randomUUID();
  const owner = ownerId ?? `user_${identity}`;
  const sessionId = `workspace_${identity}`;
  const sandboxId = `ses-${identity.replaceAll('-', '')}` as SandboxId;
  const kiloSessionId = `ses_${identity.replaceAll('-', '')}`;
  const wrapperInstanceId = crypto.randomUUID();
  const ptyId = `pty_${identity.replaceAll('-', '')}`;
  const directory = getSessionWorkspacePath(organizationId, owner, sessionId);
  const sessionIdentity = {
    sessionId,
    userId: owner,
    createdOnPlatform: 'cloud-agent-web',
    ...(organizationId ? { orgId: organizationId } : {}),
  };
  const credential = generateSandboxCredential();
  const controlStub = env.SANDBOX_CONTROL.getByName(sandboxId);
  const sessionStub = getSandboxSessionStub(env, owner, sessionId);

  await runInDurableObject(controlStub, async instance => {
    await instance.initializeOwner(owner);
    await instance.claimCreate(crypto.randomUUID());
    await instance.confirmInstance(sandboxId);
    await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
  });

  await runInDurableObject(sessionStub, async instance => {
    const result = await instance.registerSession({
      identity: sessionIdentity,
      auth: { kiloSessionId },
      agent: { mode: 'code', model: 'test-model' },
      workspace: { sandboxId, sandboxProvider: 'cloudflare' },
    });
    expect(result.success).toBe(true);
  });

  const upgraded = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${credential}` },
  });
  if (upgraded.status !== 101 || !upgraded.webSocket) {
    throw new Error(`Unexpected sandbox control upgrade: ${upgraded.status}`);
  }
  const control = upgraded.webSocket;
  control.accept();
  const controlInbox = createSocketInbox(control);
  control.send(
    JSON.stringify({
      type: 'request',
      requestId: `hello_${identity}`,
      operation: 'sandbox.hello',
      payload: {
        protocolVersion: 1,
        providerInstanceId: sandboxId,
        wrapperInstanceId,
      },
    })
  );

  const helloFrame = await controlInbox.next();
  if (typeof helloFrame !== 'string') throw new Error('Expected sandbox hello response');
  expect(responseFrameSchema.parse(JSON.parse(helloFrame))).toMatchObject({
    requestId: `hello_${identity}`,
    ok: true,
  });
  const status = parseRequest(await controlInbox.next());
  expect(status.operation).toBe('sandbox.status');
  sendResponse(control, status.requestId, {
    healthy: true,
    state: 'idle',
    version: 'test',
    kiloReady: true,
  });

  let resolvePreparation: (() => void) | undefined;
  const prepared = new Promise<void>(resolve => {
    resolvePreparation = resolve;
  });

  const fixture: TerminalFixture = {
    ownerId: owner,
    sessionId,
    kiloSessionId,
    sandboxId,
    wrapperInstanceId,
    directory,
    ptyId,
    control,
    connections: [],
    browsers: [],
    nextBehavior: {},
    errors: [],
    reverseUrl: () =>
      `http://worker.test/sandbox-terminal/${encodeURIComponent(owner)}/${sessionId}/${ptyId}`,
    openBrowser: async (behavior = {}) => {
      fixture.nextBehavior = behavior;
      const url = new URL('http://worker.test/terminal-test');
      url.searchParams.set('ownerId', owner);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('ptyId', ptyId);
      url.searchParams.set('ticket', 'browser-ticket-must-not-be-forwarded');
      const response = await SELF.fetch(url, {
        headers: {
          Upgrade: 'websocket',
          Authorization: 'Bearer browser-credential-must-not-be-forwarded',
          Cookie: 'session=browser-cookie-must-not-be-forwarded',
        },
      });
      if (response.status !== 101 || !response.webSocket) {
        throw new Error(`Unexpected terminal browser upgrade: ${response.status}`);
      }
      response.webSocket.binaryType = 'arraybuffer';
      response.webSocket.accept();
      const browser: BrowserConnection = {
        socket: response.webSocket,
        inbox: createSocketInbox(response.webSocket),
        closed: nextClose(response.webSocket),
      };
      fixture.browsers.push(browser);
      return browser;
    },
    dispose: async () => {
      for (const browser of fixture.browsers) {
        if (browser.socket.readyState === 1) browser.socket.close(1000, 'test cleanup');
      }
      for (const connection of fixture.connections) {
        if (connection.socket.readyState === 1) connection.socket.close(1000, 'test cleanup');
      }
      await runInDurableObject(controlStub, async instance => {
        const physical = await instance.getPhysicalRecord();
        if (physical.state === 'running') {
          await instance.beginStop('test cleanup');
          await instance.confirmStopped();
        }
      });
      if (control.readyState === 1) control.close(1000, 'test cleanup');
    },
  };
  fixtures.add(fixture);

  async function respond(request: RequestFrame): Promise<void> {
    if (request.operation === 'sandbox.status') {
      sendResponse(control, request.requestId, {
        healthy: true,
        state: 'idle',
        version: 'test',
        kiloReady: true,
      });
      return;
    }

    if (request.operation === 'session.attach') {
      expect(request.session).toEqual({ sessionId, kiloSessionId, directory });
      sendResponse(control, request.requestId, { attached: true });
      return;
    }

    if (request.operation === 'session.prompt') {
      const payload = request.payload;
      if (typeof payload !== 'object' || payload === null || !('messageId' in payload)) {
        throw new Error('Invalid session prompt request');
      }
      sendResponse(control, request.requestId, {
        messageId: payload.messageId,
        status: 'accepted',
      });
      resolvePreparation?.();
      return;
    }

    if (request.operation === 'session.terminal.create') {
      expect(request.session).toEqual({ sessionId, kiloSessionId, directory });
      sendResponse(control, request.requestId, { pty: terminalPty(ptyId, directory) });
      return;
    }

    if (request.operation === 'session.terminal.resize') {
      sendResponse(control, request.requestId, { pty: terminalPty(ptyId, directory) });
      return;
    }

    if (request.operation === 'session.terminal.close') {
      const response = fixture.nextCloseResponse ?? { ok: true, result: { success: true } };
      fixture.nextCloseResponse = undefined;
      control.send(JSON.stringify({ type: 'response', requestId: request.requestId, ...response }));
      return;
    }

    if (request.operation === 'session.abort') {
      sendResponse(control, request.requestId, { status: 'aborted' });
      return;
    }

    if (request.operation === 'session.detach') {
      sendResponse(control, request.requestId, { detached: true });
      return;
    }

    if (request.operation !== 'session.terminal.connect') {
      throw new Error(`Unexpected control operation: ${request.operation}`);
    }

    expect(request.session).toEqual({ sessionId, kiloSessionId, directory });
    const payload = sessionTerminalConnectPayloadSchema.parse(request.payload);
    expect(payload.ownerId).toBe(owner);
    expect(payload.ptyId).toBe(ptyId);
    const behavior = fixture.nextBehavior;
    fixture.nextBehavior = {};
    const unauthorizedStatuses: number[] = [];
    const reverse = () =>
      SELF.fetch(`${fixture.reverseUrl()}?ticket=producer-query-must-not-be-forwarded`, {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${payload.capability}`,
          Cookie: 'session=producer-cookie-must-not-be-forwarded',
          'x-terminal-role': 'browser',
        },
      });

    if (behavior.unauthorizedFirst) {
      const unauthorized = await SELF.fetch(fixture.reverseUrl(), {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${generateSandboxCredential()}`,
        },
      });
      unauthorizedStatuses.push(unauthorized.status);
    }

    const responses = behavior.concurrentRedemption
      ? await Promise.all([reverse(), reverse()])
      : [await reverse()];
    const accepted = responses.find(response => response.status === 101);
    if (behavior.concurrentRedemption) {
      unauthorizedStatuses.push(
        ...responses.filter(response => response.status !== 101).map(response => response.status)
      );
    }
    if (!accepted?.webSocket) throw new Error('Reverse terminal upgrade was rejected');

    accepted.webSocket.binaryType = 'arraybuffer';
    accepted.webSocket.accept();
    const connection: TerminalConnection = {
      payload,
      socket: accepted.webSocket,
      inbox: createSocketInbox(accepted.webSocket),
      closed: nextClose(accepted.webSocket),
      unauthorizedStatuses,
    };
    fixture.connections.push(connection);
    if (behavior.initialOutput !== undefined) connection.socket.send(behavior.initialOutput);
    sendResponse(control, request.requestId, { connected: true });
  }

  control.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    const parsed = requestFrameSchema.safeParse(JSON.parse(event.data));
    if (!parsed.success) return;
    void respond(parsed.data).catch(error => {
      fixture.errors.push(error instanceof Error ? error : new Error('Control response failed'));
      if (control.readyState !== 1) return;
      control.send(
        JSON.stringify({
          type: 'response',
          requestId: parsed.data.requestId,
          ok: false,
          error: { code: 'not_ready', message: 'Test wrapper request failed', retryable: true },
        })
      );
    });
  });

  control.send(
    JSON.stringify({
      type: 'event',
      event: 'sandbox.ready',
      payload: { kiloReady: true, globalFeedAttached: true },
    })
  );

  await runInDurableObject(controlStub, instance =>
    instance.request({ operation: 'sandbox.status', payload: {} })
  );

  await expect(
    runInDurableObject(controlStub, instance => instance.getStatus())
  ).resolves.toMatchObject({
    connection: 'ready',
    physical: 'running',
    wrapperInstanceId,
  });

  const admission = await runInDurableObject(sessionStub, instance =>
    instance.createSessionWithInitialAdmission({
      identity: sessionIdentity,
      auth: { kiloSessionId },
      agent: { mode: 'code', model: 'test-model' },
      workspace: { sandboxId, sandboxProvider: 'cloudflare' },
      message: {
        initialTurn: { messageId: `msg_${identity}`, type: 'prompt', prompt: 'Prepare workspace' },
      },
    })
  );
  if (!admission.success) throw new Error(`Session admission failed: ${admission.error}`);
  await prepared;

  const created = await runInDurableObject(sessionStub, instance =>
    instance.createTerminal({ cols: 80, rows: 24 })
  );
  if (!created.success) throw new Error(`Terminal creation failed: ${created.error}`);
  expect(created).toMatchObject({ success: true, data: { pty: { id: ptyId } } });
  expect(fixture.errors).toEqual([]);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures) await fixture.dispose();
  fixtures.clear();
});

describe('SandboxSession terminal bridge in the Workers runtime', () => {
  it('pairs reentrant hibernating sockets and forwards native terminal frames', async () => {
    const fixture = await createFixture();
    const browser = await fixture.openBrowser({ initialOutput: 'initial output' });
    const wrapper = fixture.connections[0];
    expect(wrapper).toBeDefined();
    if (!wrapper) throw new Error('Missing reverse terminal socket');
    const session = getSandboxSessionStub(env, fixture.ownerId, fixture.sessionId);
    const latestEventId = await runInDurableObject(session, instance =>
      instance.getLatestEventId()
    );

    await expect(browser.inbox.next()).resolves.toBe('initial output');

    browser.socket.send('browser input');
    await expect(wrapper.inbox.next()).resolves.toBe('browser input');

    wrapper.socket.send('wrapper output');
    await expect(browser.inbox.next()).resolves.toBe('wrapper output');

    browser.socket.send('ping');
    await expect(wrapper.inbox.next()).resolves.toBe('ping');
    wrapper.socket.send('pong');
    await expect(browser.inbox.next()).resolves.toBe('pong');

    const binary = new Uint8Array([0, 1, 127, 128, 255]);
    browser.socket.send(binary);
    const forwarded = await wrapper.inbox.next();
    expect(forwarded).toBeInstanceOf(ArrayBuffer);
    if (forwarded instanceof ArrayBuffer) {
      expect(Array.from(new Uint8Array(forwarded))).toEqual(Array.from(binary));
    }

    const upstreamBinary = new Uint8Array([255, 128, 0]);
    wrapper.socket.send(upstreamBinary);
    const returned = await browser.inbox.next();
    expect(returned).toBeInstanceOf(ArrayBuffer);
    if (returned instanceof ArrayBuffer) {
      expect(Array.from(new Uint8Array(returned))).toEqual(Array.from(upstreamBinary));
    }

    wrapper.socket.send('\u0000cursor-control');
    await expect(browser.inbox.next()).resolves.toBe('\u0000cursor-control');

    const attachments = await runInDurableObject(session, async (_instance, state) =>
      state.getWebSockets('terminal').map(socket => ({
        tags: state.getTags(socket),
        attachment: socket.deserializeAttachment(),
      }))
    );
    expect(attachments).toHaveLength(2);
    expect(attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tags: ['terminal', `terminal:browser:${fixture.ptyId}`],
          attachment: expect.objectContaining({
            role: 'browser',
            ptyId: fixture.ptyId,
            bridgeGeneration: wrapper.payload.bridgeGeneration,
            wrapperInstanceId: fixture.wrapperInstanceId,
            lastActivityReportedAt: expect.any(Number),
          }),
        }),
        expect.objectContaining({
          tags: ['terminal', `terminal:wrapper:${fixture.ptyId}`],
          attachment: expect.objectContaining({
            role: 'wrapper',
            ptyId: fixture.ptyId,
            bridgeGeneration: wrapper.payload.bridgeGeneration,
            wrapperInstanceId: fixture.wrapperInstanceId,
            lastActivityReportedAt: expect.any(Number),
          }),
        }),
      ])
    );
    for (const entry of attachments) {
      expect(entry.attachment).not.toHaveProperty('capability');
      expect(entry.attachment).not.toHaveProperty('capabilityHash');
    }
    await expect(
      runInDurableObject(session, instance => instance.getLatestEventId())
    ).resolves.toBe(latestEventId);
    expect(fixture.errors).toEqual([]);
  });

  it('rejects unauthorized producers and atomically consumes concurrent capabilities', async () => {
    const fixture = await createFixture();
    const missingCredential = await SELF.fetch(fixture.reverseUrl(), {
      headers: { Upgrade: 'websocket' },
    });
    expect(missingCredential.status).toBe(401);

    await fixture.openBrowser({ unauthorizedFirst: true, concurrentRedemption: true });
    const connection = fixture.connections[0];
    if (!connection) throw new Error('Missing authenticated reverse socket');
    expect(connection.unauthorizedStatuses).toEqual([401, 401]);

    const replay = await SELF.fetch(fixture.reverseUrl(), {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${connection.payload.capability}`,
      },
    });
    expect(replay.status).toBe(401);

    const wrongOwner = await SELF.fetch(
      `http://worker.test/sandbox-terminal/${encodeURIComponent('user_wrong')}/${fixture.sessionId}/${fixture.ptyId}`,
      {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${connection.payload.capability}`,
        },
      }
    );
    expect(wrongOwner.status).toBe(401);
    expect(fixture.errors).toEqual([]);
  });

  it('rejects PTYs owned by another workspace session for the same owner', async () => {
    const first = await createFixture('user_shared_terminal_owner');
    const second = await createFixture('user_shared_terminal_owner');
    const query = new URLSearchParams({
      ownerId: first.ownerId,
      sessionId: first.sessionId,
      ptyId: second.ptyId,
    });
    const denied = await SELF.fetch(`http://worker.test/terminal-test?${query.toString()}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(denied.status).toBe(404);

    const session = getSandboxSessionStub(env, first.ownerId, first.sessionId);
    await expect(
      runInDurableObject(session, instance =>
        instance.resizeTerminal({ ptyId: second.ptyId, cols: 100, rows: 30 })
      )
    ).resolves.toMatchObject({ success: false });
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  it('reconnects the same PTY while fencing superseded browser and wrapper generations', async () => {
    const fixture = await createFixture();
    const first = await fixture.openBrowser();
    const oldWrapper = fixture.connections[0];
    if (!oldWrapper) throw new Error('Missing first reverse socket');

    const second = await fixture.openBrowser();
    const newWrapper = fixture.connections[1];
    if (!newWrapper) throw new Error('Missing replacement reverse socket');

    await expect(first.closed).resolves.toMatchObject({ code: 4000 });
    await expect(oldWrapper.closed).resolves.toMatchObject({ code: 4000 });
    expect(newWrapper.payload.bridgeGeneration).not.toBe(oldWrapper.payload.bridgeGeneration);
    expect(newWrapper.payload.capability).not.toBe(oldWrapper.payload.capability);

    second.socket.send('replacement input');
    await expect(newWrapper.inbox.next()).resolves.toBe('replacement input');
    newWrapper.socket.send('replacement output');
    await expect(second.inbox.next()).resolves.toBe('replacement output');

    const replay = await SELF.fetch(fixture.reverseUrl(), {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${oldWrapper.payload.capability}`,
      },
    });
    expect(replay.status).toBe(401);
    expect(fixture.errors).toEqual([]);
  });

  it('reconnects a running PTY after the browser disconnects', async () => {
    const fixture = await createFixture();
    const first = await fixture.openBrowser();
    const oldWrapper = fixture.connections[0];
    if (!oldWrapper) throw new Error('Missing original reverse socket');

    first.socket.close(1000, 'verification reconnect');
    const [browserClose, wrapperClose] = await Promise.all([first.closed, oldWrapper.closed]);
    expect(browserClose).toMatchObject({ code: 1000, reason: 'verification reconnect' });
    expect(wrapperClose).toMatchObject({ code: 1000 });

    const reconnected = await fixture.openBrowser();
    const replacement = fixture.connections[1];
    if (!replacement) throw new Error('Missing reconnected reverse socket');
    reconnected.socket.send('shell still running');
    await expect(replacement.inbox.next()).resolves.toBe('shell still running');
    expect(fixture.errors).toEqual([]);
  });

  it('treats abnormal wrapper failures as retryable without ending the PTY', async () => {
    const fixture = await createFixture();
    const browser = await fixture.openBrowser();
    const wrapper = fixture.connections[0];
    if (!wrapper) throw new Error('Missing reverse socket');

    wrapper.socket.close(1011, 'upstream disconnected');
    await expect(browser.closed).resolves.toMatchObject({ code: 1011 });

    const reconnected = await fixture.openBrowser();
    const replacement = fixture.connections[1];
    if (!replacement) throw new Error('Missing replacement reverse socket');
    replacement.socket.send('upstream recovered');
    await expect(reconnected.inbox.next()).resolves.toBe('upstream recovered');
    expect(fixture.errors).toEqual([]);
  });

  it.each([
    {
      failure: 'a control request fails',
      response: {
        ok: false,
        error: { code: 'not_ready', message: 'Wrapper unavailable', retryable: true },
      } satisfies Omit<ResponseFrame, 'type' | 'requestId'>,
    },
    { failure: 'PTY deletion returns false', response: { ok: true, result: { success: false } } },
  ])('keeps a terminal usable and retries close when $failure', async ({ response }) => {
    const fixture = await createFixture();
    const browser = await fixture.openBrowser();
    const wrapper = fixture.connections[0];
    if (!wrapper) throw new Error('Missing reverse socket');
    const session = getSandboxSessionStub(env, fixture.ownerId, fixture.sessionId);
    fixture.nextCloseResponse = response;

    await expect(
      runInDurableObject(session, instance => instance.closeTerminal({ ptyId: fixture.ptyId }))
    ).resolves.toEqual({ success: false, error: 'Terminal closure failed; please retry' });
    await expect(
      runInDurableObject(session, async (_instance, state) =>
        state.storage.kv.get(`terminal:${fixture.ptyId}`)
      )
    ).resolves.toMatchObject({ state: 'running' });

    browser.socket.send('still running after failed close');
    await expect(wrapper.inbox.next()).resolves.toBe('still running after failed close');
    wrapper.socket.send('close can be retried');
    await expect(browser.inbox.next()).resolves.toBe('close can be retried');

    await expect(
      runInDurableObject(session, instance => instance.closeTerminal({ ptyId: fixture.ptyId }))
    ).resolves.toEqual({ success: true, data: { success: true } });
    await expect(browser.closed).resolves.toMatchObject({
      code: 1000,
      reason: 'PTY session ended',
    });
    await expect(wrapper.closed).resolves.toMatchObject({
      code: 1000,
      reason: 'PTY session ended',
    });
    await expect(
      runInDurableObject(session, async (_instance, state) =>
        state.storage.kv.get(`terminal:${fixture.ptyId}`)
      )
    ).resolves.toMatchObject({ state: 'ended' });
    expect(fixture.errors).toEqual([]);
  });

  it('revokes terminal sockets only for their matching organization', async () => {
    const fixture = await createFixture('user_terminal_org', 'org_terminal');
    const browser = await fixture.openBrowser();
    const wrapper = fixture.connections[0];
    if (!wrapper) throw new Error('Missing organization reverse socket');
    const session = getSandboxSessionStub(env, fixture.ownerId, fixture.sessionId);

    await expect(
      runInDurableObject(session, instance => instance.closeOrgStreams('org_other'))
    ).resolves.toBe(0);
    browser.socket.send('organization still authorized');
    await expect(wrapper.inbox.next()).resolves.toBe('organization still authorized');

    await expect(
      runInDurableObject(session, instance => instance.closeOrgStreams('org_terminal'))
    ).resolves.toBe(0);
    await expect(browser.closed).resolves.toMatchObject({
      code: 1000,
      reason: 'session access revoked',
    });
    await expect(wrapper.closed).resolves.toMatchObject({ code: 1000 });
    expect(fixture.errors).toEqual([]);
  });

  it('closes and permanently fences terminal access when the session is deleted', async () => {
    const fixture = await createFixture();
    const browser = await fixture.openBrowser();
    const wrapper = fixture.connections[0];
    if (!wrapper) throw new Error('Missing deleted-session reverse socket');
    const session = getSandboxSessionStub(env, fixture.ownerId, fixture.sessionId);

    await runInDurableObject(session, instance => instance.deleteSession());
    await expect(browser.closed).resolves.toMatchObject({
      code: 1000,
      reason: 'session access revoked',
    });
    await expect(wrapper.closed).resolves.toMatchObject({ code: 1000 });
    await expect(
      runInDurableObject(session, instance => instance.getMetadata())
    ).resolves.toBeNull();
    await expect(
      runInDurableObject(env.SANDBOX_CONTROL.getByName(fixture.sandboxId), instance =>
        instance.listRoutes()
      )
    ).resolves.toEqual([]);

    const query = new URLSearchParams({
      ownerId: fixture.ownerId,
      sessionId: fixture.sessionId,
      ptyId: fixture.ptyId,
    });
    const rejected = await SELF.fetch(`http://worker.test/terminal-test?${query.toString()}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(rejected.status).toBe(404);
    expect(fixture.errors).toEqual([]);
  });

  it('invalidates only terminal bridges belonging to the confirmed wrapper runtime', async () => {
    const fixture = await createFixture();
    const browser = await fixture.openBrowser();
    const wrapper = fixture.connections[0];
    if (!wrapper) throw new Error('Missing runtime-bound reverse socket');
    const session = getSandboxSessionStub(env, fixture.ownerId, fixture.sessionId);

    await runInDurableObject(session, instance =>
      instance.invalidateTerminalRuntime({
        sandboxId: fixture.sandboxId,
        wrapperInstanceId: crypto.randomUUID(),
        confirmed: true,
      })
    );
    browser.socket.send('current runtime still active');
    await expect(wrapper.inbox.next()).resolves.toBe('current runtime still active');

    await runInDurableObject(session, instance =>
      instance.invalidateTerminalRuntime({
        sandboxId: fixture.sandboxId,
        wrapperInstanceId: fixture.wrapperInstanceId,
        confirmed: true,
      })
    );
    await expect(browser.closed).resolves.toMatchObject({
      code: 1000,
      reason: 'PTY session ended',
    });
    await expect(wrapper.closed).resolves.toMatchObject({ code: 1000 });

    const reconnect = await fixture.openBrowser();
    await expect(reconnect.closed).resolves.toMatchObject({
      code: 1000,
      reason: 'PTY session ended',
    });
    expect(fixture.errors).toEqual([]);
  });

  it('preserves OAuth owner identities without decoding literal percent escapes twice', async () => {
    const fixture = await createFixture('oauth/google:user%2Fsegment');
    const browser = await fixture.openBrowser();
    const wrapper = fixture.connections[0];
    if (!wrapper) throw new Error('Missing OAuth reverse socket');

    expect(wrapper.payload.ownerId).toBe('oauth/google:user%2Fsegment');
    browser.socket.send('oauth terminal input');
    await expect(wrapper.inbox.next()).resolves.toBe('oauth terminal input');
    expect(fixture.errors).toEqual([]);
  });

  it('marks normally exited PTYs ended and closes authenticated reconnects normally', async () => {
    const fixture = await createFixture();
    const browser = await fixture.openBrowser();
    const wrapper = fixture.connections[0];
    if (!wrapper) throw new Error('Missing reverse socket');

    wrapper.socket.send('final output');
    wrapper.socket.close(1000, 'process exited');
    await expect(browser.inbox.next()).resolves.toBe('final output');
    await expect(browser.closed).resolves.toMatchObject({
      code: 1000,
      reason: 'PTY session ended',
    });

    const reconnect = await fixture.openBrowser();
    await expect(reconnect.closed).resolves.toMatchObject({
      code: 1000,
      reason: 'PTY session ended',
    });
    expect(fixture.connections).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  });

  it('closes oversized native frames without affecting another terminal generation', async () => {
    const fixture = await createFixture();
    const browser = await fixture.openBrowser();
    const wrapper = fixture.connections[0];
    if (!wrapper) throw new Error('Missing reverse socket');

    browser.socket.send('x'.repeat(256 * 1024 + 1));
    await expect(browser.closed).resolves.toMatchObject({ code: 1009 });
    await expect(wrapper.closed).resolves.toMatchObject({ code: 1009 });
    expect(fixture.errors).toEqual([]);
  });
});
