/**
 * A v2 page that settles after the socket connected starts the background
 * reader, driven end to end: the real `createCloudAgentTransport` opens a real
 * `SandboxSessionV2` Durable Object's `/stream` socket, reads a real history
 * page from that DO, and its background read reaches the wrapper through the
 * Session DO and the Sandbox DO exactly as it does in production.
 *
 * The page is the only v2 evidence this connection ever gets. The seed rows are
 * written into the DO without a broadcast, so no `conversation.*` frame reaches
 * the socket, and the page seed is the one place that can learn the session is
 * v2. A page that lands after the connect hooks ran therefore has to start the
 * readers itself: before the fix it only enabled them, so a session whose
 * initial read failed never polled the inventory at all.
 */
import { env, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerUsageRpcMethods } from '@kilocode/container-usage';
import { createCloudAgentTransport } from '../../../../packages/cloud-agent-sdk/src/cloud-agent-transport.js';
import type { ServiceEvent } from '../../../../packages/cloud-agent-sdk/src/normalizer.js';
import type {
  CloudAgentSessionId,
  KiloSessionId,
  SessionSnapshotPage,
} from '../../../../packages/cloud-agent-sdk/src/types.js';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { createSessionEventQueries } from '../../src/control-plane/session/event-queries.js';
import { persistSessionEvent } from '../../src/control-plane/session/native-events.js';
import { createPartTextBuffer } from '../../src/control-plane/session/part-text-buffer.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import { createMessageId } from '../../src/session/message-id.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
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

const USER_ID = 'user_background_reader';
const ORG_ID = 'org_background_reader';
const KILO_TOKEN = FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN;

// `containedKiloSessionIdSchema` requires exactly 26 alphanumerics after the prefix.
const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
const cloudAgentSessionId = `workspace_${crypto.randomUUID()}`;

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
      branchName: 'kilo/background-reader',
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

/**
 * The inventory the live wrapper answers a `session.background` read with: the
 * session itself, no jobs and no waits, which is the shape the SDK's schema and
 * the read binding both accept.
 */
function backgroundInventory() {
  return { sessionID: kiloSessionId, jobs: [], sessions: [{ id: kiloSessionId }], waits: [] };
}

type LiveSession = {
  stub: DurableObjectStub<SandboxSessionV2>;
  wrapper: FakeWrapper;
  stopPump: () => void;
  backgroundReads: () => number;
};

/**
 * A hosted session whose runtime is live: the Session DO route is ready and a
 * wrapper socket is bound, so a background read reaches the wrapper and comes
 * back through the Session DO and Sandbox DO exactly as it does in production.
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
    wrapperId: 'wr_background_reader',
    allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID,
  });
  expect(welcome).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });

  let reads = 0;
  const stopPump = startWrapperPump(wrapper);
  wrapper.onFrame(frame => {
    // Only the one native read is answered: a stray read of another operation
    // must fail the transport instead of standing in for the one asserted here.
    if (frame.type !== 'kilo.request' || frame.operation.name !== 'session.background') return;
    reads += 1;
    wrapper.send({
      type: 'kilo.result',
      requestId: frame.requestId,
      ok: true,
      result: backgroundInventory(),
    });
  });

  await waitFor(async () => {
    const session = await runInDurableObject(stub, instance => instance.getSession());
    expect(session.type === 'found' ? session.route.state : null).toBe('ready');
  });

  return {
    stub,
    wrapper,
    stopPump,
    backgroundReads: () => reads,
  };
}

function nativeSource() {
  return {
    version: 'v2' as const,
    session: {
      id: kiloSessionId,
      location: { directory: `/workspace/${cloudAgentSessionId}` },
      time: { created: 1, updated: 2 },
    },
  };
}

/**
 * Store native v2 history in the DO without a broadcast. The rows are the real
 * persisted conversation rows the history page reads, but nothing is sent to
 * the session's `/stream` sockets: this connection's only v2 evidence has to be
 * the page its own retried read settles with.
 */
