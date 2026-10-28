import { SELF, env, evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
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
  message: ControlPlanePromptPayload;
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

  return { sandboxId, stub, wrapper, stopPump, message };
}

async function startPreparationFailureSession(): Promise<ActiveSession> {
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
    turn: { type: 'prompt', prompt: 'failed preparation fixture' },
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
  await wrapper.hello({
    wrapperId: 'wr_native_fence_failure',
    allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID,
  });
  expect(await wrapper.next()).toMatchObject({
    type: 'session.prepare',
    spec: { sessionId: cloudAgentSessionId },
  });
  wrapper.send({
    type: 'session.failed',
    sessionId: cloudAgentSessionId,
    reason: 'workspace_setup_failed',
  });
  await waitFor(async () => expect(await messageStatus(stub, message.messageId)).toBe('failed'));

  return { sandboxId, stub, wrapper, stopPump: () => undefined, message };
}

async function durableSnapshot(stub: DurableObjectStub<SandboxSessionV2>) {
  return runInDurableObject(stub, instance => instance.nativeSnapshot({}));
}

async function messageStatus(
  stub: DurableObjectStub<SandboxSessionV2>,
  messageId: string
): Promise<string | null> {
  const result = await stub.getMessageResult(messageId);
  return result.type === 'found' ? result.result.status : null;
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

function partDelta(messageId: string, partId: string, delta: string): ControlPlaneEvent {
  return {
    type: 'message.part.delta',
    properties: {
      sessionID: qualifiedKiloSessionId,
      messageID: messageId,
      partID: partId,
      field: 'text',
      delta,
    },
  };
}

function isPartDelta(value: unknown): boolean {
  return isFrame(value, 'message.part.delta');
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

  it('delivers shared public failure messages live and on reconnect', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'public failure fixture',
      });
      const attached = await readAttach(await attach());
      try {
        const error = {
          name: 'APIError',
          data: {
            message: 'fixture failure',
            statusCode: 429,
            isRetryable: true,
            responseHeaders: { authorization: 'fixture-header' },
            responseBody: 'fixture-body',
            metadata: { request: 'fixture-request' },
          },
        };
        const withError = (error: unknown): ControlPlaneEvent[] => [
          {
            type: 'message.updated',
            properties: {
              sessionID: qualifiedKiloSessionId,
              info: {
                id: 'msg_failure',
                role: 'assistant',
                sessionID: qualifiedKiloSessionId,
                error,
              },
            },
          },
          {
            type: 'message.part.updated',
            properties: {
              sessionID: qualifiedKiloSessionId,
              part: {
                id: 'prt_failure',
                messageID: 'msg_failure',
                sessionID: qualifiedKiloSessionId,
                type: 'retry',
                attempt: 2,
                time: { created: 1 },
                error,
              },
            },
          },
          {
            type: 'session.error',
            properties: { sessionID: qualifiedKiloSessionId, error },
          },
        ];
        await pushEvents(session, [
          ...withError(error),
          partUpdated('msg_failure', 'prt_failure_marker', 'delivery marker'),
        ]);
        const live = await readSseUntil(attached.reader, frame =>
          isPartUpdate(frame, 'prt_failure_marker')
        );
        const replay = await readAttach(await attach());
        await replay.reader.cancel();
        const expected = withError('Assistant request was rate limited').map(event => ({
          ...event,
          properties: expect.objectContaining(event.properties),
        }));
        expect(live.observed).toEqual(expect.arrayContaining(expected));
        expect(replay.events).toEqual(expect.arrayContaining(expected));
        for (const events of [live.observed, replay.events]) {
          const serialized = JSON.stringify(events);
          expect(serialized).not.toContain('fixture-header');
          expect(serialized).not.toContain('fixture-body');
          expect(serialized).not.toContain('fixture-request');
        }
      } finally {
        await attached.reader.cancel();
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

  it('publishes Cloud terminal events live and replays them from stored rows without payload type metadata', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'cloud terminal fixture',
      });
      const attached = await readAttach(await attach());
      try {
        session.wrapper.send({
          type: 'session.outcome',
          sessionId: cloudAgentSessionId,
          status: 'completed',
          lastMessageId: session.message.messageId,
        });
        const live = await readSseUntil(attached.reader, frame =>
          isFrame(frame, 'cloud.message.completed')
        );
        const terminal = live.match as { properties: Record<string, unknown> };
        expect(terminal.properties).toMatchObject({
          sessionID: qualifiedKiloSessionId,
          messageId: session.message.messageId,
          status: 'completed',
          delivery: 'sent',
          accepted: true,
        });
        expect(
          live.observed.filter(frame => isFrame(frame, 'cloud.message.completed'))
        ).toHaveLength(1);

        await waitFor(async () =>
          expect(await messageStatus(session.stub, session.message.messageId)).toBe('completed')
        );
        const replay = await readAttach(await attach());
        await replay.reader.cancel();
        const replayed = replay.events.filter(frame => isFrame(frame, 'cloud.message.completed'));
        expect(replayed).toHaveLength(1);
        expect(replayed[0]).toMatchObject({
          properties: {
            sessionID: qualifiedKiloSessionId,
            messageId: session.message.messageId,
            status: 'completed',
            delivery: 'sent',
            accepted: true,
          },
        });
      } finally {
        await attached.reader.cancel();
      }
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  it('replays a stale busy status as authoritative idle before a newer live busy state', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'stale status fixture',
      });
      await pushEvents(session, [
        {
          type: 'session.status',
          properties: { sessionID: qualifiedKiloSessionId, status: { type: 'busy' } },
        },
      ]);
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(
          snapshot.events.some(
            event =>
              event.streamEventType === 'kilocode' &&
              (event.data as { type?: string }).type === 'session.status'
          )
        ).toBe(true);
      });

      session.wrapper.send({
        type: 'session.outcome',
        sessionId: cloudAgentSessionId,
        status: 'completed',
        lastMessageId: session.message.messageId,
      });
      await waitFor(async () =>
        expect((await durableSnapshot(session.stub)).sessionStatus).toEqual({ type: 'idle' })
      );

      const attached = await readAttach(await attach());
      try {
        const statuses = attached.events
          .filter(frame => isFrame(frame, 'session.status'))
          .map(frame => (frame.properties as { status?: { type?: string } }).status?.type);
        expect(statuses[0]).toBe('busy');
        expect(statuses.at(-1)).toBe('idle');

        await pushEvents(session, [
          {
            type: 'session.status',
            properties: { sessionID: qualifiedKiloSessionId, status: { type: 'busy' } },
          },
        ]);
        const live = await readSseUntil(
          attached.reader,
          frame =>
            isFrame(frame, 'session.status') &&
            (frame.properties as { status?: { type?: string } }).status?.type === 'busy'
        );
        expect(live.match).toMatchObject({
          properties: { sessionID: qualifiedKiloSessionId, status: { type: 'busy' } },
        });
      } finally {
        await attached.reader.cancel();
      }
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  it('clears replayed interactions that the authoritative snapshot no longer reports', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'interaction reconciliation fixture',
      });
      await pushEvents(session, [
        questionAsked('que_reconcile_stale'),
        permissionAsked('per_reconcile_stale'),
      ]);
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(snapshot.questions).toHaveLength(1);
        expect(snapshot.permissions).toHaveLength(1);
      });

      await expect(
        session.stub.answer({
          sessionId: cloudAgentSessionId,
          reply: { action: 'answer', questionId: 'que_reconcile_stale', answers: [['yes']] },
        })
      ).resolves.toBe('sent');
      await expect(
        session.stub.answer({
          sessionId: cloudAgentSessionId,
          reply: { action: 'permission', permissionId: 'per_reconcile_stale', response: 'once' },
        })
      ).resolves.toBe('sent');
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(snapshot.questions).toHaveLength(0);
        expect(snapshot.permissions).toHaveLength(0);
      });

      const attached = await readAttach(await attach());
      await attached.reader.cancel();
      const types = attached.events.map(frame => (frame as { type?: string }).type);
      expect(types).toContain('question.asked');
      expect(types).toContain('permission.asked');
      expect(attached.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'question.rejected',
            properties: expect.objectContaining({ requestID: 'que_reconcile_stale' }),
          }),
          expect.objectContaining({
            type: 'permission.replied',
            properties: expect.objectContaining({ requestID: 'per_reconcile_stale' }),
          }),
        ])
      );
      expect(types.at(-1)).toBe('permission.replied');
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  it('replays a completed tool part whose materialized row predates later events', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'materialized tool fixture',
      });
      const assistantMessageId = 'msg_tool_replay';
      await pushEvents(session, [
        messageUpdated('msg_user_tool_replay', 'user', 'run a command'),
        messageUpdated(assistantMessageId, 'assistant', ''),
        {
          type: 'message.part.updated',
          properties: {
            sessionID: qualifiedKiloSessionId,
            part: {
              id: 'prt_tool_replay',
              messageID: assistantMessageId,
              sessionID: qualifiedKiloSessionId,
              type: 'tool',
              tool: 'bash',
              state: { status: 'completed', input: { command: 'echo done' }, output: 'done' },
            },
          },
        },
      ]);
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(
          snapshot.events.some(
            event =>
              event.streamEventType === 'kilocode' &&
              (event.data as { type?: string }).type === 'message.part.updated'
          )
        ).toBe(true);
      });
      await pushEvents(session, [
        partUpdated(assistantMessageId, 'prt_later_replay', 'later event'),
      ]);

      const attached = await readAttach(await attach());
      await attached.reader.cancel();
      const tool = attached.events.find(
        event =>
          isFrame(event, 'message.part.updated') &&
          (event.properties as { part?: { id?: string } }).part?.id === 'prt_tool_replay'
      ) as { properties: { part: { state: { status: string } } } } | undefined;
      expect(tool?.properties.part.state.status).toBe('completed');
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  it('replays sanitized preparation failure evidence through the system feed after reconnect', async () => {
    const session = await startPreparationFailureSession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'failed preparation fixture',
      });
      const directory = encodeURIComponent(`/cloud-agent/sessions/${qualifiedKiloSessionId}`);
      const response = await SELF.fetch(
        `http://worker.test/kilo-test/kilo/cloud-agent/event?userId=${userId}&directory=${directory}`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = createSseDataReader(response);
      const observed: unknown[] = [];
      let attemptReplay: Record<string, unknown> | undefined;
      let stepReplay: Record<string, unknown> | undefined;
      let cloudStatusFrame: unknown;
      for (let index = 0; index < 64; index++) {
        const frame = await reader.next();
        observed.push(frame);
        if (isFrame(frame, 'cloud.status')) cloudStatusFrame = frame;
        const preparation =
          isFrame(frame, 'preparing') &&
          (frame.properties as { preparation?: Record<string, unknown> }).preparation;
        if (
          preparation?.action === 'attempt_snapshot' &&
          (preparation.attempt as { status?: string } | undefined)?.status === 'failed'
        ) {
          attemptReplay = preparation;
        }
        if (
          preparation?.action === 'step_snapshot' &&
          (preparation.stepSnapshot as { status?: string } | undefined)?.status === 'failed'
        ) {
          stepReplay = preparation;
        }
        if (
          attemptReplay !== undefined &&
          stepReplay !== undefined &&
          cloudStatusFrame !== undefined
        ) {
          break;
        }
      }
      await reader.cancel();
      expect(attemptReplay).toBeDefined();
      expect(stepReplay).toBeDefined();

      expect(attemptReplay).toMatchObject({
        attemptId: expect.any(String),
        triggerMessageId: session.message.messageId,
        revision: expect.any(Number),
        timestamp: expect.any(Number),
        attempt: {
          id: attemptReplay?.attemptId,
          status: 'failed',
          triggerMessageId: session.message.messageId,
          safeError: 'workspace_setup_failed',
        },
      });
      expect(stepReplay).toMatchObject({
        attemptId: attemptReplay?.attemptId,
        triggerMessageId: session.message.messageId,
        revision: expect.any(Number),
        timestamp: expect.any(Number),
        stepSnapshot: {
          status: 'failed',
          safeError: 'workspace_setup_failed',
        },
      });

      expect(cloudStatusFrame).toBeDefined();
      expect((cloudStatusFrame as { properties: unknown }).properties).toMatchObject({
        sessionID: qualifiedKiloSessionId,
        cloudStatus: { type: 'error' },
      });
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
      // The post-move content must never be delivered on the stale attachment.
      expect(notice.properties.reason).toBe('continuity_unproven');
      expect(JSON.stringify(noticed.observed)).not.toContain('after move');

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

  it('reports continuity_unproven and closes when the session stream socket closes', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'native socket close',
      });
      await pushEvents(session, [messageUpdated('msg_user_socket', 'user', 'hello')]);
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(snapshot.events.length).toBeGreaterThanOrEqual(1);
      });

      const attached = await readAttach(await attach());
      try {
        await runInDurableObject(session.stub, (_instance, state) => {
          for (const socket of state.getWebSockets('stream')) socket.close(1011, 'test close');
        });
        const noticed = await readSseUntil(attached.reader, frame =>
          isFrame(frame, 'kilo.native.resnapshot')
        );
        const notice = noticed.match as { properties: { sessionID?: string; reason?: string } };
        expect(notice.properties.sessionID).toBe(qualifiedKiloSessionId);
        expect(notice.properties.reason).toBe('continuity_unproven');
        await expect(attached.reader.nextOptional()).resolves.toBeNull();
      } finally {
        await attached.reader.cancel().catch(() => undefined);
      }
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  // Miniflare cannot hibernate a DO-to-DO `/stream` socket here. Awaiting
  // `evictDurableObject` on the warm session DO wedges the test isolate (later
  // timers and socket sends never complete), and not awaiting it turns the
  // eviction window into a race that sometimes drops the post-eviction frames.
  // The assertion is kept intact for a harness that can multiplex DO-to-DO
  // sockets; it is not replaced with a forced-close case.
  it.skip('keeps the same SSE open across a hibernating session eviction', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'native eviction hibernate',
      });
      const assistantMessageId = 'msg_assistant_evict';
      await pushEvents(session, [
        messageUpdated('msg_user_evict', 'user', 'hello'),
        messageUpdated(assistantMessageId, 'assistant', ''),
      ]);
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(snapshot.events.length).toBeGreaterThanOrEqual(2);
      });

      const attached = await readAttach(await attach());
      try {
        await evictDurableObject(session.stub, { webSockets: 'hibernate' });
        await pushEvents(session, [
          partUpdated(assistantMessageId, 'prt_evict_persisted', 'persisted after eviction'),
          partDelta(assistantMessageId, 'prt_evict_persisted', 'live delta'),
        ]);
        const delta = await readSseUntil(attached.reader, isPartDelta);
        const observed = JSON.stringify(delta.observed);
        expect(observed).toContain('persisted after eviction');
        expect(observed).not.toContain('kilo.native.resnapshot');

        // A later event on the same reader proves the response never closed.
        await pushEvents(session, [
          partUpdated(assistantMessageId, 'prt_evict_marker', 'still open'),
        ]);
        const marker = await readSseUntil(attached.reader, frame =>
          isPartUpdate(frame, 'prt_evict_marker')
        );
        expect(JSON.stringify(marker.observed)).not.toContain('kilo.native.resnapshot');
      } finally {
        await attached.reader.cancel().catch(() => undefined);
      }
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  // Same harness limitation as the hibernating case above: the eviction cannot
  // complete deterministically while `/event` is open, so this close-path
  // assertion cannot run in Miniflare either.
  it.skip('reports continuity_unproven and closes when the session eviction closes the socket', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots({
        kiloSessionId: qualifiedKiloSessionId,
        cloudAgentSessionId,
        title: 'native eviction close',
      });
      await pushEvents(session, [messageUpdated('msg_user_close', 'user', 'hello')]);
      await waitFor(async () => {
        const snapshot = await durableSnapshot(session.stub);
        expect(snapshot.events.length).toBeGreaterThanOrEqual(1);
      });

      const attached = await readAttach(await attach());
      try {
        await evictDurableObject(session.stub, { webSockets: 'close' });
        const noticed = await readSseUntil(attached.reader, frame =>
          isFrame(frame, 'kilo.native.resnapshot')
        );
        const notice = noticed.match as { properties: { sessionID?: string; reason?: string } };
        expect(notice.properties.sessionID).toBe(qualifiedKiloSessionId);
        expect(notice.properties.reason).toBe('continuity_unproven');
        await expect(attached.reader.nextOptional()).resolves.toBeNull();
      } finally {
        await attached.reader.cancel().catch(() => undefined);
      }
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });
});
