import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-plane.js';
import { createMessageId } from '../../src/session/message-id.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlaneEvent,
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
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { installFakeRuntimeProxyPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { createSseDataReader, readSseUntil } from './helpers/sse-reader.js';
import {
  clearTestSessionIngestState,
  writeTestSessionIngestState,
  type TestSessionIngestRoot,
} from './helpers/session-ingest-double.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;

const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_native_fence';
const ORG_ID = 'org_native_fence';
const KILO_TOKEN = FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN;

const userId = USER_ID;
// `containedKiloSessionIdSchema` requires exactly 26 alphanumerics after the prefix.
const qualifiedKiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
const cloudAgentSessionId = `workspace_${'10000000-0000-4000-8000-000000000001'}`;

type ActiveSession = {
  sandboxId: string;
  stub: DurableObjectStub<SandboxSessionV2>;
  wrapper: FakeWrapper;
  stopPump: () => void;
};

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
      branchName: 'kilo/native-fence',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare',
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function createFakeProvider(): {
  adapter: ProviderAdapter;
  launchEnvs: Record<string, string>[];
} {
  const provider = {
    adapter: null as unknown as ProviderAdapter,
    launchEnvs: [] as Record<string, string>[],
  };
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
  provider: ProviderAdapter
): Promise<DurableObjectStub<SandboxControlV2>> {
  const sandboxStub = sandboxes.getByName(sandboxId);
  const broker = createFakeCredentialBroker();
  await runInDurableObject(sandboxStub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(
      (instance as unknown as { env: Record<string, unknown> }).env,
      broker,
      {
        SandboxSmallContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
        WORKER_URL: 'https://control.test',
        KILOCODE_BACKEND_BASE_URL: 'https://control.test',
        KILO_OPENROUTER_BASE: 'https://control.test',
        KILO_SESSION_INGEST_URL: 'https://control.test',
      }
    );
    Object.assign(instance, { createProviderAdapter: () => provider, provider });
    installFakeRuntimeProxyPeer(instance);
  });
  return sandboxStub;
}

/**
 * Answers `session.prepare` with `session.ready`, the one wrapper behavior the
 * route needs before it can deliver native events.
 */
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

async function startReadySession(): Promise<ActiveSession> {
  const sandboxId = await generateSandboxId(
    undefined,
    ORG_ID,
    USER_ID,
    cloudAgentSessionId,
    undefined
  );
  const provider = createFakeProvider();
  await installSandbox(sandboxId, provider.adapter);

  const stub = sessions.getByName(sessionDoName(USER_ID, cloudAgentSessionId));
  const message: ControlPlanePromptPayload = {
    messageId: createMessageId(),
    turn: { type: 'prompt', prompt: 'native fence fixture' },
    agent: { mode: 'code', model: 'test/model' },
  };
  await stub.createSessionWithInitialAdmission({
    metadata: metadata({
      sessionId: cloudAgentSessionId,
      kiloSessionId: qualifiedKiloSessionId,
      sandboxId,
    }),
    message,
    sandboxSelection: { provider: 'cloudflare' },
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
    wrapperId: 'wr_native_fence',
    allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID,
  });
  expect(welcome).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
  const stopPump = startWrapperPump(wrapper);

  await waitFor(async () => {
    const result = await stub.getMessageResult(message.messageId);
    expect(result.type === 'found' ? result.result.status : null).toBe('running');
  });

  return { sandboxId, stub, wrapper, stopPump };
}

async function durableSnapshot(stub: DurableObjectStub<SandboxSessionV2>) {
  return runInDurableObject(stub, instance => instance.nativeSnapshot({}));
}

async function seedFacadeRoots(root: TestSessionIngestRoot): Promise<void> {
  const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
  await runInDurableObject(facade, async (_instance, state) => {
    await writeTestSessionIngestState(state.storage, { roots: [root] });
  });
}

async function clearFacadeRoots(): Promise<void> {
  const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
  await runInDurableObject(facade, async (_instance, state) => {
    await clearTestSessionIngestState(state.storage);
  });
}

function attach(): Promise<Response> {
  const directory = encodeURIComponent(`/cloud-agent/sessions/${qualifiedKiloSessionId}`);
  return SELF.fetch(
    `http://worker.test/kilo-test/kilo/event?userId=${userId}&directory=${directory}`
  ).then(response => {
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    return response;
  });
}

/** Reads one attach: every pre-fence snapshot event plus the fence itself. */
async function readAttach(response: Response): Promise<{
  events: unknown[];
  fence: { fence?: number; snapshotComplete?: boolean };
  reader: ReturnType<typeof createSseDataReader>;
}> {
  const reader = createSseDataReader(response);
  await expect(reader.next()).resolves.toMatchObject({ type: 'server.connected' });
  const events: unknown[] = [];
  let fence: { fence?: number; snapshotComplete?: boolean } = {};
  for (;;) {
    const frame = await reader.next();
    if (isFrame(frame, 'kilo.native.fence')) {
      fence = frame.properties as { fence?: number; snapshotComplete?: boolean };
      return { events, fence, reader };
    }
    if (isFrame(frame, 'kilo.native.resnapshot')) {
      throw new Error(`unexpected resnapshot during snapshot read: ${JSON.stringify(frame)}`);
    }
    events.push(frame);
  }
}