function seedNativeHistory(stub: DurableObjectStub<SandboxSessionV2>): Promise<void> {
  const source = nativeSource();
  const events = [
    { type: 'conversation.source', properties: { sessionID: kiloSessionId, source } },
    {
      type: 'conversation.message.updated',
      properties: {
        sessionID: kiloSessionId,
        source,
        message: { id: 'msg_reader_user', type: 'user', time: { created: 1 }, text: 'seeded' },
      },
    },
    {
      type: 'conversation.message.updated',
      properties: {
        sessionID: kiloSessionId,
        source,
        message: {
          id: 'msg_reader_reply',
          type: 'assistant',
          time: { created: 2, completed: 3 },
          content: [{ type: 'text', text: 'answered' }],
        },
        parentID: 'msg_reader_user',
      },
    },
  ];
  return runInDurableObject(stub, (_instance, state) => {
    const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
    const partText = createPartTextBuffer({
      queries,
      onFlushError: error => {
        throw error;
      },
    });
    for (const event of events) {
      const stored = persistSessionEvent({
        sessionId: cloudAgentSessionId,
        event,
        queries,
        partText,
      });
      if (stored === null) throw new Error(`The native ${event.type} seed was refused`);
    }
  });
}

type ShimSocket = {
  url: string;
  messageCount: number;
  closed: boolean;
};

/**
 * The transport builds its socket from the global `WebSocket` and speaks the
 * browser property API (`onopen`/`onmessage`/`onclose`). The workers pool has
 * no client transport back to the test Worker, so this shim forwards each
 * socket to the session's real `/stream` route through `SELF.fetch` and adapts
 * the upgraded half back to that property API. Only the ticket is dropped: the
 * test worker route does not read it.
 */
function installSocketShim(options: { sessionId: string }) {
  const sockets: ShimSocket[] = [];
  const real = globalThis.WebSocket;

  class ShimWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readyState = 0;
    readonly url: string;
    readonly record: ShimSocket;
    private wire: { close: () => void; accept: () => void } | null = null;
    private closed = false;

    constructor(url: string | URL) {
      this.url = String(url);
      this.record = { url: this.url, messageCount: 0, closed: false };
      sockets.push(this.record);
      void this.open();
    }

    private async open(): Promise<void> {
      const requested = new URL(this.url);
      const target = new URL('http://worker.test/stream');
      target.searchParams.set('sessionId', options.sessionId);
      target.searchParams.set('userId', USER_ID);
      for (const [key, value] of requested.searchParams)
        if (key !== 'ticket') target.searchParams.append(key, value);
      try {
        const response = await SELF.fetch(target.toString(), {
          headers: { Upgrade: 'websocket' },
        });
        if (response.status !== 101 || !response.webSocket)
          throw new Error(`Unexpected stream upgrade: ${response.status}`);
        const wire = response.webSocket;
        if (this.closed) {
          wire.accept();
          wire.close();
          return;
        }
        wire.addEventListener('message', event => {
          this.record.messageCount += 1;
          this.onmessage?.({ data: event.data } as MessageEvent);
        });
        wire.accept();
        this.wire = wire;
        this.readyState = ShimWebSocket.OPEN;
        this.onopen?.(new Event('open'));
      } catch (error) {
        // A socket that never opened must surface as an unexpected close, so a
        // broken route fails the wait instead of hanging the transport.
        this.record.closed = true;
        this.closed = true;
        this.onerror?.({ error } as unknown as Event);
        this.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
      }
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.readyState = ShimWebSocket.CLOSED;
      this.record.closed = true;
      this.wire?.close();
      this.wire = null;
    }
  }

  Object.assign(globalThis, { WebSocket: ShimWebSocket });
  if (globalThis.WebSocket !== (ShimWebSocket as unknown)) {
    Object.assign(globalThis, { WebSocket: real });
    throw new Error('The test runtime did not accept the WebSocket shim');
  }
  return {
    sockets,
    restore(): void {
      Object.assign(globalThis, { WebSocket: real });
    },
  };
}

