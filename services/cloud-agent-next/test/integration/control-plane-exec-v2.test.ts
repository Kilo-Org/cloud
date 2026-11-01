import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlanePromptPayload,
  type ControlPlaneWrapperFrame,
} from '../../src/shared/control-plane-protocol.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import {
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { installFakeRuntimeProxyPeer } from './helpers/fake-session-peer.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_exec';
const ORG_ID = 'org_exec';
const WRAPPER_ID = 'wr_exec';
const ROUTE_READY_RETRY_MS = 5_000;

type FakeProvider = { adapter: ProviderAdapter; launchEnvs: Record<string, string>[] };

const execResult = {
  exitCode: 0,
  timedOut: false,
  durationMs: 3,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdout: 'hello\n',
  stderr: '',
};

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
    auth: { kiloSessionId: input.kiloSessionId, kilocodeToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
    workspace: {
      branchName: 'kilo/b12',
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
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, { env: launchEnv }) {
      provider.launchEnvs.push({ ...launchEnv });
      return { startSource: 'image' as const };
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
    installFakeRuntimeProxyPeer(instance);
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
  wrapperId: string,
  execCommand: boolean
): Promise<FakeWrapper> {
  const { credential, allocationId } = launchIdentity(provider);
  const wrapper = await FakeWrapper.connect({ sandboxId, credential });
  const reply = await wrapper.hello({ wrapperId, allocationId, execCommand });
  expect(reply).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
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

async function startExecSandbox(options: { execCommand: boolean }): Promise<{
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
  const wrapper = await connectAndHello(provider, sandboxId, WRAPPER_ID, options.execCommand);
  return { sandboxId, stub, provider, wrapper };
}

afterEach(async () => {
  await reset();
});

describe('control-plane exec on the Sandbox DO', () => {
  it('forwards exec.request to a capable wrapper and returns its result', async () => {
    const { stub, wrapper } = await startExecSandbox({ execCommand: true });
    const session = sessionInput('workspace_exec_ok');

    const pending = stub.execCommand({
      session,
      payload: { command: 'echo hello', timeoutMs: 30_000 },
    });
    const frame = await awaitFrame(wrapper, 'exec.request');
    expect(frame.session).toEqual(session);
    expect(frame.payload).toEqual({ command: 'echo hello', timeoutMs: 30_000 });
    wrapper.send({ type: 'exec.result', requestId: frame.requestId, ok: true, result: execResult });

    await expect(pending).resolves.toEqual({ ok: true, result: execResult });
    wrapper.close();
  });

  it('rejects immediately with unsupported when the wrapper did not advertise execCommand', async () => {
    const { stub, wrapper } = await startExecSandbox({ execCommand: false });

    await expect(
      stub.execCommand({
        session: sessionInput('workspace_exec_old'),
        payload: { command: 'echo hello', timeoutMs: 30_000 },
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported', retryable: false } });
    await expect(wrapper.next(200)).resolves.toBeNull();
    wrapper.close();
  });

  it('reports execution_unknown promptly when the socket closes after dispatch', async () => {
    const { stub, wrapper } = await startExecSandbox({ execCommand: true });

    const pending = stub.execCommand({
      session: sessionInput('workspace_exec_close'),
      payload: { command: 'sleep 10', timeoutMs: 30_000 },
    });
    await awaitFrame(wrapper, 'exec.request');
    wrapper.close();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_unknown', retryable: false },
    });
  });

  it('reports execution_unknown when the request backstop expires after dispatch', async () => {
    const { stub, wrapper } = await startExecSandbox({ execCommand: true });

    const pending = stub.execCommand({
      session: sessionInput('workspace_exec_backstop'),
      payload: { command: 'sleep 1', timeoutMs: 1_000 },
    });
    await awaitFrame(wrapper, 'exec.request');

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_unknown', retryable: false },
    });
    wrapper.close();
  });

  it('uses the command timeout budget instead of the control request default', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const stub = await injectProvider(sandboxId, provider);
    await runInDurableObject(stub, instance => {
      instance.controlRequestTimeoutMs = 25;
    });
    await stub.ensureAllocation({ provider: 'cloudflare', allocationName: sandboxId });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_exec_budget', true);

    const pending = stub.execCommand({
      session: sessionInput('workspace_exec_budget'),
      payload: { command: 'echo budget', timeoutMs: 30_000 },
    });
    const frame = await awaitFrame(wrapper, 'exec.request');
    await new Promise(resolve => setTimeout(resolve, 100));
    wrapper.send({ type: 'exec.result', requestId: frame.requestId, ok: true, result: execResult });

    await expect(pending).resolves.toEqual({ ok: true, result: execResult });
    wrapper.close();
  });

  it('rejects a result frame from a socket other than the request owner', async () => {
    const { sandboxId, stub, provider, wrapper } = await startExecSandbox({ execCommand: true });
    const session = sessionInput('workspace_exec_stale');

    const pending = stub.execCommand({
      session,
      payload: { command: 'echo hello', timeoutMs: 30_000 },
    });
    const frame = await awaitFrame(wrapper, 'exec.request');

    const stale = await FakeWrapper.connect({
      sandboxId,
      credential: launchIdentity(provider).credential,
    });
    stale.send({
      type: 'exec.result',
      requestId: frame.requestId,
      ok: true,
      result: { ...execResult, stdout: 'stale\n' },
    });
    stale.close();

    wrapper.send({
      type: 'exec.result',
      requestId: frame.requestId,
      ok: true,
      result: { ...execResult, stdout: 'fresh\n' },
    });

    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { stdout: 'fresh\n' },
    });
    wrapper.close();
  });
});