function isFrame(value: unknown, type: string): value is { type: string; properties: unknown } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === type;
}

function isPartUpdate(value: unknown, partId: string): boolean {
  return (
    isFrame(value, 'message.part.updated') &&
    (value.properties as { part?: { id?: string } }).part?.id === partId
  );
}

function expectSingleLivePartUpdate(events: readonly unknown[], partId: string): void {
  expect(events.filter(event => isPartUpdate(event, partId))).toHaveLength(1);
}

/**
 * The logical transcript the frames describe. A snapshot intentionally carries a
 * materialized row both as its immutable log entry and again in the replay
 * phase, so frames are keyed by entity identity with last-write-wins, exactly the
 * reconciliation an SDK client performs.
 */
type TranscriptState = {
  messages: Map<string, unknown>;
  parts: Map<string, unknown>;
  interactions: Map<string, unknown>;
};

function transcriptState(events: readonly unknown[]): TranscriptState {
  const state: TranscriptState = {
    messages: new Map(),
    parts: new Map(),
    interactions: new Map(),
  };
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const frame = event as { type?: unknown; properties?: Record<string, unknown> };
    if (typeof frame.type !== 'string' || frame.properties === undefined) continue;
    const properties = frame.properties;
    if (frame.type === 'message.updated') {
      const id = (properties.info as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string') state.messages.set(id, event);
    } else if (frame.type === 'message.part.updated') {
      const part = properties.part as { id?: unknown; messageID?: unknown } | undefined;
      if (typeof part?.id === 'string' && typeof part.messageID === 'string') {
        state.parts.set(`${part.messageID}/${part.id}`, event);
      }
    } else if (frame.type === 'question.asked' || frame.type === 'permission.asked') {
      if (typeof properties.id === 'string') {
        state.interactions.set(`${frame.type}:${properties.id}`, event);
      }
    }
  }
  return state;
}

function stableState(state: TranscriptState): Record<string, unknown> {
  const entries = (values: Map<string, unknown>) =>
    Object.fromEntries([...values].sort(([left], [right]) => left.localeCompare(right)));
  return {
    messages: entries(state.messages),
    parts: entries(state.parts),
    interactions: entries(state.interactions),
  };
}

/** Every entity an earlier snapshot delivered must still be present, unchanged. */
function expectContainsState(earlier: TranscriptState, later: TranscriptState): void {
  for (const [id, event] of earlier.messages) expect(later.messages.get(id)).toEqual(event);
  for (const [id, event] of earlier.parts) expect(later.parts.get(id)).toEqual(event);
  for (const [id, event] of earlier.interactions) expect(later.interactions.get(id)).toEqual(event);
}

function messageUpdated(
  messageId: string,
  role: 'user' | 'assistant',
  text: string
): ControlPlaneEvent {
  return {
    type: 'message.updated',
    properties: {
      sessionID: qualifiedKiloSessionId,
      info: {
        id: messageId,
        sessionID: qualifiedKiloSessionId,
        role,
        time: { created: Date.now() },
      },
      text,
    },
  };
}

function partUpdated(messageId: string, partId: string, text: string): ControlPlaneEvent {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: qualifiedKiloSessionId,
      part: {
        id: partId,
        messageID: messageId,
        sessionID: qualifiedKiloSessionId,
        type: 'text',
        text,
      },
    },
  };
}

function questionAsked(id: string): ControlPlaneEvent {
  return {
    type: 'question.asked',
    properties: {
      id,
      sessionID: qualifiedKiloSessionId,
      questions: [{ question: 'Proceed?', options: [] }],
    },
  };
}

function permissionAsked(id: string): ControlPlaneEvent {
  return {
    type: 'permission.asked',
    properties: {
      id,
      sessionID: qualifiedKiloSessionId,
      permission: 'bash',
      patterns: ['*'],
    },
  };
}

async function pushEvents(
  session: ActiveSession,
  events: readonly ControlPlaneEvent[]
): Promise<void> {
  session.wrapper.sendSessionEvents(cloudAgentSessionId, [...events]);
}

afterEach(async () => {
  await clearFacadeRoots().catch(() => undefined);
  await reset();
});