afterEach(async () => {
  await reset();
});

describe(
  'cloud agent transport background reader on the real session DO',
  { timeout: 30_000 },
  () => {
    it('starts the background reader for a v2 page that lands after the socket connected', async () => {
      const live = await openLiveSession();
      const shim = installSocketShim({ sessionId: cloudAgentSessionId });

      // Reads fail until the gate opens, which is strictly after the socket has
      // replayed. The retry therefore carries the page long after `onConnected`
      // ran, which is the only window in which the readers used to be enabled
      // without being started.
      const { promise: pageGate, resolve: openPageGate } = Promise.withResolvers<void>();
      let pageReads = 0;

      const pages: SessionSnapshotPage[] = [];
      const serviceEvents: ServiceEvent[] = [];
      const errors: string[] = [];
      let replayCompletions = 0;

      const transport = createCloudAgentTransport({
        sessionId: cloudAgentSessionId as CloudAgentSessionId,
        kiloSessionId: kiloSessionId as KiloSessionId,
        api: {
          getBackgroundActivity: async () => {
            const result = await live.stub.kiloRequest({ name: 'session.background' });
            if (!result.ok) throw new Error(result.error.message);
            return result.result;
          },
          send: () => Promise.resolve('sent'),
          interrupt: () => Promise.resolve('interrupted'),
          answer: () => Promise.resolve('answered'),
          reject: () => Promise.resolve('rejected'),
          respondToPermission: () => Promise.resolve('responded'),
        },
        getTicket: () => 'background-reader-ticket',
        fetchCloudSnapshotPage: async () => {
          pageReads += 1;
          if (pageReads === 1) throw new Error('history read failed');
          await pageGate;
          const page = await live.stub.getSessionMessagesPage();
          if (page === null) throw new Error('Session not found');
          return page;
        },
        onInitialPageLoaded: page => pages.push(page),
        websocketBaseUrl: 'ws://worker.test',
        onError: message => errors.push(message),
      })({
        onChatEvent: () => undefined,
        onServiceEvent: event => serviceEvents.push(event),
        onReplayComplete: () => {
          replayCompletions += 1;
        },
      });

      try {
        transport.connect();

        // The initial read failed, so this connection opened its socket without a
        // page. No page has settled and no `conversation.*` frame ever crossed the
        // socket, so nothing may have read the inventory yet.
        await waitFor(() => expect(shim.sockets).toHaveLength(1));
        await waitFor(() => expect(replayCompletions).toBe(1));
        expect(pages).toHaveLength(0);
        expect(live.backgroundReads()).toBe(0);
        expect(errors).toEqual(['history read failed']);

        // The retried read now settles with a real v2 page from the DO.
        await seedNativeHistory(live.stub);
        openPageGate();

        await waitFor(() => expect(pages).toHaveLength(1));
        expect(pages[0].sourceVersion).toBe('v2');

        // The page alone started the reader: exactly one native read reached the
        // wrapper, and the inventory it answered with is current. Both numbers are
        // asserted exactly, so a failing run reports what it observed instead of
        // only that it cleared a bound.
        await waitFor(() =>
          expect({
            backgroundReads: live.backgroundReads(),
            currentPublishes: serviceEvents.filter(
              event => event.type === 'background.activity' && event.state.status === 'current'
            ).length,
          }).toEqual({ backgroundReads: 1, currentPublishes: 1 })
        );
        expect(serviceEvents).toContainEqual(
          expect.objectContaining({
            type: 'background.activity',
            state: expect.objectContaining({ status: 'current' }),
          })
        );
        expect(live.wrapper.unparsedFrames()).toEqual([]);
      } finally {
        transport.destroy();
        shim.restore();
        live.stopPump();
        live.wrapper.close();
      }
    });
  }
);
