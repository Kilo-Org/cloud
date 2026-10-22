import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerUsageRpcMethods } from '@kilocode/container-usage';
import { getBillingContext } from '@kilocode/container-usage';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-plane.js';
import { createMessageId } from '../../src/session/message-id.js';
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
  createFakeCredentialBroker,
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { installFakeRuntimeProxyPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { createSseDataReader } from './helpers/sse-reader.js';
import {
  clearTestSessionIngestState,
  writeTestSessionIngestState,
  TEST_SESSION_INGEST_ROOTS_KEY,
  type TestSessionIngestRoot,
} from './helpers/session-ingest-double.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;

const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_cold_runtime';
const ORG_ID = 'org_cold_runtime';
const KILO_TOKEN = FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN;

const userId = USER_ID;
// `containedKiloSessionIdSchema` requires exactly 26 alphanumerics after the prefix.
const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
const cloudAgentSessionId = `workspace_${crypto.randomUUID()}`;
const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;

type RecordingMeter = ContainerUsageRpcMethods & {
  recordStartInputs: unknown[];
};

function createRecordingMeter(): RecordingMeter {
  const meter: RecordingMeter = {
    recordStartInputs: [],
    async recordStart(input) {
      meter.recordStartInputs.push(input);
      return { success: true, ack: { accepted: true } } as never;
    },
    async recordHeartbeat() {
      return { verdict: 'continue' } as never;
    },
    async recordStop() {
      return { accepted: true } as never;
    },
  };
  return meter;
}

function metadata(input: { sessionId: string; kiloSessionId: string; sandboxId: string }) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'desktop',
    },
    auth: { kiloSessionId: input.kiloSessionId, kilocodeToken: KILO_TOKEN },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'git', url: 'https://github.com/acme/widgets.git', platform: 'github' },
    workspace: {
      branchName: 'kilo/cold-runtime',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare',
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

type FakeProvider = {
  adapter: ProviderAdapter;
  createCalls: number;
  launchEnvs: Record<string, string>[];
  failFirstCreate: boolean;
};

function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    createCalls: 0,
    launchEnvs: [],
    failFirstCreate: false,
  };
  provider.adapter = {
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      provider.createCalls += 1;
      if (provider.failFirstCreate && provider.createCalls === 1) {
        throw new Error('provider create failed');
      }
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, { env: launchEnv }) {
      provider.launchEnvs.push({ ...launchEnv });
      return { startSource: 'image' as const };
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(): Promise<StopResult> {
      return 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

async function installSandbox(
  sandboxId: string,
  provider: ProviderAdapter,
  meter: RecordingMeter
): Promise<DurableObjectStub<SandboxControlV2>> {
  const sandboxStub = sandboxes.getByName(sandboxId);
  const broker = createFakeCredentialBroker();
  await runInDurableObject(sandboxStub, async instance => {
    await instance.getAllocationState();
    const sandboxEnv = (instance as unknown as { env: Record<string, unknown> }).env;
    installFakeCredentialEnv(sandboxEnv, broker, {
      SandboxSmallContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
      WORKER_URL: 'https://control.test',
      KILOCODE_BACKEND_BASE_URL: 'https://control.test',
      KILO_OPENROUTER_BASE: 'https://control.test',
      KILO_SESSION_INGEST_URL: 'https://control.test',
      CONTAINER_USAGE_METER: meter,
    });
    Object.assign(instance, { createProviderAdapter: () => provider, provider });
    installFakeRuntimeProxyPeer(instance);
  });
  return sandboxStub;
}

function startWrapperPump(wrapper: FakeWrapper): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const frame = await wrapper.next(250);
      if (frame === null) continue;
      try {
        if (frame.type === 'session.prepare') {
          wrapper.send({ type: 'session.ready', sessionId: frame.spec.sessionId });
        }
      } catch {
        return;
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

function promptPayload(prompt: string, messageId = createMessageId()): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt },
    agent: { mode: 'code', model: 'test/model' },
  };
}

type ColdSession = {
  sandboxId: string;
  sandboxStub: DurableObjectStub<SandboxControlV2>;
  stub: DurableObjectStub<SandboxSessionV2>;
  provider: FakeProvider;
  meter: RecordingMeter;
};

/** A session DO and sandbox allocation with no session compute requested yet. */
async function openColdSession(): Promise<ColdSession> {
  const sandboxId = await generateSandboxId(
    undefined,
    ORG_ID,
    USER_ID,
    cloudAgentSessionId,
    undefined
  );
  const provider = createFakeProvider();
  const meter = createRecordingMeter();
  const sandboxStub = await installSandbox(sandboxId, provider.adapter, meter);
  const stub = sessions.getByName(sessionDoName(USER_ID, cloudAgentSessionId));
  return { sandboxId, sandboxStub, stub, provider, meter };
}

