import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-plane.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import type {
  ControlPlanePromptPayload,
  ControlPlaneWrapperFrame,
} from '../../src/shared/control-plane-protocol.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import {
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_term';
const ORG_ID = 'org_term';
const WRAPPER_ID = 'wr_terminal';

type FakeProvider = { adapter: ProviderAdapter; launchEnvs: Record<string, string>[] };

function newSessionId(): string {
  return `workspace_${crypto.randomUUID()}`;
}

function kiloSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

function messageId(): string {
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
  return `msg_${hex}${suffix}`;
}

function metadata(input: { sessionId: string; kiloSessionId: string; sandboxId: string }) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: input.kiloSessionId, kilocodeToken: 'native-token' },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
    workspace: {
      branchName: 'kilo/b10t',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare',
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function promptPayload(id: string): ControlPlanePromptPayload {
  return {
    messageId: id,
    turn: { type: 'prompt', prompt: 'hello' },
    agent: { mode: 'code', model: 'test/model' },
  };
}

function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = { adapter: null as unknown as ProviderAdapter, launchEnvs: [] };
  provider.adapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, launchEnv) {
      provider.launchEnvs.push({ ...launchEnv });
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop() {
      return 'terminal' as StopResult;
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

async function injectProvider(
  sandboxId: string,
  provider: FakeProvider
): Promise<DurableObjectStub<SandboxControlV2>> {
  const stub = sandboxes.getByName(sandboxId);
  const broker = createFakeCredentialBroker();
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance.env, broker, {
      SandboxSmallContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
      WORKER_URL: 'https://control.test',
      KILOCODE_BACKEND_BASE_URL: 'https://control.test',
      KILO_OPENROUTER_BASE: 'https://control.test',
      KILO_SESSION_INGEST_URL: 'https://control.test',
    });
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
    });
  });
  return stub;
}

function launchIdentity(provider: FakeProvider): { credential: string; allocationId: string } {
  const launchEnv = provider.launchEnvs[0];
  if (!launchEnv) throw new Error('provider.launch was not called');
  const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
  if (!credential || !allocationId) throw new Error('launch environment is missing identity');
  return { credential, allocationId };
}

async function connectAndHello(
  provider: FakeProvider,
  sandboxId: string,
  wrapperId: string
): Promise<FakeWrapper> {
  const { credential, allocationId } = launchIdentity(provider);
  const wrapper = await FakeWrapper.connect({ sandboxId, credential });
  const reply = await wrapper.hello({ wrapperId, allocationId });
  expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });
  return wrapper;
}

async function awaitFrame<T extends ControlPlaneWrapperFrame['type']>(
  wrapper: FakeWrapper,
  type: T
): Promise<Extract<ControlPlaneWrapperFrame, { type: T }>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const frame = await wrapper.next();
    if (frame === null) throw new Error('wrapper socket closed');
    if (frame.type === type) return frame as Extract<ControlPlaneWrapperFrame, { type: T }>;
  }
  throw new Error(`did not receive a ${type} frame`);
}

function sessionInput(sessionId: string) {
  return { sessionId, kiloSessionId: kiloSessionId(), directory: `/workspace/${sessionId}` };
}

function pty(id: string, cwd: string) {
  return {
    id,
    title: 'Terminal',
    command: '/bin/sh',
    args: [],
    cwd,
    status: 'running' as const,
    pid: 1234,
  };
}

async function startTerminalSandbox(): Promise<{
  sandboxId: string;
  stub: DurableObjectStub<SandboxControlV2>;
  provider: FakeProvider;
  wrapper: FakeWrapper;
}> {
  const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
  const provider = createFakeProvider();
  const stub = await injectProvider(sandboxId, provider);
  await stub.ensureAllocation({ provider: 'cloudflare', allocationName: sandboxId });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const wrapper = await connectAndHello(provider, sandboxId, WRAPPER_ID);
  return { sandboxId, stub, provider, wrapper };
}

afterEach(async () => {
  await reset();
});