describe('hosted native history/live fence', { timeout: 30_000 }, () => {
  it('rejects duplicate live updates even when decoded frames have different identities', () => {
    const update = partUpdated('msg_live', 'prt_live', 'live text');
    expectSingleLivePartUpdate([update], 'prt_live');
    expect(() =>
      expectSingleLivePartUpdate([update, structuredClone(update)], 'prt_live')
    ).toThrow();
  });

  it('delivers the durable snapshot first, then the fence, then live events above it', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'native fence',
      });

      const userMessageId = 'msg_user_native_1';
      const assistantMessageId = 'msg_assistant_native_1';
      await pushEvents(session, [
        messageUpdated(userMessageId, 'user', 'hello'),
        messageUpdated(assistantMessageId, 'assistant', ''),
        partUpdated(assistantMessageId, 'prt_native_1', 'hello back'),
      ]);
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(snapshot.events.length).toBeGreaterThanOrEqual(3);
      });

      const { events, fence, reader } = await readAttach(await attach());
      try {
        expect(fence.snapshotComplete).toBe(true);
        expect(typeof fence.fence).toBe('number');
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'message.updated' }),
            expect.objectContaining({ type: 'message.part.updated' }),
          ])
        );
        // No transcript content may arrive before the fence: the snapshot is
        // complete through it and the client must not render a partial history.
        expect(fence.fence as number).toBeGreaterThan(0);

        // Drain through a subsequent marker so duplicate updates after the
        // first matching frame are included in the exact-once assertion.
        await pushEvents(session, [
          partUpdated(assistantMessageId, 'prt_native_2', 'second part'),
          partUpdated(assistantMessageId, 'prt_native_marker', 'delivery marker'),
        ]);
        const live = await readSseUntil(reader, frame => isPartUpdate(frame, 'prt_native_marker'));
        expectSingleLivePartUpdate(live.observed, 'prt_native_2');
      } finally {
        await reader.cancel();
      }
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  it('replays the same durable transcript on reconnect with no missing or duplicate parts', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'native reconnect',
      });
      const assistantMessageId = 'msg_assistant_native_reconnect';
      await pushEvents(session, [
        messageUpdated('msg_user_native_reconnect', 'user', 'hello'),
        messageUpdated(assistantMessageId, 'assistant', ''),
        partUpdated(assistantMessageId, 'prt_reconnect_1', 'one'),
        partUpdated(assistantMessageId, 'prt_reconnect_2', 'two'),
        questionAsked('que_native_reconnect'),
        permissionAsked('per_native_reconnect'),
      ]);
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(snapshot.events.length).toBeGreaterThanOrEqual(6);
        expect(snapshot.questions).toHaveLength(1);
        expect(snapshot.permissions).toHaveLength(1);
      });

      const first = await readAttach(await attach());
      await first.reader.cancel();
      const second = await readAttach(await attach());
      await second.reader.cancel();

      // A reconnect must rebuild exactly the same state: same fingerprints in
      // the same order, so nothing is dropped and nothing is duplicated.
      expect(stableState(transcriptState(second.events))).toEqual(
        stableState(transcriptState(first.events))
      );
      expect(second.fence).toEqual(first.fence);
      expect(first.events.some(event => isFrame(event, 'question.asked'))).toBe(true);
      expect(first.events.some(event => isFrame(event, 'permission.asked'))).toBe(true);

      const parts = transcriptState(first.events).parts;
      expect([...parts.keys()]).toEqual(
        expect.arrayContaining([
          `${assistantMessageId}/prt_reconnect_1`,
          `${assistantMessageId}/prt_reconnect_2`,
        ])
      );
      expect([...transcriptState(first.events).interactions.keys()].sort()).toEqual([
        'permission.asked:per_native_reconnect',
        'question.asked:que_native_reconnect',
      ]);
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  it('reports a resnapshot when continuity cannot be proven, then rebuilds the full state', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'native resnapshot',
      });
      const assistantMessageId = 'msg_assistant_native_resnapshot';
      await pushEvents(session, [
        messageUpdated('msg_user_native_resnapshot', 'user', 'hello'),
        messageUpdated(assistantMessageId, 'assistant', ''),
        partUpdated(assistantMessageId, 'prt_resnapshot_1', 'durable text'),
        questionAsked('que_native_resnapshot'),
      ]);
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(snapshot.events.length).toBeGreaterThanOrEqual(4);
      });

      const attached = await readAttach(await attach());
      const durable = attached.events;

      // The root mapping changes underneath a live attachment. The facade can no
      // longer prove the push belongs to this hosted session, so it must tell
      // the client to resnapshot instead of appending a possibly-wrong event.
      const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
      await runInDurableObject(facade, async (_instance, state) => {
        await writeTestSessionIngestState(state.storage, {
          roots: [
            {
              kiloSessionId: qualifiedKiloSessionId,
              cloudAgentSessionId: `workspace_${'20000000-0000-4000-8000-000000000002'}`,
            },
          ],
        });
      });
      await pushEvents(session, [
        partUpdated(assistantMessageId, 'prt_resnapshot_2', 'after move'),
      ]);

      const noticed = await readSseUntil(attached.reader, frame =>
        isFrame(frame, 'kilo.native.resnapshot')
      );
      const notice = noticed.match as { properties: { sessionID?: string; reason?: string } };
      expect(notice.properties.sessionID).toBe(qualifiedKiloSessionId);

      // Restore the mapping and re-attach: the rebuilt snapshot is the durable
      // log, unchanged by the continuity failure, and still carries the pending
      // question. Nothing is lost and nothing is duplicated.
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'native resnapshot',
      });
      const rebuilt = await readAttach(await attach());
      await rebuilt.reader.cancel();
      expectContainsState(transcriptState(durable), transcriptState(rebuilt.events));
      expect(rebuilt.events.some(event => isFrame(event, 'question.asked'))).toBe(true);
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });
});
