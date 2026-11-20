/**
 * Snapshot catch-up settlement, driven end to end: the real
 * `createCloudAgentTransport` reads real history pages from a real
 * `SandboxSessionV2` Durable Object and talks to that session's real `/stream`
 * socket.
 *
 * The path under test is `settleCatchUpRead`'s supersede branch: a catch-up
 * read that a newer reconnect made stale must still record its page — the
 * connection's only seed of metadata, cursor and queued turns — while
 * replaying none of its message rows. A record-only retry chain's timer read is
 * the case the timer path used to drop.
 */
import { env, reset, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudAgentTransport } from '../../../../packages/cloud-agent-sdk/src/cloud-agent-transport.js';
import type {
  ChatEvent,
  ServiceEvent,
} from '../../../../packages/cloud-agent-sdk/src/normalizer.js';
import type {
  CloudAgentSessionId,
  KiloSessionId,
  SessionSnapshotPage,
} from '../../../../packages/cloud-agent-sdk/src/types.js';
import type { SessionMessagesPage } from '../../src/control-plane/session/history.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { sessionDoName } from '../../src/session-identity.js';
import { seedRegistration } from './helpers/seed-registration.js';
import { waitFor } from './wait-for.js';

const USER_ID = 'settlement-user';
const SOURCE_DIRECTORY = '/workspace/settlement';

// The suite's binding holds the control-plane V2 class under the production name.
const sessions = (env as unknown as { SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2> })
  .SANDBOX_SESSION;

/** A workspace session whose DO registration is real, with no runtime attached. */
async function fixture() {
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
  const stub = sessions.getByName(sessionDoName(USER_ID, sessionId));
  await stub.registerSessionFromMetadata({
    metadata: parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId, userId: USER_ID, createdOnPlatform: 'cloud-agent-web' },
      auth: { kiloSessionId, kilocodeToken: 'settlement-token' },
      agent: { mode: 'code', model: 'test/model' },
      workspace: { sandboxId, branchName: 'kilo/settlement' },
      lifecycle: { version: 1, timestamp: 1 },
    }),
    sandboxSelection: { provider: 'cloudflare' },
  });
  await seedRegistration(stub, {
    sandboxId,
    spec: {
      sessionId,
      kiloSessionId,
      directory: `/workspace/${sessionId}`,
      attemptId: `${sessionId}-requested`,
    },
    credentials: {
      userId: USER_ID,
      kiloSessionId,
      kiloToken: 'settlement-token',
      scopeId: sessionId,
    },
  });
  return { stub, sessionId, kiloSessionId };
}

function nativeSource(kiloSessionId: string) {
  return {
    version: 'v2' as const,
    session: {
      id: kiloSessionId,
      location: { directory: SOURCE_DIRECTORY },
      time: { created: 1, updated: 2 },
    },
  };
}

async function publish(
  stub: DurableObjectStub<SandboxSessionV2>,
  type: string,
  properties: Record<string, unknown>
) {
  await stub.onEvents({ events: [{ type, properties }] });
}

/** Store native v2 history in the DO: the source row plus one user turn and its reply. */
async function seedNativeHistory(stub: DurableObjectStub<SandboxSessionV2>, kiloSessionId: string) {
  const source = nativeSource(kiloSessionId);
  const userId = 'msg_settlement_user';
  const replyId = 'msg_settlement_reply';
  await publish(stub, 'conversation.source', { sessionID: kiloSessionId, source });
  await publish(stub, 'conversation.message.updated', {
    sessionID: kiloSessionId,
    source,
    message: { id: userId, type: 'user', time: { created: 1 }, text: 'seeded prompt' },
  });
  await publish(stub, 'conversation.message.updated', {
    sessionID: kiloSessionId,
    source,
    message: {
      id: replyId,
      type: 'assistant',
      time: { created: 2, completed: 3 },
      content: [{ type: 'text', text: 'seeded answer' }],
    },
    parentID: userId,
  });
  return { userId, replyId };
}