/** A registered session that has never asked for compute. */
async function registerColdSession(): Promise<ColdSession> {
  const cold = await openColdSession();
  await cold.stub.registerSessionFromMetadata({
    metadata: metadata({
      sessionId: cloudAgentSessionId,
      kiloSessionId,
      sandboxId: cold.sandboxId,
    }),
    sandboxSelection: { provider: 'cloudflare' },
  });
  return cold;
}

async function readBillingContext(stub: DurableObjectStub<SandboxControlV2>): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => getBillingContext(state.storage));
}

function seedRoot(root: TestSessionIngestRoot): Promise<void> {
  const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
  return runInDurableObject(facade, async (_instance, state) => {
    await writeTestSessionIngestState(state.storage, { roots: [root] });
  });
}

function clearRoots(): Promise<void> {
  const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
  return runInDurableObject(facade, async (_instance, state) => {
    await clearTestSessionIngestState(state.storage);
  });
}

async function readRootCount(): Promise<number> {
  const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
  return runInDurableObject(facade, async (_instance, state) => {
    const roots = await state.storage.get<TestSessionIngestRoot[]>(TEST_SESSION_INGEST_ROOTS_KEY);
    return roots?.length ?? 0;
  });
}

function facadeRequest(path: string): Promise<Response> {
  const separator = path.includes('?') ? '&' : '?';
  return SELF.fetch(`http://worker.test/kilo-test${path}${separator}userId=${userId}`);
}

function facadeRequestWithQuery(path: string, query: string): Promise<Response> {
  return SELF.fetch(`http://worker.test/kilo-test${path}?userId=${userId}&${query}`);
}

afterEach(async () => {
  await clearRoots().catch(() => undefined);
  await reset();
});