describe('control-plane terminals on the Sandbox DO (B10)', () => {
  it('forwards create/resize/close/connect and returns each wrapper result', async () => {
    const { stub, wrapper } = await startTerminalSandbox();
    const session = sessionInput('workspace_term');

    const created = stub.terminal({
      operation: 'create',
      session,
      payload: { operationId: crypto.randomUUID(), cols: 120, rows: 40 },
    });
    const createFrame = await awaitFrame(wrapper, 'terminal.create');
    expect(createFrame.session).toEqual(session);
    wrapper.send({
      type: 'terminal.result',
      requestId: createFrame.requestId,
      ok: true,
      result: { pty: pty('pty_1', session.directory) },
    });
    await expect(created).resolves.toMatchObject({ ok: true, result: { pty: { id: 'pty_1' } } });

    const resized = stub.terminal({
      operation: 'resize',
      session,
      payload: { ptyId: 'pty_1', cols: 80, rows: 24 },
    });
    const resizeFrame = await awaitFrame(wrapper, 'terminal.resize');
    expect(resizeFrame.payload).toEqual({ ptyId: 'pty_1', cols: 80, rows: 24 });
    wrapper.send({
      type: 'terminal.result',
      requestId: resizeFrame.requestId,
      ok: true,
      result: { pty: pty('pty_1', session.directory) },
    });
    await expect(resized).resolves.toMatchObject({ ok: true });

    const connected = stub.terminal({
      operation: 'connect',
      session,
      payload: {
        ownerId: USER_ID,
        ptyId: 'pty_1',
        bridgeGeneration: crypto.randomUUID(),
        capability: 'a'.repeat(64),
      },
    });
    const connectFrame = await awaitFrame(wrapper, 'terminal.connect');
    wrapper.send({
      type: 'terminal.result',
      requestId: connectFrame.requestId,
      ok: true,
      result: { connected: true },
    });
    await expect(connected).resolves.toEqual({ ok: true, result: { connected: true } });

    const closed = stub.terminal({ operation: 'close', session, payload: { ptyId: 'pty_1' } });
    const closeFrame = await awaitFrame(wrapper, 'terminal.close');
    wrapper.send({
      type: 'terminal.result',
      requestId: closeFrame.requestId,
      ok: true,
      result: { success: true },
    });
    await expect(closed).resolves.toEqual({ ok: true, result: { success: true } });
    wrapper.close();
  });

  it('returns a retryable not_ready when no wrapper is connected', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const stub = await injectProvider(sandboxId, provider);
    await stub.ensureAllocation({ provider: 'cloudflare', allocationName: sandboxId });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));

    await expect(
      stub.terminal({
        operation: 'create',
        session: sessionInput('workspace_none'),
        payload: { operationId: crypto.randomUUID() },
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_ready', retryable: true } });
  });

  it('settles a pending terminal request when the server closes the wrapper socket', async () => {
    const { stub, wrapper } = await startTerminalSandbox();
    const pending = stub.terminal({
      operation: 'create',
      session: sessionInput('workspace_close'),
      payload: { operationId: crypto.randomUUID() },
    });
    await awaitFrame(wrapper, 'terminal.create');

    // Simulate the server-side disconnect path (heartbeat expiry): the DO closes
    // the wrapper socket itself, so no `webSocketClose` callback runs.
    await runInDurableObject(stub, async instance => {
      await (
        instance as unknown as { runCloseSocket: (state: unknown) => Promise<void> }
      ).runCloseSocket(await instance.getAllocationState());
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_ready', retryable: true },
    });
  });
});

async function markRouteReady(
  sessionStub: DurableObjectStub<SandboxSessionV2>,
  wrapper: FakeWrapper,
  sessionId: string
): Promise<void> {
  wrapper.send({ type: 'session.ready', sessionId });
  await waitFor(async () => {
    const snapshot = await sessionStub.getSession();
    expect(snapshot.type === 'found' && snapshot.route.state === 'ready').toBe(true);
  });
}

async function startTerminalSession(): Promise<{
  sessionId: string;
  sandboxId: string;
  sessionStub: DurableObjectStub<SandboxSessionV2>;
  wrapper: FakeWrapper;
}> {
  const sessionId = newSessionId();
  const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
  const provider = createFakeProvider();
  await injectProvider(sandboxId, provider);
  const sessionStub = sessions.getByName(sessionDoName(USER_ID, sessionId));
  await sessionStub.createSessionWithInitialAdmission({
    metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
    message: promptPayload(messageId()),
    sandboxSelection: { provider: 'cloudflare' },
  });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const wrapper = await connectAndHello(provider, sandboxId, WRAPPER_ID);
  await markRouteReady(sessionStub, wrapper, sessionId);
  return { sessionId, sandboxId, sessionStub, wrapper };
}