/** Store v1 history: one message row plus its part, the shape the v1 page reader walks. */
async function seedLegacyHistory(stub: DurableObjectStub<SandboxSessionV2>, kiloSessionId: string) {
  const messageId = 'msg_legacy_user';
  const partId = 'prt_legacy_user';
  await publish(stub, 'message.updated', {
    info: {
      id: messageId,
      sessionID: kiloSessionId,
      role: 'user',
      time: { created: 1 },
      agent: 'code',
      model: { providerID: 'kilo', modelID: 'test/model' },
    },
  });
  await publish(stub, 'message.part.updated', {
    part: {
      id: partId,
      sessionID: kiloSessionId,
      messageID: messageId,
      type: 'text',
      text: 'legacy prompt',
    },
  });
  return { messageId, partId };
}

type ShimSocket = {
  url: string;
  messageCount: number;
  closed: boolean;
  /** Test-only: report an unexpected transport drop, as a lost socket does. */
  drop: () => void;
};

/**
 * The transport builds its socket from the global `WebSocket` and speaks the
 * browser property API (`onopen`/`onmessage`/`onclose`). The workers pool has
 * no client transport back to the test Worker, so this shim forwards each
 * socket to the session's real `/stream` route through `SELF.fetch` and adapts
 * the upgraded half back to that property API.
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
      this.record = {
        url: this.url,
        messageCount: 0,
        closed: false,
        drop: () => this.drop(),
      };
      sockets.push(this.record);
      void this.open();
    }

    private async open(): Promise<void> {
      const requested = new URL(this.url);
      const target = new URL('http://worker.test/stream');
      target.searchParams.set('sessionId', options.sessionId);
      target.searchParams.set('userId', USER_ID);
      // Only the filters the transport varies matter to the DO; the ticket it
      // mints is never read by this route.
      for (const key of ['afterCursor', 'fromId', 'replay', 'bootstrap'])
        for (const value of requested.searchParams.getAll(key))
          target.searchParams.append(key, value);
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

    private drop(): void {
      if (this.closed) return;
      this.closed = true;
      this.readyState = ShimWebSocket.CLOSED;
      this.record.closed = true;
      this.wire?.close();
      this.wire = null;
      this.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
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

type SnapshotFetch = (sessionId: CloudAgentSessionId) => Promise<unknown>;

function createSettlementTransport(config: {
  sessionId: string;
  kiloSessionId: string;
  fetchCloudSnapshotPage: SnapshotFetch;
  onInitialPageLoaded: (page: SessionSnapshotPage) => void;
}) {
  const chatEvents: ChatEvent[] = [];
  const serviceEvents: ServiceEvent[] = [];
  const errors: string[] = [];
  let replayCompletions = 0;
  const transport = createCloudAgentTransport({
    sessionId: config.sessionId as CloudAgentSessionId,
    kiloSessionId: config.kiloSessionId as KiloSessionId,
    api: {
      send: () => Promise.resolve('sent'),
      interrupt: () => Promise.resolve('interrupted'),
      answer: () => Promise.resolve('answered'),
      reject: () => Promise.resolve('rejected'),
      respondToPermission: () => Promise.resolve('responded'),
    },
    getTicket: () => 'settlement-ticket',
    fetchCloudSnapshotPage: config.fetchCloudSnapshotPage,
    onInitialPageLoaded: config.onInitialPageLoaded,
    websocketBaseUrl: 'ws://worker.test',
    onError: message => errors.push(message),
  })({
    onChatEvent: event => chatEvents.push(event),
    onServiceEvent: event => serviceEvents.push(event),
    onReplayComplete: () => {
      replayCompletions += 1;
    },
  });
  return {
    transport,
    chatEvents,
    serviceEvents,
    errors,
    replayCompletions: () => replayCompletions,
    sessionCreated: () => serviceEvents.filter(event => event.type === 'session.created').length,
  };
}

afterEach(async () => {
  await reset();
});

describe('cloud agent transport snapshot settlement on the real session DO', () => {
  it('seeds the first page once and delivers the live replay', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    const seeded = await seedNativeHistory(stub, kiloSessionId);
    const shim = installSocketShim({ sessionId });
    const pages: SessionSnapshotPage[] = [];
    const wirePages: SessionMessagesPage[] = [];
    const transport = createSettlementTransport({
      sessionId,
      kiloSessionId,
      fetchCloudSnapshotPage: async () => {
        const page = await stub.getSessionMessagesPage();
        if (page === null) throw new Error('Session not found');
        wirePages.push(page);
        return page;
      },
      onInitialPageLoaded: page => pages.push(page),
    });
    try {
      transport.transport.connect();

      // The first connect records its page once, then opens the socket.
      await waitFor(() => expect(pages).toHaveLength(1));
      await waitFor(() => expect(shim.sockets).toHaveLength(1));
      await waitFor(() => expect(transport.replayCompletions()).toBe(1));

      // The DO served a native page; the transport projected it, so the wire
      // `source` is gone and the version is explicit.
      expect(wirePages).toHaveLength(1);
      expect(wirePages[0].source?.version).toBe('v2');
      const page = pages[0];
      expect(page.sourceVersion).toBe('v2');
      expect('source' in page).toBe(false);
      expect(page.messages.map(message => message.info.id)).toEqual([
        seeded.userId,
        seeded.replyId,
      ]);

      // The page seeded the replay cursor before the socket was built.
      expect(page.updateCursor).toBeGreaterThan(0);
      expect(shim.sockets[0].url).toContain(`afterCursor=${page.updateCursor}`);

      // A message published now reaches the chat sink over the open socket.
      await publish(stub, 'conversation.message.updated', {
        sessionID: kiloSessionId,
        source: nativeSource(kiloSessionId),
        message: { id: 'msg_settlement_live', type: 'user', time: { created: 10 }, text: 'live' },
      });
      await waitFor(() =>
        expect(
          transport.chatEvents.some(
            event => event.type === 'message.updated' && event.info.id === 'msg_settlement_live'
          )
        ).toBe(true)
      );

      // One page seeded this connection, and only one.
      expect(pages).toHaveLength(1);
      expect(wirePages).toHaveLength(1);
      expect(transport.sessionCreated()).toBe(1);
      expect(transport.errors).toEqual([]);
    } finally {
      transport.transport.destroy();
      shim.restore();
    }
  });

  it('projects a legacy page with an explicit version and replays its rows', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    const seeded = await seedLegacyHistory(stub, kiloSessionId);
    const shim = installSocketShim({ sessionId });
    const pages: SessionSnapshotPage[] = [];
    const transport = createSettlementTransport({
      sessionId,
      kiloSessionId,
      fetchCloudSnapshotPage: async () => {
        const page = await stub.getSessionMessagesPage();
        if (page === null) throw new Error('Session not found');
        return page;
      },
      onInitialPageLoaded: page => pages.push(page),
    });
    try {
      transport.transport.connect();
      await waitFor(() => expect(pages).toHaveLength(1));
      await waitFor(() => expect(transport.replayCompletions()).toBe(1));

      // A v1 page reads back with the version spelled out and no wire `source`,
      // so the seed can tell a v1 page from a v2 one.
      const page = pages[0];
      expect(page.sourceVersion).toBe('v1');
      expect('source' in page).toBe(false);
      expect(page.messages.map(message => message.info.id)).toEqual([seeded.messageId]);
      expect(page.messages[0].parts.map(part => part.id)).toEqual([seeded.partId]);

      // The connect path replayed exactly that page.
      expect(transport.sessionCreated()).toBe(1);
      expect(transport.serviceEvents.find(event => event.type === 'session.created')).toMatchObject(
        { info: { id: kiloSessionId } }
      );
      expect(
        transport.chatEvents.some(
          event => event.type === 'message.updated' && event.info.id === seeded.messageId
        )
      ).toBe(true);
      expect(pages).toHaveLength(1);
      expect(transport.errors).toEqual([]);
      expect(shim.sockets).toHaveLength(1);
    } finally {
      transport.transport.destroy();
      shim.restore();
    }
  });

  it('records a superseded page whose read belonged to a record-only retry chain', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    const seeded = await seedNativeHistory(stub, kiloSessionId);
    const shim = installSocketShim({ sessionId });

    // The gate the record-only chain's timer read hangs on until a newer
    // reconnect has superseded it.
    const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
    const lost = () => new Error('Connection lost.');
    type ReadRecord = { sockets: number; held: boolean };
    const reads: ReadRecord[] = [];
    // Reads fail until this latch closes. It closes only after the second
    // connection has replayed, which is strictly after `onReconnected` ran —
    // that handler cancels the initial chain and dispatches its own
    // record-only read synchronously. So every read the latch holds belongs to
    // the record-only chain's retry timer.
    let holding = false;

    const pages: SessionSnapshotPage[] = [];
    const transport = createSettlementTransport({
      sessionId,
      kiloSessionId,
      fetchCloudSnapshotPage: async () => {
        const record = { sockets: shim.sockets.length, held: holding };
        reads.push(record);
        if (!record.held) throw lost();
        await gate;
        const page = await stub.getSessionMessagesPage();
        if (page === null) throw new Error('Session not found');
        return page;
      },
      onInitialPageLoaded: page => pages.push(page),
    });
    try {
      transport.transport.connect();

      // The initial read failed, so the transport connected without a page and
      // armed a retry chain.
      await waitFor(() => expect(shim.sockets).toHaveLength(1));
      await waitFor(() => expect(transport.replayCompletions()).toBe(1));
      expect(transport.errors.length).toBeGreaterThanOrEqual(1);
      expect(pages).toHaveLength(0);

      // The socket drops unexpectedly. `onReconnected` cancels the chain the
      // initial read armed and dispatches its own record-only read, which
      // fails and arms the record-only retry timer.
      shim.sockets[0].drop();
      await waitFor(() => expect(shim.sockets).toHaveLength(2));
      await waitFor(() => expect(transport.replayCompletions()).toBe(2));
      // The reconnect's own dispatch read failed on this second connection.
      expect(reads.some(read => !read.held && read.sockets === 2)).toBe(true);
      expect(reads.filter(read => read.held)).toEqual([]);
      // A read dispatched before the latch closed can never be the record-only
      // chain's timer, because that chain is armed by the dispatch that just
      // failed — it has not been scheduled yet.
      const failedReads = reads.length;

      holding = true;

      // The record-only chain's retry timer fires and stays in flight.
      await waitFor(() => expect(reads.filter(read => read.held)).toHaveLength(1));
      const held = reads.filter(read => read.held);
      expect(held).toHaveLength(1);
      expect(reads.length).toBe(failedReads + 1);
      expect(held[0].sockets).toBe(2);

      // A newer reconnect supersedes the read that is still in flight.
      shim.sockets[1].drop();
      await waitFor(() => expect(shim.sockets).toHaveLength(3));
      await waitFor(() => expect(transport.replayCompletions()).toBe(3));
      const readsBeforeRelease = reads.length;
      const chatBeforeRelease = transport.chatEvents.length;
      // The sockets' own replays already delivered the seeded rows, so the
      // "no new rows" check below compares against a non-empty transcript
      // instead of passing on 0 == 0.
      expect(chatBeforeRelease).toBeGreaterThan(0);

      // The superseded read settles with a real page from the DO. Its rows must
      // stay out of the newer socket's live state, but the page still seeds the
      // connection: metadata, cursor and queued turns have no other source.
      openGate();
      await waitFor(() => expect(pages).toHaveLength(1));

      const page = pages[0];
      expect(page.sourceVersion).toBe('v2');
      expect('source' in page).toBe(false);
      expect(page.messages.map(message => message.info.id)).toEqual([
        seeded.userId,
        seeded.replyId,
      ]);
      // The recorded page still seeded the connection state: the workspace
      // update cursor is taken from it, which no other path does.
      expect(page.updateCursor).toBeGreaterThan(0);

      // The record-only chain ended with the superseded read: no further read
      // was dispatched, and none came from the superseding connection.
      expect(reads).toHaveLength(readsBeforeRelease);
      expect(reads.filter(read => read.sockets >= 3)).toEqual([]);
      // No row of the recorded page reached the sink.
      expect(transport.chatEvents).toHaveLength(chatBeforeRelease);
      expect(transport.sessionCreated()).toBe(0);
      // One error report per dropped episode, both identical transient failures.
      expect(new Set(transport.errors)).toEqual(new Set(['Connection lost.']));
    } finally {
      transport.transport.destroy();
      shim.restore();
    }
  });
});
