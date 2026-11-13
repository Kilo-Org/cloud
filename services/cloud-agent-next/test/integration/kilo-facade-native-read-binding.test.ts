import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerUsageRpcMethods } from '@kilocode/container-usage';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { readNativeLiveOperation } from '../../src/kilo-facade/native-live.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import { createMessageId } from '../../src/session/message-id.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlaneNativeOperation,
  type ControlPlanePromptPayload,
} from '../../src/shared/control-plane-protocol.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import {
  createFakeCredentialBroker,
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  FAKE_SANDBOX_CONTAINERS_NAMESPACE,
  installFakeSandboxEnv,
} from './helpers/fake-credentials.js';
import { installFakeRuntimeProxyPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import {
  clearTestSessionIngestState,
  writeTestSessionIngestState,
  type TestSessionIngestRoot,
} from './helpers/session-ingest-double.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;

// `cloudflare:test` types the binding namespaces loosely; the workers pool
// provides the same DO namespaces the Worker binds.
const durableObjects = env as unknown as {
  SANDBOX_CONTROL: SandboxControlNamespace;
  SANDBOX_SESSION: SessionNamespace;
};
const sandboxes = durableObjects.SANDBOX_CONTROL;
const sessions = durableObjects.SANDBOX_SESSION;

const USER_ID = 'user_native_read_binding';
const ORG_ID = 'org_native_read_binding';
const KILO_TOKEN = FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN;

const userId = USER_ID;
// `containedKiloSessionIdSchema` requires exactly 26 alphanumerics after the prefix.
const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
const cloudAgentSessionId = `workspace_${crypto.randomUUID()}`;
const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;

/**
 * The transcript rows and status map a case wants the live runtime to answer
 * with, keyed by the native operation the facade asked for. A case scripts an
 * entry before it calls the route; the wrapper answers the real control-plane
 * `kilo.request` frame with whatever is scripted for that operation.
 */
type ScriptedAnswers = {
  'session.status'?: unknown;
  'session.messages'?: unknown;
};

const answers: ScriptedAnswers = {};

function scriptedAnswer(operation: ControlPlaneNativeOperation): unknown {
  switch (operation.name) {
    case 'session.status':
      return answers['session.status'];
    case 'session.messages':
      return answers['session.messages'];
    default:
      return undefined;
  }
}

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
      branchName: 'kilo/native-read-binding',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare-containers',
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

type FakeProvider = {
  adapter: ProviderAdapter;
  createCalls: number;
  launchEnvs: Record<string, string>[];
};

function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    createCalls: 0,
    launchEnvs: [],
  };
  provider.adapter = {
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      provider.createCalls += 1;
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
    installFakeSandboxEnv(instance, broker, {
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINERS_NAMESPACE,
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

function facadeRequestWithQuery(path: string, query: string): Promise<Response> {
  return SELF.fetch(`http://worker.test/kilo-test${path}?userId=${userId}&${query}`);
}

type LiveSession = {
  sandboxId: string;
  stub: DurableObjectStub<SandboxSessionV2>;
  provider: FakeProvider;
  wrapper: FakeWrapper;
  answers: ScriptedAnswers;
  stopPump: () => void;
};

/**
 * A hosted session whose runtime is live: the Session DO route is ready and a
 * wrapper socket is bound, so a native read reaches the wrapper and comes back
 * through the Session DO and Sandbox DO exactly as it does in production.
 */
async function openLiveSession(): Promise<LiveSession> {
  const sandboxId = await generateSandboxId(cloudAgentSessionId);
  const provider = createFakeProvider();
  const meter = createRecordingMeter();
  await installSandbox(sandboxId, provider.adapter, meter);
  const stub = sessions.getByName(sessionDoName(USER_ID, cloudAgentSessionId));

  await stub.createSessionWithInitialAdmission({
    metadata: metadata({ sessionId: cloudAgentSessionId, kiloSessionId, sandboxId }),
    message: promptPayload('go'),
    sandboxSelection: { provider: 'cloudflare-containers' },
  });

  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const launchEnv = provider.launchEnvs[0];
  if (!launchEnv?.SANDBOX_CONTROL_CREDENTIAL || !launchEnv.CONTROL_PLANE_ALLOCATION_ID) {
    throw new Error('launch environment is missing identity');
  }
  const wrapper = await FakeWrapper.connect({
    sandboxId,
    credential: launchEnv.SANDBOX_CONTROL_CREDENTIAL,
  });
  const welcome = await wrapper.hello({
    wrapperId: 'wr_native_read_binding',
    allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID,
  });
  expect(welcome).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
  const stopPump = startWrapperPump(wrapper);
  wrapper.onFrame(frame => {
    if (frame.type !== 'kilo.request') return;
    wrapper.send({
      type: 'kilo.result',
      requestId: frame.requestId,
      ok: true,
      result: scriptedAnswer(frame.operation),
    });
  });

  await seedRoot({ kiloSessionId, cloudAgentSessionId, title: 'live read binding' });
  await waitFor(async () => {
    const session = await runInDurableObject(stub, instance => instance.getSession());
    expect(session.type === 'found' ? session.route.state : null).toBe('ready');
  });

  return { sandboxId, stub, provider, wrapper, answers, stopPump };
}

function liveRead(operation: ControlPlaneNativeOperation) {
  return readNativeLiveOperation({
    env: env as unknown as Env,
    userId,
    cloudAgentSessionId,
    kiloSessionId,
    operation,
  });
}

afterEach(async () => {
  for (const key of Object.keys(answers) as (keyof ScriptedAnswers)[]) delete answers[key];
  await clearRoots().catch(() => undefined);
  await reset();
});

describe('native live read binding', { timeout: 30_000 }, () => {
  it('returns only the session the live status read resolved from the request directory', async () => {
    const live = await openLiveSession();
    try {
      const siblingKiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      live.answers['session.status'] = {
        [kiloSessionId]: { type: 'busy' },
        [siblingKiloSessionId]: { type: 'idle', directory: '/workspace/sibling' },
      };

      const response = await facadeRequestWithQuery(
        '/kilo/session/status',
        `directory=${encodeURIComponent(publicDirectory)}`
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ [kiloSessionId]: { type: 'busy' } });
    } finally {
      live.stopPump();
      live.wrapper.close();
    }
  });

  it('keeps the transcript of the session the read resolved and refuses a row without an identity', async () => {
    const live = await openLiveSession();
    try {
      const siblingKiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      const ownMessage = {
        info: { id: 'msg_own', sessionID: kiloSessionId },
        parts: [{ type: 'text', text: 'own', sessionID: kiloSessionId }],
      };
      const siblingMessage = {
        info: { id: 'msg_sibling', sessionID: siblingKiloSessionId },
        parts: [{ type: 'text', text: 'sibling', sessionID: siblingKiloSessionId }],
      };
      const ownMessageWithSiblingPart = {
        info: { id: 'msg_mixed', sessionID: kiloSessionId },
        parts: [{ type: 'text', text: 'foreign', sessionID: siblingKiloSessionId }],
      };
      live.answers['session.messages'] = [ownMessage, siblingMessage, ownMessageWithSiblingPart];

      const outcome = await liveRead({ name: 'session.messages' });

      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') throw new Error('expected an answered transcript read');
      // Only the resolved session's row survives; the sibling row and the row
      // whose part names the sibling session are not part of the window.
      expect(outcome.body).toEqual([ownMessage]);
      expect(JSON.stringify(outcome.body)).not.toContain(siblingKiloSessionId);

      live.answers['session.messages'] = [{ info: { id: 'msg_anonymous' }, parts: [] }];
      const refused = await liveRead({ name: 'session.messages' });
      expect(refused).toMatchObject({
        kind: 'failed',
        code: 'KILO_UPSTREAM_RESPONSE_INVALID',
        retryable: false,
      });

      expect(live.wrapper.unparsedFrames()).toEqual([]);
    } finally {
      live.stopPump();
      live.wrapper.close();
    }
  });
});