describe('control-plane terminals on the Session DO (B10)', () => {
  it('creates, resizes, connects and closes a terminal through the real DOs', async () => {
    const { sessionStub, wrapper } = await startTerminalSession();

    const create = sessionStub.terminalCreate({ operationId: crypto.randomUUID() });
    const createFrame = await awaitFrame(wrapper, 'terminal.create');
    const directory = createFrame.session.directory;
    wrapper.send({
      type: 'terminal.result',
      requestId: createFrame.requestId,
      ok: true,
      result: { pty: pty('pty_1', directory) },
    });
    await expect(create).resolves.toMatchObject({ success: true, data: { pty: { id: 'pty_1' } } });

    const resize = sessionStub.terminalResize({ ptyId: 'pty_1', cols: 80, rows: 24 });
    const resizeFrame = await awaitFrame(wrapper, 'terminal.resize');
    wrapper.send({
      type: 'terminal.result',
      requestId: resizeFrame.requestId,
      ok: true,
      result: { pty: pty('pty_1', directory) },
    });
    await expect(resize).resolves.toMatchObject({ success: true });

    const close = sessionStub.terminalClose({ ptyId: 'pty_1' });
    const closeFrame = await awaitFrame(wrapper, 'terminal.close');
    wrapper.send({
      type: 'terminal.result',
      requestId: closeFrame.requestId,
      ok: true,
      result: { success: true },
    });
    await expect(close).resolves.toMatchObject({ success: true, data: { success: true } });

    // The record is keyed by the V2 wrapper identity and marked ended.
    const record = await runInDurableObject(sessionStub, (_instance, state) =>
      state.storage.get<{ wrapperId: string; state: string }>(`control_terminal:pty_1`)
    );
    expect(record).toMatchObject({ wrapperId: WRAPPER_ID, state: 'ended' });
    wrapper.close();
  });

  it('replays a terminal create idempotently without a second wrapper frame', async () => {
    const { sessionStub, wrapper } = await startTerminalSession();
    const operationId = crypto.randomUUID();

    const first = sessionStub.terminalCreate({ operationId });
    const frame = await awaitFrame(wrapper, 'terminal.create');
    wrapper.send({
      type: 'terminal.result',
      requestId: frame.requestId,
      ok: true,
      result: { pty: pty('pty_1', frame.session.directory) },
    });
    await expect(first).resolves.toMatchObject({ success: true });

    await expect(sessionStub.terminalCreate({ operationId })).resolves.toMatchObject({
      success: true,
      data: { pty: { id: 'pty_1' } },
    });
    // No second frame: the replay is answered from the completed operation.
    await expect(wrapper.next(200)).resolves.toBeNull();
    wrapper.close();
  });

  it('refuses a terminal before the route is ready', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    await injectProvider(sandboxId, provider);
    const sessionStub = sessions.getByName(sessionDoName(USER_ID, sessionId));
    await sessionStub.createSessionWithInitialAdmission({
      metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
      message: promptPayload(messageId()),
      sandboxSelection: { provider: 'cloudflare' },
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));

    await expect(
      sessionStub.terminalCreate({ operationId: crypto.randomUUID() })
    ).resolves.toMatchObject({ success: false });
  });
});

describe('control-plane terminal bridge routing on the Session DO (B10)', () => {
  it('answers the V2 terminal fetch paths and rejects non-terminal paths', async () => {
    const { sessionStub } = await startTerminalSession();

    const notUpgrade = await sessionStub.fetch(
      new Request('https://control.test/terminal/browser?ptyId=pty_1')
    );
    expect(notUpgrade.status).toBe(426);

    const unknownPty = await sessionStub.fetch(
      new Request('https://control.test/terminal/browser?ptyId=pty_missing', {
        headers: { Upgrade: 'websocket' },
      })
    );
    expect(unknownPty.status).toBe(404);

    const wrapperNoAuth = await sessionStub.fetch(
      new Request('https://control.test/terminal/wrapper?ptyId=pty_1', {
        headers: { Upgrade: 'websocket' },
      })
    );
    expect(wrapperNoAuth.status).toBe(401);

    const notFound = await sessionStub.fetch(new Request('https://control.test/nope'));
    expect(notFound.status).toBe(404);
  });

  it('forwards a browser connect request to the wrapper before the reverse socket exists', async () => {
    const { sessionStub, wrapper } = await startTerminalSession();

    const created = sessionStub.terminalCreate({ operationId: crypto.randomUUID() });
    const createFrame = await awaitFrame(wrapper, 'terminal.create');
    wrapper.send({
      type: 'terminal.result',
      requestId: createFrame.requestId,
      ok: true,
      result: { pty: pty('pty_1', createFrame.session.directory) },
    });
    await created;

    const browser = sessionStub.fetch(
      new Request('https://control.test/terminal/browser?ptyId=pty_1', {
        headers: { Upgrade: 'websocket' },
      })
    );
    const connectFrame = await awaitFrame(wrapper, 'terminal.connect');
    expect(connectFrame.payload.ptyId).toBe('pty_1');
    wrapper.send({
      type: 'terminal.result',
      requestId: connectFrame.requestId,
      ok: true,
      result: { connected: true },
    });
    await expect(browser).resolves.toMatchObject({ status: 409 });
    wrapper.close();
  });
});