describe('hosted session cold reads', { timeout: 30_000 }, () => {
  it('serves discovery, detail, transcript and attach without allocating compute or billing', async () => {
    const cold = await registerColdSession();
    try {
      await seedRoot({
        kiloSessionId,
        cloudAgentSessionId,
        title: 'cold session',
        createdOnPlatform: 'desktop',
      });
      expect(await readRootCount()).toBe(1);

      const listed = await facadeRequest('/kilo/session?limit=10');
      expect(listed.status).toBe(200);
      const listedBodies = (await listed.json()) as { id: string }[];
      expect(listedBodies.map(session => session.id)).toContain(kiloSessionId);

      const directory = encodeURIComponent(publicDirectory);
      const attached = await facadeRequestWithQuery('/kilo/event', `directory=${directory}`);
      expect(attached.status).toBe(200);
      const stream = createSseDataReader(attached);
      try {
        await expect(stream.next()).resolves.toMatchObject({ type: 'server.connected' });
        // A cold attach replays the stored log through the fence; it must not
        // stop at "runtime unavailable" the way a live-only read does.
        await expect(stream.next()).resolves.toMatchObject({
          type: 'kilo.native.fence',
          properties: { snapshotComplete: true },
        });
      } finally {
        await stream.cancel();
      }

      // Native live reads have no durable fallback: they answer unavailable
      // rather than waking the sandbox.
      const todo = await facadeRequest(`/kilo/session/${kiloSessionId}/todo`);
      expect(todo.status).toBe(503);
      await expect(todo.json()).resolves.toMatchObject({ error: 'KILO_LIVE_RUNTIME_UNAVAILABLE' });

      expect(cold.provider.createCalls).toBe(0);
      expect(cold.provider.launchEnvs).toHaveLength(0);
      expect(cold.meter.recordStartInputs).toHaveLength(0);
      await expect(readBillingContext(cold.sandboxStub)).resolves.toBeUndefined();
    } finally {
      await clearRoots();
    }
  });

  it('refuses native reads and answers once the runtime generation is lost', async () => {
    const cold = await openColdSession();
    await seedRoot({ kiloSessionId, cloudAgentSessionId, title: 'lost runtime' });
    const message = promptPayload('start a turn');
    await cold.stub.createSessionWithInitialAdmission({
      metadata: metadata({
        sessionId: cloudAgentSessionId,
        kiloSessionId,
        sandboxId: cold.sandboxId,
      }),
      message,
      sandboxSelection: { provider: 'cloudflare' },
    });
    await waitFor(() => expect(cold.provider.launchEnvs).toHaveLength(1));
    const launchEnv = cold.provider.launchEnvs[0];
    if (!launchEnv?.SANDBOX_CONTROL_CREDENTIAL || !launchEnv.CONTROL_PLANE_ALLOCATION_ID) {
      throw new Error('launch environment is missing identity');
    }
    const wrapper = await FakeWrapper.connect({
      sandboxId: cold.sandboxId,
      credential: launchEnv.SANDBOX_CONTROL_CREDENTIAL,
    });
    const welcome = await wrapper.hello({
      wrapperId: 'wr_cold_runtime',
      allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID,
    });
    expect(welcome).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    const stopPump = startWrapperPump(wrapper);

    const received: ControlPlaneWrapperFrame['type'][] = [];
    wrapper.onFrame(frame => received.push(frame.type));

    try {
      await waitFor(async () => {
        const session = await runInDurableObject(cold.stub, instance => instance.getSession());
        expect(session.type === 'found' ? session.route.state : null).toBe('ready');
      });
      const session = await runInDurableObject(cold.stub, instance => instance.getSession());
      if (session.type !== 'found' || session.route.state !== 'ready') {
        throw new Error('expected a ready route');
      }
      const attemptId = session.route.attemptId;

      // The runtime is replaced underneath this hosted session.
      await cold.stub.onRoute({ state: 'lost', attemptId, reason: 'sandbox_stopped' });

      const nativeRead = await runInDurableObject(cold.stub, instance =>
        instance.kiloRequest({ name: 'session.status' })
      );
      expect(nativeRead).toMatchObject({ ok: false, error: { code: 'not_ready' } });

      const answered = await cold.stub.answer({
        sessionId: cloudAgentSessionId,
        reply: { action: 'answer', questionId: 'que_stale_generation', answers: [['yes']] },
      });
      expect(answered).not.toBe('sent');

      // The stale generation must not have been asked to serve either request.
      expect(received).not.toContain('kilo.request');
      expect(received).not.toContain('session.answer');

      // Hosted session identity survives: durable history is still readable.
      const attach = await facadeRequestWithQuery(
        '/kilo/event',
        `directory=${encodeURIComponent(publicDirectory)}`
      );
      expect(attach.status).toBe(200);
      const stream = createSseDataReader(attach);
      await expect(stream.next()).resolves.toMatchObject({ type: 'server.connected' });
      await expect(stream.next()).resolves.toMatchObject({ type: 'kilo.native.fence' });
      await stream.cancel();
    } finally {
      stopPump();
      wrapper.close();
    }
  });

  it('keeps durable history intact and refuses a replayed intent when the provider fails', async () => {
    const cold = await openColdSession();
    cold.provider.failFirstCreate = true;
    const firstMessage = promptPayload('first attempt');

    await cold.stub.createSessionWithInitialAdmission({
      metadata: metadata({
        sessionId: cloudAgentSessionId,
        kiloSessionId,
        sandboxId: cold.sandboxId,
      }),
      message: firstMessage,
      sandboxSelection: { provider: 'cloudflare' },
    });

    await waitFor(() => expect(cold.provider.createCalls).toBeGreaterThanOrEqual(1));

    // A provider outage never marks the sandbox live and never opens a billing
    // interval, and the accepted turn is stored exactly once.
    expect(cold.provider.launchEnvs).toHaveLength(0);
    await expect(readBillingContext(cold.sandboxStub)).resolves.toBeUndefined();
    const afterFailure = await runInDurableObject(cold.stub, instance => instance.getSession());
    if (afterFailure.type !== 'found') throw new Error('expected a session');
    expect(
      afterFailure.messages.filter(entry => entry.messageId === firstMessage.messageId)
    ).toHaveLength(1);
    expect(afterFailure.route.state).not.toBe('ready');

    // Native reads cannot reach a runtime that was never launched.
    const nativeRead = await runInDurableObject(cold.stub, instance =>
      instance.kiloRequest({ name: 'session.status' })
    );
    expect(nativeRead).toMatchObject({ ok: false, error: { code: 'not_ready' } });

    // The same durable identity cannot be admitted again, so a retry cannot
    // create a second accepted turn for the failed intent.
    await cold.stub.send(firstMessage);
    const afterReplay = await runInDurableObject(cold.stub, instance => instance.getSession());
    if (afterReplay.type !== 'found') throw new Error('expected a session');
    expect(
      afterReplay.messages.filter(entry => entry.messageId === firstMessage.messageId)
    ).toHaveLength(1);
  });
});