async function markRouteReady(
  sessionStub: DurableObjectStub<SandboxSessionV2>,
  wrapper: FakeWrapper,
  sessionId: string
): Promise<void> {
  const isRouteReady = async (): Promise<boolean> => {
    const snapshot = await sessionStub.getSession();
    return snapshot.type === 'found' && snapshot.route.state === 'ready';
  };
  wrapper.send({ type: 'session.ready', sessionId });
  try {
    await waitFor(async () => expect(await isRouteReady()).toBe(true), {
      timeout: ROUTE_READY_RETRY_MS,
    });
  } catch {
    wrapper.send({ type: 'session.ready', sessionId });
    await waitFor(async () => expect(await isRouteReady()).toBe(true));
  }
}

async function startExecSession(options: {
  execCommand: boolean;
  completeMessage: boolean;
}): Promise<{
  sessionId: string;
  sandboxId: string;
  sessionStub: DurableObjectStub<SandboxSessionV2>;
  provider: FakeProvider;
  wrapper: FakeWrapper;
}> {
  const sessionId = newSessionId();
  const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
  const provider = createFakeProvider();
  await injectProvider(sandboxId, provider);
  const sessionStub = sessions.getByName(sessionDoName(USER_ID, sessionId));
  const id = messageId();
  await sessionStub.createSessionWithInitialAdmission({
    metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
    message: promptPayload(id),
    sandboxSelection: { provider: 'cloudflare' },
  });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const wrapper = await connectAndHello(provider, sandboxId, WRAPPER_ID, options.execCommand);
  await awaitFrame(wrapper, 'session.prepare');
  await markRouteReady(sessionStub, wrapper, sessionId);

  if (options.completeMessage) {
    await waitFor(async () => {
      const snapshot = await sessionStub.getSession();
      expect(
        snapshot.type === 'found' &&
          snapshot.messages.some(
            message => message.messageId === id && message.state === 'accepted'
          )
      ).toBe(true);
    });
    wrapper.send({ type: 'session.outcome', sessionId, status: 'completed', lastMessageId: id });
    await waitFor(async () => {
      const snapshot = await sessionStub.getSession();
      expect(
        snapshot.type === 'found' &&
          snapshot.messages.some(
            message => message.messageId === id && message.state === 'completed'
          )
      ).toBe(true);
    });
  }
  return { sessionId, sandboxId, sessionStub, provider, wrapper };
}

describe('control-plane exec on the Session DO', () => {
  it('runs a command through the registered route and returns the wrapper result', async () => {
    const { sessionId, sessionStub, wrapper } = await startExecSession({
      execCommand: true,
      completeMessage: true,
    });

    const pending = sessionStub.execCommand({ command: 'echo hello', timeoutMs: 30_000 });
    const frame = await awaitFrame(wrapper, 'exec.request');
    expect(frame.session.sessionId).toBe(sessionId);
    wrapper.send({ type: 'exec.result', requestId: frame.requestId, ok: true, result: execResult });

    await expect(pending).resolves.toEqual({ ok: true, result: execResult });
    wrapper.close();
  });

  it('rejects while a message is accepted', async () => {
    const { sessionStub, wrapper } = await startExecSession({
      execCommand: true,
      completeMessage: false,
    });

    await waitFor(async () => {
      const snapshot = await sessionStub.getSession();
      expect(
        snapshot.type === 'found' && snapshot.messages.some(message => message.state === 'accepted')
      ).toBe(true);
    });

    await expect(
      sessionStub.execCommand({ command: 'echo hello', timeoutMs: 30_000 })
    ).resolves.toMatchObject({ ok: false, error: { code: 'message_running' } });
    wrapper.close();
  });

  it('reports unsupported before sending a frame to an older runtime', async () => {
    const { sessionStub, wrapper } = await startExecSession({
      execCommand: false,
      completeMessage: true,
    });

    await expect(
      sessionStub.execCommand({ command: 'echo hello', timeoutMs: 30_000 })
    ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported' } });
    const frames: ControlPlaneWrapperFrame[] = [];
    for (;;) {
      const frame = await wrapper.next(200);
      if (frame === null) break;
      frames.push(frame);
    }
    expect(frames.some(frame => frame.type === 'exec.request')).toBe(false);
    wrapper.close();
  });

  it('reports execution_unknown when the wrapper disconnects after dispatch', async () => {
    const { sessionStub, wrapper } = await startExecSession({
      execCommand: true,
      completeMessage: true,
    });

    const pending = sessionStub.execCommand({ command: 'sleep 10', timeoutMs: 30_000 });
    await awaitFrame(wrapper, 'exec.request');
    wrapper.close();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_unknown' },
    });
  });
});
