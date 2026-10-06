import { env, evictAllDurableObjects, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import migrations from '../../src/control-plane/sandbox/drizzle/migrations.js';
import {
  allocation as allocationTable,
  routes as routesTable,
  scopeGrants,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import { readScopeGrant } from '../../src/control-plane/sandbox/scope-grants.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import type { CallbackJob } from '../../src/callbacks/types.js';
import {
  parseSessionMetadata,
  DEVCONTAINER_RETIRED_MESSAGE,
} from '../../src/persistence/session-metadata.js';
import { ProviderCreationError } from '../../src/sandbox-control/provider.js';
import { VercelSandboxRestError } from '../../src/agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import {
  acceptMessages,
  QUEUED_MESSAGE_LIMIT,
  queueMessage,
  settleAcceptedUpTo,
  settleMessages,
} from '../../src/control-plane/session/messages.js';
import { controlPlaneMessages } from '../../src/control-plane/session/sqlite-schema.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlanePromptPayload,
  type ControlPlaneRouteSpec,
  type ControlPlaneRouteUpdate,
} from '../../src/shared/control-plane-protocol.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import type { MessageResultRPCResponse } from '../../src/session/message-result.js';
import { sessionDoName } from '../../src/session-plane.js';
import {
  createFakeCredentialBroker,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

const NATIVE_KILO_TOKEN = 'native-kilo-token-user';
/** The session owner; the Session DO name is `ownerId:sessionId` (spec §3). */
const SESSION_OWNER_ID = 'user_123';
const QUEUED_BACKSTOP_MS = CONTROL_PLANE_TIMERS.session.queuedBackstopMs;
const ACCEPTED_BACKSTOP_MS = CONTROL_PLANE_TIMERS.session.acceptedBackstopMs;

describe('retired control-plane runtime recovery', () => {
  it.each(['unknown', 'ready'] as const)(
    'fails stored devcontainer work from a %s route before prepare or delivery and keeps Stop accessible',
    async routeState => {
      const sessionId = newSessionId();
      const sandboxId = `istd-${'a'.repeat(48)}`;
      const stub = sessions.getByName(sessionDoName(SESSION_OWNER_ID, sessionId));
      const peer = new FakeSandboxPeer();
      await stub.registerSession(registration(sandboxId, sessionId));
      await installPeer(stub, peer);
      await runInDurableObject(stub, async (instance, state) => {
        const metadata = parseSessionMetadata({
          metadataSchemaVersion: 2,
          identity: { userId: SESSION_OWNER_ID, sessionId },
          auth: { kilocodeToken: NATIVE_KILO_TOKEN },
          workspace: { sandboxId, devcontainerRequested: true },
          lifecycle: { version: 1, timestamp: 1 },
        });
        Object.assign(instance, { metadata });
        await state.storage.put('session_metadata', metadata);
        if (routeState === 'ready') {
          Object.assign(instance, { route: peer.view('ready') });
          await state.storage.put('control_plane_route', peer.view('ready'));
        }
      });
      const messageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
      await expect(stub.send(promptPayload(messageId))).resolves.toEqual({ type: 'ok' });
      expect(await messageStatus(stub, messageId)).toBe('failed');
      expect(await readMessageReason(stub, messageId)).toBe(DEVCONTAINER_RETIRED_MESSAGE);
      expect(peer.prepareCalls).toEqual([]);
      expect(peer.deliverCalls).toEqual([]);
      await stub.stop();
      expect(peer.abortCalls).toEqual([sessionId]);
      expect((await stub.getMetadata())?.workspace?.devcontainerRequested).toBe(true);
    }
  );
});

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}
function newSessionId(): string {
  return `workspace_${crypto.randomUUID()}`;
}

function kiloSessionId(): string {
  // `containedKiloSessionIdSchema` requires exactly 26 alphanumerics.
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

function routeSpec(sessionId: string): ControlPlaneRouteSpec {
  return {
    sessionId,
    kiloSessionId: kiloSessionId(),
    directory: `/workspace/${sessionId}`,
    attemptId: `${sessionId}-requested`,
  };
}

function registration(sandboxId: string, sessionId: string) {
  const kiloId = kiloSessionId();
  return {
    sandboxId,
    spec: { ...routeSpec(sessionId), kiloSessionId: kiloId },
    credentials: {
      userId: SESSION_OWNER_ID,
      kiloSessionId: kiloId,
      kiloToken: NATIVE_KILO_TOKEN,
      orgId: 'org_123',
      repository: { type: 'github' as const, repo: 'acme/widgets' },
      scopeId: sessionId,
    },
  };
}

function promptPayload(messageId: string, prompt = 'hello'): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt },
    agent: { mode: 'code', model: 'test/model' },
  };
}

async function installPeer(stub: DurableObjectStub<SandboxSessionV2>, peer: FakeSandboxPeer) {
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => peer;
  });
}

async function readAlarm(stub: DurableObjectStub<SandboxSessionV2>): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function runSessionAlarm(stub: DurableObjectStub<SandboxSessionV2>): Promise<void> {
  await runInDurableObject(stub, instance => instance.alarm());
}

async function setMessageTimes(
  stub: DurableObjectStub<SandboxSessionV2>,
  messageId: string,
  patch: { created_at?: number; accepted_at?: number }
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    await db
      .update(controlPlaneMessages)
      .set(patch)
      .where(eq(controlPlaneMessages.message_id, messageId));
  });
}

async function setGrantExpiry(
  stub: DurableObjectStub<SandboxControlV2>,
  sessionId: string,
  expiresAt: number
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
    const id = rows[0]?.grant;
    if (id == null) throw new Error('missing scope reference');
    const grant = readScopeGrant(db, id);
    await db
      .update(scopeGrants)
      .set({ grant: JSON.stringify({ ...grant, expiresAt }) })
      .where(eq(scopeGrants.id, id));
  });
}

async function readGrantAlias(
  stub: DurableObjectStub<SandboxControlV2>,
  sessionId: string
): Promise<string | null> {
  return runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
    const id = rows[0]?.grant;
    return id == null ? null : (readScopeGrant(db, id)?.kilo.alias ?? null);
  });
}

async function readMessageReason(
  stub: DurableObjectStub<SandboxSessionV2>,
  messageId: string
): Promise<string | null> {
  return runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db
      .select()
      .from(controlPlaneMessages)
      .where(eq(controlPlaneMessages.message_id, messageId));
    return rows[0]?.reason ?? null;
  });
}

async function messageStatus(
  stub: DurableObjectStub<SandboxSessionV2>,
  messageId: string
): Promise<string | null> {
  const result: MessageResultRPCResponse = await stub.getMessageResult(messageId);
  return result.type === 'found' ? result.result.status : null;
}

type StreamMessage = { streamEventType: string; data: unknown; eventId: number };
type StreamSocket = {
  socket: WebSocket;
  messages: StreamMessage[];
  next: (timeoutMs?: number) => Promise<StreamMessage | null>;
  close: () => void;
};

async function connectStream(sessionId: string): Promise<StreamSocket> {
  const response = await SELF.fetch(
    `http://worker.test/stream-v2?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { Upgrade: 'websocket' } }
  );
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Unexpected stream upgrade: ${response.status}`);
  }
  const socket = response.webSocket;
  socket.accept();
  const messages: StreamMessage[] = [];
  const waiters: Array<(message: StreamMessage | null) => void> = [];
  socket.addEventListener('message', event => {
    const text = typeof event.data === 'string' ? event.data : String(event.data);
    let parsed: StreamMessage;
    try {
      const raw = JSON.parse(text) as { streamEventType: string; data: unknown; eventId: number };
      parsed = { streamEventType: raw.streamEventType, data: raw.data, eventId: raw.eventId };
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else messages.push(parsed);
  });
  return {
    socket,
    messages,
    next: (timeoutMs = 3_000) => {
      const queued = messages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise(resolve => {
        const waiter = (message: StreamMessage | null) => {
          clearTimeout(timer);
          resolve(message);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close: () => socket.close(),
  };
}

async function waitForStreamEvent(
  stream: StreamSocket,
  streamEventType: string
): Promise<StreamMessage> {
  for (;;) {
    const message = await stream.next();
    if (message === null) throw new Error(`Stream never delivered ${streamEventType}`);
    if (message.streamEventType === streamEventType) return message;
  }
}

/** Read live messages until the socket is quiet, then return what arrived. */
async function drainStream(stream: StreamSocket): Promise<StreamMessage[]> {
  const collected: StreamMessage[] = [];
  for (;;) {
    const message = await stream.next(500);
    if (message === null) return collected;
    collected.push(message);
  }
}

type PreparingRowData = {
  version?: number;
  action?: string;
  attemptId?: string;
  triggerMessageId?: string;
  revision?: number;
  step?: string;
  safeError?: string;
  attempt?: { id?: string; status?: string; triggerMessageId?: string };
  stepSnapshot?: { id?: string; key?: string; status?: string };
};

/** The `preparing` rows delivered on a stream, in arrival order. */
function preparingRows(messages: StreamMessage[]): PreparingRowData[] {
  return messages
    .filter(message => message.streamEventType === 'preparing')
    .map(message => message.data as PreparingRowData);
}

// --- fake sandbox provider (both real V2 DOs) --------------------------------

type FakeProvider = {
  adapter: ProviderAdapter;
  createCalls: number;
  refs: string[];
  launchEnvs: Record<string, string>[];
  stopCalls: (string | null)[];
  failure?: unknown;
};

function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    createCalls: 0,
    refs: [],
    launchEnvs: [],
    stopCalls: [],
  };
  provider.adapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      provider.createCalls += 1;
      if (provider.failure !== undefined) throw provider.failure;
      const ref = `mem_${intent.intentId}`;
      provider.refs.push(ref);
      return { providerRef: ref };
    },
    async launch(_ref, launchEnv) {
      provider.launchEnvs.push({ ...launchEnv });
      return { startSource: 'image' as const };
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(ref) {
      provider.stopCalls.push(ref);
      return 'terminal' as StopResult;
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

afterEach(async () => {
  await reset();
});

describe('SandboxSessionV2 message reducer', () => {
  it('keeps queued admission idempotent and terminal ids final', () => {
    const intent = promptPayload('m1');
    const first = queueMessage([], intent, 1);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]?.state).toBe('queued');
    const replay = queueMessage(first.messages, intent, 2);
    expect(replay.changed).toHaveLength(0);
    expect(replay.messages).toHaveLength(1);
    const settled = settleMessages(replay.messages, ['m1'], 'completed', undefined, 3);
    const late = queueMessage(settled.messages, intent, 4);
    expect(late.changed).toHaveLength(0);
    expect(late.messages[0]?.state).toBe('completed');
  });

  it('settles only accepted messages up to lastMessageId', () => {
    let state = queueMessage([], promptPayload('m1'), 1).messages;
    state = queueMessage(state, promptPayload('m2'), 2).messages;
    state = acceptMessages(state, ['m1', 'm2'], 3).messages;
    const settled = settleAcceptedUpTo(state, 'm1', 'completed', undefined, 4);
    expect(settled.messages.map(message => message.state)).toEqual(['completed', 'accepted']);
  });

  it('ignores an outcome naming a message that is not accepted', () => {
    let state = queueMessage([], promptPayload('m1'), 1).messages;
    state = queueMessage(state, promptPayload('m2'), 2).messages;
    state = acceptMessages(state, ['m2'], 3).messages;
    state = settleMessages(state, ['m1'], 'cancelled', 'interrupted', 4).messages;
    const late = settleAcceptedUpTo(state, 'm1', 'cancelled', 'interrupted', 5);
    expect(late.changed).toHaveLength(0);
    expect(late.messages.map(message => message.state)).toEqual(['cancelled', 'accepted']);
  });
});

describe('SandboxSessionV2 message flow (fake sandbox peer)', () => {
  async function setup(): Promise<{
    sessionId: string;
    stub: DurableObjectStub<SandboxSessionV2>;
    peer: FakeSandboxPeer;
  }> {
    const sessionId = newSessionId();
    const sandboxId = unique('sbx__session_v2');
    const stub = sessions.getByName(sessionId);
    const peer = new FakeSandboxPeer();
    await stub.registerSession(registration(sandboxId, sessionId));
    await installPeer(stub, peer);
    return { sessionId, stub, peer };
  }

  it('queues on send and accepts when ready delivers', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    expect(await readAlarm(stub)).not.toBeNull();

    peer.prepareView = peer.view('ready');
    await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    expect(peer.deliverCalls).toHaveLength(1);
    expect(peer.deliverCalls[0]?.messages).toHaveLength(1);
  });

  it('accepts a control send within the queued bound', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');

    await expect(stub.send(promptPayload('m1'))).resolves.toEqual({ type: 'ok' });
    expect(await messageStatus(stub, 'm1')).toBe('queued');
  });

  it('refuses a control send over the queued bound and keeps the queued messages', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');

    for (let index = 0; index < QUEUED_MESSAGE_LIMIT; index += 1) {
      await expect(stub.send(promptPayload(`m${index}`))).resolves.toEqual({ type: 'ok' });
    }
    await expect(stub.send(promptPayload('overflow'))).resolves.toEqual({ type: 'queue-full' });

    for (let index = 0; index < QUEUED_MESSAGE_LIMIT; index += 1) {
      expect(await messageStatus(stub, `m${index}`)).toBe('queued');
    }
    expect(await messageStatus(stub, 'overflow')).toBeNull();
  });

  it('retries delivery on the next route notification after a not_ready write', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    peer.deliverResults = ['not_ready', 'sent'];
    await stub.send(promptPayload('m1'));
    // The ready view after `not_ready` is stored, not re-delivered from `send`.
    expect(peer.deliverCalls).toHaveLength(1);
    expect(await messageStatus(stub, 'm1')).toBe('queued');

    await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    expect(peer.deliverCalls).toHaveLength(2);
    expect(peer.prepareCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('delivers a new message after a lost ready notification without waiting for the backstop', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(promptPayload('m1'));
    // Delivered straight from the prepare view; the remaining alarm is the
    // accepted no-outcome backstop, not a wait for route readiness.
    expect(await messageStatus(stub, 'm1')).toBe('running');
    expect(peer.deliverCalls).toHaveLength(1);
  });

  it('joins a follow-up message to the outcome boundary', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(promptPayload('m1'));
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));

    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm2' });
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('completed'));
    expect(await messageStatus(stub, 'm2')).toBe('completed');
    expect(await readAlarm(stub)).toBeNull();
  });

  it('leaves a later accepted message untouched by an earlier outcome boundary', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));

    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('completed'));
    expect(await messageStatus(stub, 'm2')).toBe('running');
  });

  it('fails queued and accepted messages on a failed route', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));

    peer.prepareView = peer.view('preparing');
    await stub.onRoute({ state: 'preparing', attemptId: peer.attemptId });
    await stub.send(promptPayload('m2'));
    expect(await messageStatus(stub, 'm2')).toBe('queued');

    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    };
    await stub.onRoute({
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    });
    expect(await messageStatus(stub, 'm1')).toBe('failed');
    expect(await messageStatus(stub, 'm2')).toBe('failed');
    expect(await readAlarm(stub)).toBeNull();
  });

  it('fails accepted and re-prepares queued messages on a lost route', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));

    peer.prepareView = peer.view('preparing');
    await stub.onRoute({ state: 'preparing', attemptId: peer.attemptId });
    await stub.send(promptPayload('m2'));
    const preparesBefore = peer.prepareCalls.length;

    const oldAttempt = peer.attemptId;
    peer.status = async input => ({ sessionId: input.sessionId, view: { state: 'unknown' } });
    peer.attemptId = crypto.randomUUID();
    peer.prepareView = peer.view('preparing');
    await stub.onRoute({ state: 'lost', attemptId: oldAttempt, reason: 'connection_lost' });
    expect(await messageStatus(stub, 'm1')).toBe('failed');
    expect(await messageStatus(stub, 'm2')).toBe('queued');
    expect(peer.prepareCalls.length).toBeGreaterThan(preparesBefore);
  });

  it('fails a queued message on the backstop and clears the alarm', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    expect(await readAlarm(stub)).not.toBeNull();
    await setMessageTimes(stub, 'm1', { created_at: Date.now() - QUEUED_BACKSTOP_MS - 1 });

    await runSessionAlarm(stub);
    expect(await messageStatus(stub, 'm1')).toBe('failed');
    expect(await readAlarm(stub)).toBeNull();
  });

  it('fails an accepted message on the backstop', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await setMessageTimes(stub, 'm1', { accepted_at: Date.now() - ACCEPTED_BACKSTOP_MS - 1 });

    await runSessionAlarm(stub);
    expect(await messageStatus(stub, 'm1')).toBe('failed');
    expect(await readAlarm(stub)).toBeNull();
  });

  it('clears the backstop alarm on stop and cancels open messages', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    expect(await readAlarm(stub)).not.toBeNull();

    await stub.stop();
    expect(await messageStatus(stub, 'm1')).toBe('interrupted');
    expect(await readAlarm(stub)).toBeNull();
    expect(peer.abortCalls).toEqual([sessionId]);
  });

  it('aborts the live route on stop when no message is queued or accepted', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    expect(await messageStatus(stub, 'm1')).toBe('completed');
    const preparesBefore = peer.prepareCalls.length;

    await expect(stub.stop()).resolves.toEqual({ interrupted: false });

    expect(peer.abortCalls).toEqual([sessionId]);
    expect(await messageStatus(stub, 'm1')).toBe('completed');
    expect(peer.prepareCalls).toHaveLength(preparesBefore);
  });

  it('cancels a queued message without touching an accepted one', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    peer.prepareView = peer.view('preparing');
    await stub.onRoute({ state: 'preparing', attemptId: peer.attemptId });
    await stub.send(promptPayload('m2'));

    await expect(stub.cancelQueuedMessage('m2')).resolves.toEqual({ dropped: true });
    expect(await messageStatus(stub, 'm2')).toBe('interrupted');
    expect(await messageStatus(stub, 'm1')).toBe('running');
  });

  it('ignores a late outcome for a terminal message and keeps a newer accepted one', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.stop();
    expect(await messageStatus(stub, 'm1')).toBe('interrupted');

    peer.prepareView = peer.view('ready');
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));

    await stub.onOutcome({ sessionId, status: 'cancelled', lastMessageId: 'm1' });
    expect(await messageStatus(stub, 'm1')).toBe('interrupted');
    expect(await messageStatus(stub, 'm2')).toBe('running');
  });

  it('ignores a failed notification for an old attempt and only fails the current one', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    const staleAttemptId = peer.attemptId;

    peer.attemptId = crypto.randomUUID();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m2'));

    await stub.onRoute({
      state: 'failed',
      attemptId: staleAttemptId,
      reason: 'workspace_setup_failed',
    });
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    expect(await messageStatus(stub, 'm2')).toBe('queued');

    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    };
    await stub.onRoute({
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    });
    expect(await messageStatus(stub, 'm2')).toBe('failed');
  });

  it('delivers all queued messages together once the route becomes ready', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.send(promptPayload('m2'));
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    expect(await messageStatus(stub, 'm2')).toBe('queued');

    peer.prepareView = peer.view('ready');
    await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));
    expect(await messageStatus(stub, 'm1')).toBe('running');
    expect(peer.deliverCalls).toHaveLength(1);
    expect(peer.deliverCalls[0]?.messages.map(message => message.messageId)).toEqual(['m1', 'm2']);
  });

  it('keeps queued intent when deliver outlives the 2 s transport deadline', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    peer.deliverDelayMs = 2_500;

    const started = Date.now();
    await stub.send(promptPayload('m1'));

    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    expect(Date.now() - started).toBeLessThan(2_400);
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    expect(peer.deliverCalls).toHaveLength(1);
  });

  it('keeps the stored route view and an open preparation row when prepare fails', async () => {
    const { sessionId, stub, peer } = await setup();
    const stream = await connectStream(sessionId);
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.onRoute({ state: 'preparing', step: 'clone', attemptId: peer.attemptId });
    const attemptId = peer.attemptId;

    peer.prepareError = new Error('sandbox control unreachable');
    await stub.send(promptPayload('m2'));

    await expect(stub.getSession()).resolves.toMatchObject({
      type: 'found',
      route: { state: 'preparing', attemptId },
    });
    // A transport failure is no information: the open row is neither advanced
    // nor closed by it.
    const rows = preparingRows(await drainStream(stream));
    expect(rows.filter(row => row.action === 'attempt_started')).toHaveLength(1);
    expect(
      rows.some(row => row.action === 'attempt_completed' || row.action === 'attempt_failed')
    ).toBe(false);
    stream.close();
  });

  it('opens exactly one preparing row that advances with the route step', async () => {
    const { sessionId, stub, peer } = await setup();
    const stream = await connectStream(sessionId);
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.onRoute({ state: 'preparing', step: 'clone', attemptId: peer.attemptId });
    await stub.onRoute({ state: 'preparing', step: 'setup', attemptId: peer.attemptId });

    const rows = preparingRows(await drainStream(stream));
    const started = rows.filter(row => row.action === 'attempt_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      version: 2,
      attemptId: peer.attemptId,
      triggerMessageId: 'm1',
    });
    // The step advances in place; the same attempt never opens a second row.
    expect(rows.filter(row => row.action === 'step_started').map(row => row.step)).toEqual([
      'workspace_setup',
      'cloning',
      'setup_commands',
    ]);
    stream.close();
  });

  it('closes the preparing row as failed when the route fails', async () => {
    const { sessionId, stub, peer } = await setup();
    const stream = await connectStream(sessionId);
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.onRoute({ state: 'preparing', step: 'clone', attemptId: peer.attemptId });
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    };
    await stub.onRoute({
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    });

    const rows = preparingRows(await drainStream(stream));
    expect(rows.find(row => row.action === 'attempt_failed')).toMatchObject({
      attemptId: peer.attemptId,
      step: 'failed',
      safeError: 'workspace_setup_failed',
    });
    expect(rows.some(row => row.action === 'attempt_completed')).toBe(false);
    stream.close();
  });

  it('replaces the preparing row when the route attempt changes', async () => {
    const { sessionId, stub, peer } = await setup();
    const stream = await connectStream(sessionId);
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    const firstAttempt = peer.attemptId;

    peer.attemptId = crypto.randomUUID();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m2'));

    const rows = preparingRows(await drainStream(stream));
    expect(rows.filter(row => row.action === 'attempt_started').map(row => row.attemptId)).toEqual([
      firstAttempt,
      peer.attemptId,
    ]);
    // The superseded attempt is closed, so exactly one row stays open.
    expect(rows.filter(row => row.action === 'attempt_failed').map(row => row.attemptId)).toEqual([
      firstAttempt,
    ]);
    stream.close();
  });

  it('replays the open preparation row when a client connects mid-attempt', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.onRoute({ state: 'preparing', step: 'clone', attemptId: peer.attemptId });

    // A second client connects while the attempt is still preparing: the
    // materialized row replays so the client is not left without it.
    const stream = await connectStream(sessionId);
    const connected = await waitForStreamEvent(stream, 'connected');
    expect(connected.data).toMatchObject({ cloudStatus: { type: 'preparing', step: 'cloning' } });
    const replayed = preparingRows(await drainStream(stream));
    expect(
      replayed.some(row => row.action === 'attempt_snapshot' && row.attempt?.status === 'running')
    ).toBe(true);
    expect(
      replayed.some(row => row.action === 'step_snapshot' && row.stepSnapshot?.key === 'cloning')
    ).toBe(true);
    expect(
      replayed.find(row => row.action === 'step_snapshot' && row.stepSnapshot?.key === 'cloning')
        ?.stepSnapshot
    ).toMatchObject({ latestDetail: 'Cloning repository' });
    stream.close();
  });

  it('records distinct progress text for each route preparation phase', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    const phases = [
      { step: 'sandbox_create', key: 'sandbox_provision', detail: 'Creating sandbox' },
      { step: 'sandbox_start', key: 'sandbox_boot', detail: 'Starting sandbox' },
      { step: 'clone', key: 'cloning', detail: 'Cloning repository' },
      { step: 'checkout', key: 'branch', detail: 'Checking out branch' },
      { step: 'setup', key: 'setup_commands', detail: 'Running setup commands' },
      { step: 'kilo_runtime', key: 'kilo_server', detail: 'Starting Kilo runtime' },
      { step: 'kilo_session', key: 'kilo_session', detail: 'Preparing Kilo session' },
    ] as const;
    for (const phase of phases) {
      await stub.onRoute({ state: 'preparing', step: phase.step, attemptId: peer.attemptId });
    }
    const stream = await connectStream(sessionId);
    await waitForStreamEvent(stream, 'connected');
    const replayed = preparingRows(await drainStream(stream));
    for (const phase of phases) {
      expect(
        replayed.find(row => row.action === 'step_snapshot' && row.stepSnapshot?.key === phase.key)
          ?.stepSnapshot
      ).toMatchObject({ latestDetail: phase.detail });
    }
    stream.close();
  });

  it('shows live step detail and keeps it across a stepless repeated prepare', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    const detail = 'Cloning repository... Receiving objects: 45%';
    await stub.onRoute({ state: 'preparing', step: 'clone', attemptId: peer.attemptId });
    await stub.onRoute({ state: 'preparing', step: 'clone', detail, attemptId: peer.attemptId });
    // A second message re-prepares; the Sandbox returns the stepless view.
    await stub.send(promptPayload('m2'));

    const stream = await connectStream(sessionId);
    const connected = await waitForStreamEvent(stream, 'connected');
    expect(connected.data).toMatchObject({ cloudStatus: { type: 'preparing', step: 'cloning' } });
    const steps = preparingRows(await drainStream(stream)).flatMap(row =>
      row.action === 'step_snapshot' && row.stepSnapshot ? [row.stepSnapshot] : []
    );
    expect(steps.map(step => [step.key, step.status, step.latestDetail])).toEqual([
      ['workspace_setup', 'completed', 'Preparing environment'],
      ['cloning', 'running', detail],
    ]);
    stream.close();
  });

  it('does not re-deliver inside the enqueue task when a ready view follows not_ready', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    peer.deliverResult = 'not_ready';
    await stub.send(promptPayload('m1'));

    // A ready view after a failed write is stored, not re-delivered: the call
    // count is bounded and control returns to the caller.
    expect(peer.deliverCalls).toHaveLength(1);
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    await expect(stub.stop()).resolves.toEqual({ interrupted: true });
    expect(peer.abortCalls).toHaveLength(1);
  });

  it('replays the open preparation row after eviction and closes it on ready', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.onRoute({ state: 'preparing', step: 'clone', attemptId: peer.attemptId });

    await evictAllDurableObjects();
    const revived = sessions.getByName(sessionId);
    await installPeer(revived, peer);

    // The row survives eviction in the event log and replays to a reconnect.
    const stream = await connectStream(sessionId);
    const connected = await waitForStreamEvent(stream, 'connected');
    expect(connected.data).toMatchObject({ cloudStatus: { type: 'preparing', step: 'cloning' } });
    const replayed = preparingRows(await drainStream(stream));
    expect(
      replayed.some(row => row.action === 'attempt_snapshot' && row.attempt?.status === 'running')
    ).toBe(true);

    // A ready route after eviction still closes the persisted row: the stored
    // previous route named the attempt, not the lost in-memory recorder map.
    peer.prepareView = peer.view('ready');
    await revived.onRoute({ state: 'ready', attemptId: peer.attemptId });
    const closed = preparingRows(await drainStream(stream));
    expect(closed.some(row => row.action === 'attempt_completed')).toBe(true);
    stream.close();
  });

  it('delivers all queued messages in order in one pass and re-prepares on not_ready', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.send(promptPayload('m2'));

    // The route becomes ready but the socket cannot take the write.
    peer.deliverResult = 'not_ready';
    peer.prepareView = peer.view('ready');
    peer.prepare = async input => {
      peer.prepareCalls.push(input);
      return peer.view('reconnecting');
    };
    await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });

    expect(peer.deliverCalls).toHaveLength(1);
    expect(peer.deliverCalls[0]?.messages.map(message => message.messageId)).toEqual(['m1', 'm2']);
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    expect(await messageStatus(stub, 'm2')).toBe('queued');
    expect(peer.prepareCalls.length).toBeGreaterThanOrEqual(1);

    // The socket returns: one more deliver ships both, still in order.
    peer.deliverResult = 'sent';
    await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));
    expect(peer.deliverCalls).toHaveLength(2);
    expect(peer.deliverCalls[1]?.messages.map(message => message.messageId)).toEqual(['m1', 'm2']);
  });

  it('streams preparing rows and cloud.status transitions', async () => {
    const { sessionId, stub, peer } = await setup();
    const stream = await connectStream(sessionId);

    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.onRoute({ state: 'preparing', step: 'clone', attemptId: peer.attemptId });
    peer.prepareView = peer.view('ready');
    await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await stub.onEvents({ events: [{ type: 'wrapper_finalizing', properties: {} }] });
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });

    const messages = await drainStream(stream);
    const preparing = messages.find(
      message =>
        message.streamEventType === 'preparing' &&
        (message.data as { step?: string }).step === 'cloning'
    );
    expect(preparing?.data).toMatchObject({
      version: 2,
      attemptId: peer.attemptId,
      step: 'cloning',
    });
    const statuses = messages
      .filter(message => message.streamEventType === 'cloud.status')
      .map(message => (message.data as { cloudStatus: { type: string } }).cloudStatus.type);
    expect(statuses).toEqual(['preparing', 'preparing', 'ready', 'finalizing', 'ready']);
    // The route attempt's preparation row is finalized, not left running.
    expect(
      messages.some(
        message =>
          message.streamEventType === 'preparing' &&
          (message.data as { action?: string }).action === 'attempt_completed'
      )
    ).toBe(true);
    stream.close();
  });

  it('renders the wrapper setup-command lifecycle as per-command preparing steps', async () => {
    const { sessionId, stub, peer } = await setup();
    const stream = await connectStream(sessionId);
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.onRoute({ state: 'preparing', step: 'setup', attemptId: peer.attemptId });
    await stub.onEvents({
      events: [
        {
          type: 'session.setup.started',
          properties: { command: 1, commandCount: 1, text: 'npm install' },
        },
        { type: 'session.setup.output', properties: { command: 1, output: 'npm install\n' } },
        { type: 'session.setup.finished', properties: { command: 1, exitCode: 0 } },
      ],
    });

    const messages = await drainStream(stream);
    const commandRows = messages
      .filter(message => message.streamEventType === 'preparing')
      .map(
        message =>
          message.data as { action?: string; step?: string; stepId?: string; output?: string }
      )
      .filter(data => data.stepId === 'setup_command:0');
    expect(commandRows.map(data => data.action)).toEqual([
      'step_started',
      'step_output',
      'step_completed',
    ]);
    expect(commandRows[1]).toMatchObject({ step: 'setup_commands', output: 'npm install\n' });
    // The rendered preparing rows replace the raw wrapper events.
    expect(messages.some(message => message.streamEventType === 'kilocode')).toBe(false);
    stream.close();
  });

  it.each(['preparing', 'unknown'] as const)(
    'never persists or broadcasts setup command text with route %s',
    async routeState => {
      const { sessionId, stub, peer } = await setup();
      const stream = await connectStream(sessionId);
      if (routeState === 'preparing') {
        peer.prepareView = peer.view('preparing');
        await stub.send(promptPayload('m1'));
      }
      await stub.onEvents({
        events: [
          {
            type: 'session.setup.started',
            properties: { command: 1, commandCount: 1, text: 'curl -u user:inline-secret-canary' },
          },
        ],
      });
      const live = await drainStream(stream);
      expect(JSON.stringify(live)).not.toContain('inline-secret-canary');
      expect(live.some(message => message.streamEventType === 'kilocode')).toBe(false);
      stream.close();

      const replay = await connectStream(sessionId);
      expect(JSON.stringify(await drainStream(replay))).not.toContain('inline-secret-canary');
      replay.close();
    }
  );

  it.each([0, 1])(
    'recovers missing setup starts and retains output and exit code %s',
    async exitCode => {
      const { sessionId, stub, peer } = await setup();
      peer.prepareView = peer.view('preparing');
      await stub.send(promptPayload('m1'));
      await stub.onRoute({ state: 'preparing', step: 'setup', attemptId: peer.attemptId });
      const stream = await connectStream(sessionId);
      await drainStream(stream);
      await stub.onEvents({
        events: [
          {
            type: 'session.setup.output',
            properties: { command: 1, output: 'surviving diagnostics\n' },
          },
          { type: 'session.setup.finished', properties: { command: 1, exitCode } },
        ],
      });
      const live = await drainStream(stream);
      expect(preparingRows(live).map(row => row.action)).toEqual([
        'step_started',
        'step_output',
        exitCode === 0 ? 'step_completed' : 'step_failed',
      ]);
      expect(live.some(message => message.streamEventType === 'kilocode')).toBe(false);
      stream.close();

      const replay = await connectStream(sessionId);
      const rows = preparingRows(await drainStream(replay));
      expect(
        rows.find(row => row.stepSnapshot?.id === 'setup_command:0')?.stepSnapshot
      ).toMatchObject({
        status: exitCode === 0 ? 'completed' : 'failed',
        outputTail: 'surviving diagnostics\n',
        exitCode,
      });
      replay.close();
    }
  );

  it('discards setup lifecycle events received after preparation failure', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'preparation_timeout',
    };
    await stub.onRoute({
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'preparation_timeout',
    });
    await expect(stub.getSession()).resolves.toMatchObject({ route: { state: 'failed' } });
    const stream = await connectStream(sessionId);
    await drainStream(stream);
    await stub.onEvents({
      events: [
        { type: 'session.setup.started', properties: { command: 1, commandCount: 1 } },
        { type: 'session.setup.output', properties: { command: 1, output: 'late output' } },
        { type: 'session.setup.finished', properties: { command: 1, exitCode: 0 } },
      ],
    });
    expect(await drainStream(stream)).toEqual([]);
    stream.close();

    const replay = await connectStream(sessionId);
    const rows = preparingRows(await drainStream(replay));
    expect(rows.some(row => row.stepSnapshot?.id === 'setup_command:0')).toBe(false);
    expect(rows.find(row => row.attempt?.id === peer.attemptId)?.attempt).toMatchObject({
      status: 'failed',
    });
    replay.close();
  });

  it.each([
    { type: 'session.setup.finished', properties: { command: 1, exitCode: '1' } },
    { type: 'session.setup.finished', properties: { command: 1 } },
    { type: 'session.setup.finished', properties: { exitCode: 1 } },
    { type: 'session.setup.started', properties: { command: 0, commandCount: 1 } },
    { type: 'session.setup.started', properties: { command: 21, commandCount: 21 } },
    { type: 'session.setup.started', properties: { command: 1.5, commandCount: 2 } },
    { type: 'session.setup.started', properties: { command: 2, commandCount: 1 } },
    { type: 'session.setup.output', properties: { command: 1, output: 123 } },
  ])('discards malformed setup lifecycle event $type with $properties', async event => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.onEvents({
      events: [{ type: 'session.setup.started', properties: { command: 1, commandCount: 1 } }],
    });
    const stream = await connectStream(sessionId);
    await drainStream(stream);
    await stub.onEvents({ events: [event] });
    expect(await drainStream(stream)).toEqual([]);
    stream.close();

    const replay = await connectStream(sessionId);
    const rows = preparingRows(await drainStream(replay));
    expect(
      rows.find(row => row.stepSnapshot?.id === 'setup_command:0')?.stepSnapshot
    ).toMatchObject({ status: 'running' });
    replay.close();
  });

  it('derives the connected cloud status from the persisted route view after eviction', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    };
    await stub.onRoute({
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    });

    await evictAllDurableObjects();
    const revived = sessions.getByName(sessionId);
    await expect(revived.getSession()).resolves.toMatchObject({
      type: 'found',
      route: { state: 'failed', attemptId: peer.attemptId },
    });

    const stream = await connectStream(sessionId);
    const connected = await waitForStreamEvent(stream, 'connected');
    expect(connected.data).toMatchObject({ cloudStatus: { type: 'error' } });
    stream.close();
  });

  it('replays the stored command catalog on connect', async () => {
    const { sessionId, stub } = await setup();
    await stub.onEvents({
      events: [
        {
          type: 'commands.available',
          properties: { commands: [{ name: 'acme.fix', description: 'Fix it' }] },
        },
      ],
    });
    const stream = await connectStream(sessionId);
    const catalog = await waitForStreamEvent(stream, 'commands.available');
    const names = (catalog.data as { commands: Array<{ name: string }> }).commands.map(
      command => command.name
    );
    expect(names).toContain('acme.fix');
    stream.close();
  });

  it('returns session-not-found for an old-plane instance after the storage cutover', async () => {
    const sessionId = newSessionId();
    const sandboxId = unique('sbx__session_v2');
    let stub = sessions.getByName(sessionId);
    // Register first so the wipe is what removes the session, not the absence
    // of any data.
    await stub.registerSession(registration(sandboxId, sessionId));

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete('control_plane_generation');
      await state.storage.put('session_metadata', { legacy: true });
    });
    await evictAllDurableObjects();
    stub = sessions.getByName(sessionId);

    await expect(stub.getSession()).resolves.toEqual({ type: 'session-not-found' });
    const leftover = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get('session_metadata')
    );
    expect(leftover).toBeUndefined();
  });
});

describe('SandboxSessionV2 end-to-end with the V2 Sandbox DO and fake wrapper', () => {
  it.each(['ready', 'preparing'] as const)(
    'preserves message ownership when pre-B %s retirement arrives after a fresh send',
    async oldState => {
      const sessionId = newSessionId();
      const sandboxId = unique('sbx__retirement_order');
      const provider = createFakeProvider();
      const sandboxStub = sandboxes.getByName(sandboxId);
      await runInDurableObject(sandboxStub, async instance => {
        await instance.getAllocationState();
        installFakeCredentialEnv(instance.env, createFakeCredentialBroker());
        Object.assign(instance, {
          createProviderAdapter: () => provider.adapter,
          provider: provider.adapter,
        });
      });
      const sessionStub = sessions.getByName(sessionDoName(SESSION_OWNER_ID, sessionId));
      expect(
        await sessionStub.registerSessionFromMetadata({
          metadata: parseSessionMetadata({
            metadataSchemaVersion: 2,
            identity: { sessionId, userId: SESSION_OWNER_ID, orgId: 'org_123' },
            auth: { kiloSessionId: kiloSessionId(), kilocodeToken: NATIVE_KILO_TOKEN },
            agent: { mode: 'code', model: 'test/model' },
            repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
            workspace: { sandboxId, sandboxProvider: 'cloudflare' },
            callback: { target: { url: 'https://callback.test/hook' } },
            lifecycle: { version: 1, timestamp: 1 },
          }),
          sandboxSelection: { provider: 'cloudflare' },
        })
      ).toEqual({ success: true });
      const reports: CloudAgentQueueReport[] = [];
      const callbacks: CallbackJob[] = [];
      await runInDurableObject(sessionStub, instance => {
        instance.env.CLOUD_AGENT_REPORT_QUEUE = {
          send: async (report: CloudAgentQueueReport) => {
            reports.push(report);
          },
        } as never;
        instance.env.CALLBACK_QUEUE = {
          send: async (job: CallbackJob) => {
            callbacks.push(job);
          },
        } as never;
      });
      await sessionStub.send(promptPayload('old-A'));
      await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
      const launch = provider.launchEnvs[0];
      const wrapperA = await FakeWrapper.connect({
        sandboxId,
        credential: launch.SANDBOX_CONTROL_CREDENTIAL,
      });
      await wrapperA.hello({
        wrapperId: 'wr_before_retirement',
        allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
      });
      expect(await wrapperA.next()).toMatchObject({ type: 'session.prepare' });
      if (oldState === 'ready') {
        wrapperA.send({ type: 'session.ready', sessionId });
        expect(await wrapperA.nextSkipping(['worktree.snapshot'])).toMatchObject({
          type: 'session.prompt',
          payload: { messageId: 'old-A' },
        });
        await waitFor(async () =>
          expect(await messageStatus(sessionStub, 'old-A')).toBe('running')
        );
      }
      const attemptA = (await sandboxStub.status({ sessionId })).view;
      if (attemptA.state !== oldState) throw new Error('Missing old attempt fixture');
      const retirementUpdates: ControlPlaneRouteUpdate[] = [];
      let releaseNotification!: () => void;
      let releaseResponse!: () => void;
      const notification = new Promise<void>(resolve => {
        releaseNotification = resolve;
      });
      const response = new Promise<void>(resolve => {
        releaseResponse = resolve;
      });
      await runInDurableObject(sandboxStub, async (instance, state) => {
        const db = drizzle(state.storage);
        const route = db.select().from(routesTable).get();
        const allocation = db.select().from(allocationTable).get();
        const grant = route?.grant == null ? null : readScopeGrant(db, route.grant);
        if (route === undefined || allocation === undefined || grant === null)
          throw new Error('Missing pre-B fixture');
        const retained = await state.storage.list();
        await state.storage.deleteAll();
        const first = migrations.journal.entries[0];
        if (first === undefined) throw new Error('Missing first migration');
        await migrate(db, {
          journal: { entries: [first] },
          migrations: { m0000: migrations.migrations.m0000 },
        });
        for (const [key, value] of retained) await state.storage.put(key, value);
        expect(await state.storage.get('control_plane_generation')).toBe(2);
        db.insert(allocationTable).values(allocation).run();
        // Raw SQL: the pre-B routes table predates `repo_key`, which the schema now carries.
        db.run(
          sql`INSERT INTO routes (session_id, spec, grant, credential_source, state, attempt_id, attempt_deadline_at, reason, updated_at)
              VALUES (${route.session_id}, ${route.spec}, ${JSON.stringify(grant)}, ${route.credential_source},
                      ${route.state}, ${route.attempt_id}, ${route.attempt_deadline_at}, ${route.reason}, ${route.updated_at})`
        );
        const originalPeerFor = instance.sessionPeerFor;
        let reconstructed: SandboxControlV2 | undefined;
        const restore = () => {
          if (reconstructed !== undefined) return reconstructed;
          reconstructed = new SandboxControlV2(state, instance.env);
          Object.assign(reconstructed, {
            createProviderAdapter: () => provider.adapter,
            provider: provider.adapter,
            sessionPeerFor: (ownerId: string, id: string) => {
              const peer = originalPeerFor(ownerId, id);
              if (peer === null) throw new Error('Missing real Session peer');
              return new Proxy(peer, {
                get(target, key) {
                  if (key === 'onRoute')
                    return async (update: ControlPlaneRouteUpdate) => {
                      if (
                        'reason' in update &&
                        update.reason === 'agent_restarted' &&
                        update.attemptId === attemptA.attemptId
                      ) {
                        retirementUpdates.push(update);
                        await notification;
                      }
                      return target.onRoute(update);
                    };
                  return Reflect.get(target, key);
                },
              });
            },
          });
          return reconstructed;
        };
        Object.setPrototypeOf(
          instance,
          Object.assign(Object.create(Object.getPrototypeOf(instance)), {
            deliver: (input: Parameters<SandboxControlV2['deliver']>[0]) =>
              restore().deliver(input),
            prepare: (input: Parameters<SandboxControlV2['prepare']>[0]) =>
              restore().prepare(input),
            status: (input: Parameters<SandboxControlV2['status']>[0]) => restore().status(input),
            alarm: () => restore().alarm(),
            fetch: (request: Request) => restore().fetch(request),
            getAllocationState: () => restore().getAllocationState(),
            webSocketMessage: (...args: Parameters<SandboxControlV2['webSocketMessage']>) =>
              restore().webSocketMessage(...args),
            webSocketClose: (...args: Parameters<SandboxControlV2['webSocketClose']>) =>
              restore().webSocketClose(...args),
            webSocketError: (...args: Parameters<SandboxControlV2['webSocketError']>) =>
              restore().webSocketError(...args),
          })
        );
      });
      if (oldState === 'preparing') {
        await runInDurableObject(sessionStub, instance => {
          const peer = instance.sandboxPeerFor(sandboxId);
          if (peer === null) throw new Error('Missing real Sandbox peer');
          instance.sandboxPeerFor = () =>
            new Proxy(peer, {
              get(target, key) {
                if (key === 'prepare')
                  return async (input: Parameters<typeof peer.prepare>[0]) => {
                    const view = await target.prepare(input);
                    await response;
                    return view;
                  };
                return Reflect.get(target, key);
              },
            });
        });
      }
      let wrapperB: FakeWrapper | undefined;
      try {
        await sessionStub.send(promptPayload('new-B'));
        const attemptB = (await sandboxStub.status({ sessionId })).view;
        if (attemptB.state !== 'preparing') throw new Error('Missing new attempt');
        expect(attemptB.attemptId).not.toBe(attemptA.attemptId);
        if (oldState === 'ready') {
          await expect(sessionStub.getSession()).resolves.toMatchObject({
            route: { attemptId: attemptB.attemptId },
          });
        } else {
          // The prepare response is withheld, so the fresh send must keep
          // `new-B` queued on the new attempt. Sandbox allocation progress
          // (creating, starting) may reach the session and clear the transport
          // recovery the ambiguous prepare scheduled, so recovery is not
          // required to persist; the message staying queued is the durable
          // ownership signal.
          expect(await messageStatus(sessionStub, 'new-B')).toBe('queued');
        }
        await waitFor(() => expect(retirementUpdates).toHaveLength(1));
        expect(retirementUpdates[0]).toEqual({
          state: oldState === 'ready' ? 'lost' : 'failed',
          attemptId: attemptA.attemptId,
          reason: 'agent_restarted',
        });
        releaseNotification();
        await sessionStub.onRoute(retirementUpdates[0]);
        expect(await messageStatus(sessionStub, 'new-B')).toBe('queued');
        await expect(sessionStub.getSession()).resolves.toMatchObject({
          route: { state: 'preparing', attemptId: attemptB.attemptId },
        });
        await runInDurableObject(sandboxStub, instance => instance.alarm());
        await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
        const replacement = provider.launchEnvs[1];
        wrapperB = await FakeWrapper.connect({
          sandboxId,
          credential: replacement.SANDBOX_CONTROL_CREDENTIAL,
        });
        await wrapperB.hello({
          wrapperId: 'wr_after_retirement',
          allocationId: replacement.CONTROL_PLANE_ALLOCATION_ID,
        });
        expect(await wrapperB.next()).toMatchObject({
          type: 'session.prepare',
          spec: { attemptId: attemptB.attemptId },
        });
        wrapperB.send({ type: 'session.ready', sessionId });
        expect(await wrapperB.nextSkipping(['worktree.snapshot'])).toMatchObject({
          type: 'session.prompt',
          payload: { messageId: 'new-B' },
        });
        wrapperB.send({
          type: 'session.outcome',
          sessionId,
          status: 'completed',
          lastMessageId: 'new-B',
        });
        await waitFor(async () =>
          expect(await messageStatus(sessionStub, 'new-B')).toBe('completed')
        );
        await runSessionAlarm(sessionStub);
        expect(await messageStatus(sessionStub, 'old-A')).toBe('failed');
        expect(await readMessageReason(sessionStub, 'old-A')).toBe('agent_restarted');
        expect(reports.filter(report => report.run.messageId === 'old-A')).toHaveLength(1);
        expect(reports.find(report => report.run.messageId === 'old-A')?.run).toMatchObject({
          status: 'failed',
          failureCode: 'wrapper_disconnected',
        });
        expect(reports.filter(report => report.run.messageId === 'new-B')).toHaveLength(1);
        expect(reports.find(report => report.run.messageId === 'new-B')?.run.status).toBe(
          'completed'
        );
        expect(callbacks.at(-1)?.payload).toMatchObject({
          messageId: 'new-B',
          status: 'completed',
        });
        const counts = [reports.length, callbacks.length];
        await sessionStub.send(promptPayload('old-A'));
        await sessionStub.onRoute(retirementUpdates[0]);
        await runSessionAlarm(sessionStub);
        expect([reports.length, callbacks.length]).toEqual(counts);
        for (let index = 0; index < 5; index++) {
          const frame = await wrapperB.next(50);
          if (frame === null) break;
          expect(frame.type).not.toBe('session.prompt');
          expect(frame.type).not.toBe('session.prepare');
        }
      } finally {
        releaseNotification();
        releaseResponse();
        wrapperA.close();
        wrapperB?.close();
      }
    },
    15_000
  );

  it.each(['progress', 'failed'] as const)(
    'preserves new-attempt %s notification facts when the real passive view omits them',
    async notification => {
      const sessionId = newSessionId();
      const sandboxId = unique('sbx__notification_facts');
      const provider = createFakeProvider();
      const sandboxStub = sandboxes.getByName(sandboxId);
      await runInDurableObject(sandboxStub, async instance => {
        await instance.getAllocationState();
        installFakeCredentialEnv(instance.env, createFakeCredentialBroker());
        Object.assign(instance, {
          createProviderAdapter: () => provider.adapter,
          provider: provider.adapter,
        });
      });
      const sessionName = sessionDoName(SESSION_OWNER_ID, sessionId);
      const sessionStub = sessions.getByName(sessionName);
      const registered = await sessionStub.registerSessionFromMetadata({
        metadata: parseSessionMetadata({
          metadataSchemaVersion: 2,
          identity: { sessionId, userId: SESSION_OWNER_ID, orgId: 'org_123' },
          auth: { kiloSessionId: kiloSessionId(), kilocodeToken: NATIVE_KILO_TOKEN },
          agent: { mode: 'code', model: 'test/model' },
          repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
          workspace: { sandboxId, sandboxProvider: 'cloudflare' },
          callback: { target: { url: 'https://callback.test/hook' } },
          lifecycle: { version: 1, timestamp: 1 },
        }),
        sandboxSelection: { provider: 'cloudflare' },
      });
      expect(registered).toEqual({ success: true });
      const reports: CloudAgentQueueReport[] = [];
      const callbacks: CallbackJob[] = [];
      await runInDurableObject(sessionStub, instance => {
        instance.env.CLOUD_AGENT_REPORT_QUEUE = {
          send: async (report: CloudAgentQueueReport) => {
            reports.push(report);
          },
        } as never;
        instance.env.CALLBACK_QUEUE = {
          send: async (job: CallbackJob) => {
            callbacks.push(job);
          },
        } as never;
      });
      await sessionStub.send(promptPayload('old-A'));
      await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
      const launch = provider.launchEnvs[0];
      const wrapper = await FakeWrapper.connect({
        sandboxId,
        credential: launch.SANDBOX_CONTROL_CREDENTIAL,
      });
      await wrapper.hello({
        wrapperId: 'wr_notification_facts',
        allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
      });
      expect(await wrapper.next()).toMatchObject({ type: 'session.prepare', spec: { sessionId } });
      const attemptA = (await sandboxStub.status({ sessionId })).view;
      if (attemptA.state !== 'preparing') throw new Error('Expected preparing attempt A');
      wrapper.send({ type: 'session.failed', sessionId, reason: 'workspace_setup_failed' });
      await waitFor(async () => expect(await messageStatus(sessionStub, 'old-A')).toBe('failed'));
      await runSessionAlarm(sessionStub);
      expect(reports).toHaveLength(1);
      expect(callbacks).toHaveLength(1);
      let releaseResponse!: () => void;
      const response = new Promise<void>(resolve => {
        releaseResponse = resolve;
      });
      await runInDurableObject(sessionStub, instance => {
        const peer = instance.sandboxPeerFor(sandboxId);
        if (peer === null) throw new Error('Missing real Sandbox peer');
        instance.sandboxPeerFor = () =>
          new Proxy(peer, {
            get(target, key) {
              if (key === 'prepare')
                return async (input: Parameters<typeof peer.prepare>[0]) => {
                  const view = await target.prepare(input);
                  await response;
                  return view;
                };
              return Reflect.get(target, key);
            },
          });
      });
      const stream = await connectStream(sessionName);
      try {
        const sentAt = Date.now();
        await sessionStub.send(promptPayload('retry-B'));
        expect(Date.now() - sentAt).toBeGreaterThanOrEqual(2_000);
        expect(Date.now() - sentAt).toBeLessThan(2_400);
        expect(await wrapper.next()).toMatchObject({
          type: 'session.prepare',
          spec: { sessionId },
        });
        const attemptB = (await sandboxStub.status({ sessionId })).view;
        if (attemptB.state !== 'preparing') throw new Error('Expected preparing attempt B');
        expect(attemptB.attemptId).not.toBe(attemptA.attemptId);
        expect(attemptB).toEqual({ state: 'preparing', attemptId: attemptB.attemptId });
        await expect(sessionStub.getSession()).resolves.toMatchObject({
          route: { state: 'failed', attemptId: attemptA.attemptId },
        });
        if (notification === 'progress') {
          wrapper.send({ type: 'session.progress', sessionId, step: 'clone' });
          await waitFor(async () => {
            const session = await sessionStub.getSession();
            expect(session).toMatchObject({ route: { attemptId: attemptB.attemptId } });
          });
          expect((await sandboxStub.status({ sessionId })).view).toEqual({
            state: 'preparing',
            attemptId: attemptB.attemptId,
          });
          await expect(sessionStub.getSession()).resolves.toMatchObject({
            route: { state: 'preparing', attemptId: attemptB.attemptId, step: 'clone' },
          });
          expect(await messageStatus(sessionStub, 'retry-B')).toBe('queued');
          const progress = preparingRows(await drainStream(stream));
          expect(progress).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ attemptId: attemptB.attemptId, step: 'cloning' }),
            ])
          );
        }
        wrapper.send({
          type: 'session.failed',
          sessionId,
          step: 'clone',
          reason: 'workspace_setup_failed',
          subtype: 'git_authentication_failed',
        });
        await waitFor(async () =>
          expect(await messageStatus(sessionStub, 'retry-B')).toBe('failed')
        );
        await runSessionAlarm(sessionStub);
        expect((await sandboxStub.status({ sessionId })).view).toEqual({
          state: 'failed',
          attemptId: attemptB.attemptId,
          reason: 'workspace_setup_failed',
        });
        expect(await readMessageReason(sessionStub, 'retry-B')).toBe('workspace_setup_failed');
        const retryReports = reports.filter(report => report.run.messageId === 'retry-B');
        expect(retryReports).toHaveLength(1);
        expect(retryReports[0]?.run.failureReason).toBe('source_control_authentication');
        expect(retryReports[0]?.run).toMatchObject({
          status: 'failed',
          failureStage: 'pre_dispatch',
          failureCode: 'workspace_setup_failed',
          workspaceFailureSubtype: 'git_authentication_failed',
          failureResponsibility: 'user',
          failureReason: 'source_control_authentication',
          diagnostic: { errorMessageRedacted: 'Repository authentication failed' },
        });
        await expect(sessionStub.getSession()).resolves.toMatchObject({
          route: {
            state: 'failed',
            attemptId: attemptB.attemptId,
            subtype: 'git_authentication_failed',
          },
        });
        expect(callbacks.filter(job => job.payload.messageId === 'retry-B')).toHaveLength(1);
        expect(callbacks.find(job => job.payload.messageId === 'retry-B')?.payload).toMatchObject({
          status: 'failed',
          errorMessage: 'Repository authentication failed',
          failureStage: 'pre_dispatch',
          failure: {
            stage: 'pre_dispatch',
            code: 'workspace_setup_failed',
            subtype: 'git_authentication_failed',
            message: 'Repository authentication failed',
          },
        });
        await sessionStub.onRoute({ state: 'ready', attemptId: attemptA.attemptId });
        await sessionStub.onRoute({
          state: 'failed',
          attemptId: attemptA.attemptId,
          reason: 'workspace_setup_failed',
          subtype: 'git_network_failed',
        });
        await sessionStub.onRoute({
          state: 'failed',
          attemptId: attemptB.attemptId,
          reason: 'workspace_setup_failed',
          subtype: 'git_authentication_failed',
        });
        await runSessionAlarm(sessionStub);
        expect(reports).toHaveLength(2);
        expect(callbacks).toHaveLength(2);
        expect(await messageStatus(sessionStub, 'old-A')).toBe('failed');
        expect(await messageStatus(sessionStub, 'retry-B')).toBe('failed');
      } finally {
        releaseResponse();
        stream.close();
        wrapper.close();
      }
    },
    15_000
  );

  it.each([
    ['insufficient_credits', 'billing_blocked', 'payment_required'],
    ['invalid_configuration', 'invalid_configuration', 'sandbox_connect_failed'],
  ] as const)(
    'settles known permanent %s promptly and recovers the next message',
    async (cause, reason, code) => {
      const sessionId = newSessionId();
      const sandboxId = unique('sbx__permanent');
      const provider = createFakeProvider();
      provider.failure = new ProviderCreationError(cause);
      const sandboxStub = sandboxes.getByName(sandboxId);
      await runInDurableObject(sandboxStub, async instance => {
        await instance.getAllocationState();
        installFakeCredentialEnv(instance.env, createFakeCredentialBroker());
        Object.assign(instance, {
          createProviderAdapter: () => provider.adapter,
          provider: provider.adapter,
        });
      });
      const sessionName = sessionDoName(SESSION_OWNER_ID, sessionId);
      const sessionStub = sessions.getByName(sessionName);
      await sessionStub.registerSessionFromMetadata({
        metadata: parseSessionMetadata({
          metadataSchemaVersion: 2,
          identity: { sessionId, userId: SESSION_OWNER_ID, orgId: 'org_123' },
          auth: { kiloSessionId: kiloSessionId(), kilocodeToken: NATIVE_KILO_TOKEN },
          agent: { mode: 'code', model: 'test/model' },
          repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
          workspace: { sandboxId, sandboxProvider: 'cloudflare' },
          callback: { target: { url: 'https://callback.test/hook' } },
          lifecycle: { version: 1, timestamp: 1 },
        }),
        sandboxSelection: { provider: 'cloudflare' },
      });
      const reports: CloudAgentQueueReport[] = [];
      const callbacks: CallbackJob[] = [];
      await runInDurableObject(sessionStub, instance => {
        instance.env.CLOUD_AGENT_REPORT_QUEUE = {
          send: async (report: CloudAgentQueueReport) => {
            reports.push(report);
          },
        } as never;
        instance.env.CALLBACK_QUEUE = {
          send: async (job: CallbackJob) => {
            callbacks.push(job);
          },
        } as never;
      });
      const stream = await connectStream(sessionName);
      const sentAt = Date.now();
      await sessionStub.send(promptPayload('m1'));
      await waitFor(async () => expect(await messageStatus(sessionStub, 'm1')).toBe('failed'), {
        timeout: 1_000,
      });
      expect(Date.now() - sentAt).toBeLessThan(2_000);
      expect(await readMessageReason(sessionStub, 'm1')).toBe(reason);
      const failedRoute = (await sandboxStub.status({ sessionId })).view;
      expect(failedRoute).toMatchObject({ state: 'failed', reason });
      const failed = await waitForStreamEvent(stream, 'cloud.message.failed');
      expect(failed.data).toMatchObject({
        messageId: 'm1',
        status: 'failed',
        reason,
        error: reason,
        accepted: false,
      });
      await runSessionAlarm(sessionStub);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.run).toMatchObject({
        status: 'failed',
        failureStage: 'pre_dispatch',
        failureCode: code,
      });
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]?.payload.status).toBe('failed');
      expect(callbacks[0]?.payload.errorMessage).toBe(
        cause === 'insufficient_credits'
          ? 'Sandbox billing requires additional credits'
          : 'Sandbox configuration is invalid or unsupported'
      );
      expect(provider.createCalls).toBe(1);
      await waitFor(async () =>
        expect((await sandboxStub.getAllocationState()).kind).toBe('stopped')
      );

      provider.failure = undefined;
      await sessionStub.send(promptPayload('m2'));
      await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
      const launch = provider.launchEnvs[0];
      const wrapper = await FakeWrapper.connect({
        sandboxId,
        credential: launch.SANDBOX_CONTROL_CREDENTIAL,
      });
      expect(
        await wrapper.hello({
          wrapperId: 'wr_recovered',
          allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
        })
      ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
      expect(await wrapper.next()).toMatchObject({ type: 'session.prepare', spec: { sessionId } });
      const recoveredRoute = (await sandboxStub.status({ sessionId })).view;
      if (failedRoute.state !== 'failed' || recoveredRoute.state !== 'preparing')
        throw new Error('Expected failed and recovered attempts');
      expect(recoveredRoute.attemptId).not.toBe(failedRoute.attemptId);
      wrapper.send({ type: 'session.ready', sessionId });
      expect(await wrapper.next()).toMatchObject({
        type: 'session.prompt',
        payload: { messageId: 'm2' },
      });
      wrapper.send({
        type: 'session.outcome',
        sessionId,
        status: 'completed',
        lastMessageId: 'm2',
      });
      await waitFor(async () => expect(await messageStatus(sessionStub, 'm2')).toBe('completed'));
      await runSessionAlarm(sessionStub);
      expect(await messageStatus(sessionStub, 'm1')).toBe('failed');
      expect(reports).toHaveLength(2);
      expect(callbacks).toHaveLength(2);
      expect(callbacks[1]?.payload.status).toBe('completed');
      stream.close();
      wrapper.close();
    }
  );

  it.each([
    new ProviderCreationError('stopping'),
    new ProviderCreationError('meter_unavailable'),
    new Error('insufficient credits invalid configuration'),
    ...[400, 402, 409, 429, 500, 503].map(
      status => new VercelSandboxRestError('request_failed', 'create', status)
    ),
  ])('retains queued work and its attempt across transient %s', async failure => {
    const sessionId = newSessionId();
    const sandboxId = unique('sbx__transient');
    const provider = createFakeProvider();
    provider.failure = failure;
    const sandboxStub = sandboxes.getByName(sandboxId);
    await runInDurableObject(sandboxStub, async instance => {
      await instance.getAllocationState();
      installFakeCredentialEnv(instance.env, createFakeCredentialBroker());
      Object.assign(instance, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
      });
    });
    const sessionStub = sessions.getByName(sessionDoName(SESSION_OWNER_ID, sessionId));
    await sessionStub.registerSession(registration(sandboxId, sessionId));
    const sentAt = Date.now();
    await sessionStub.send(promptPayload('m1'));
    const retryBy = Date.now() + CONTROL_PLANE_TIMERS.sandbox.providerCreateRetryMs;
    await waitFor(async () => {
      const allocation = await sandboxStub.getAllocationState();
      expect(allocation.kind).toBe('creating');
      expect(allocation.createDeadlineAt).toBeGreaterThanOrEqual(sentAt + 10_000);
      expect(allocation.createDeadlineAt).toBeLessThanOrEqual(retryBy);
    });
    const before = await runInDurableObject(sandboxStub, (_instance, state) =>
      drizzle(state.storage).select().from(routesTable).get()
    );
    expect(await messageStatus(sessionStub, 'm1')).toBe('queued');
    expect(provider.createCalls).toBe(1);
    provider.failure = undefined;
    await runInDurableObject(sandboxStub, async (instance, state) => {
      drizzle(state.storage)
        .update(allocationTable)
        .set({ create_deadline_at: Date.now() - 1 })
        .where(eq(allocationTable.id, 'current'))
        .run();
      await instance.alarm();
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const after = await runInDurableObject(sandboxStub, (_instance, state) =>
      drizzle(state.storage).select().from(routesTable).get()
    );
    expect(after?.attempt_id).toBe(before?.attempt_id);
    expect(after?.attempt_deadline_at).toBe(before?.attempt_deadline_at);
    const launch = provider.launchEnvs[0];
    const wrapper = await FakeWrapper.connect({
      sandboxId,
      credential: launch.SANDBOX_CONTROL_CREDENTIAL,
    });
    await wrapper.hello({
      wrapperId: 'wr_transient',
      allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
    });
    expect(await wrapper.next()).toMatchObject({ type: 'session.prepare' });
    wrapper.send({ type: 'session.ready', sessionId });
    expect(await wrapper.next()).toMatchObject({
      type: 'session.prompt',
      payload: { messageId: 'm1' },
    });
    wrapper.send({ type: 'session.outcome', sessionId, status: 'completed', lastMessageId: 'm1' });
    await waitFor(async () => expect(await messageStatus(sessionStub, 'm1')).toBe('completed'));
    expect(provider.createCalls).toBe(2);
    wrapper.close();
  });

  it('completes a cold message and streams queued, sent, and completed', async () => {
    const sessionId = newSessionId();
    const sandboxId = unique('sbx__session_v2');
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const sandboxStub = sandboxes.getByName(sandboxId);
    await runInDurableObject(sandboxStub, async instance => {
      await instance.getAllocationState();
      installFakeCredentialEnv(instance.env, broker);
      Object.assign(instance, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
      });
    });

    // The Worker and the Sandbox DO both address the Session DO by
    // `ownerId:sessionId` (spec §3); stream routing here uses the same name.
    const sessionName = sessionDoName(SESSION_OWNER_ID, sessionId);
    const sessionStub = sessions.getByName(sessionName);
    await sessionStub.registerSession(registration(sandboxId, sessionId));

    const stream = await connectStream(sessionName);
    await sessionStub.send(promptPayload('m1'));
    await waitForStreamEvent(stream, 'cloud.message.queued');

    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const launchEnv = provider.launchEnvs[0];
    if (!launchEnv) throw new Error('provider.launch was not called');
    const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
    const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
    if (!credential || !allocationId) throw new Error('launch environment is missing identity');

    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    const helloReply = await wrapper.hello({ wrapperId: 'wr_1', allocationId });
    expect(helloReply).toEqual({
      type: 'welcome',
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    });

    const prepareFrame = await wrapper.next();
    expect(prepareFrame?.type).toBe('session.prepare');
    wrapper.send({ type: 'session.ready', sessionId });

    await waitForStreamEvent(stream, 'cloud.message.sent');
    const promptFrame = await wrapper.next();
    expect(promptFrame).toMatchObject({ type: 'session.prompt', sessionId });
    await waitFor(async () => expect(await messageStatus(sessionStub, 'm1')).toBe('running'));
    // Addressed as `ownerId:sessionId`, the public session id is still bare.
    await expect(sessionStub.getSession()).resolves.toMatchObject({
      type: 'found',
      sessionId,
    });

    wrapper.send({ type: 'session.outcome', sessionId, status: 'completed', lastMessageId: 'm1' });
    await waitForStreamEvent(stream, 'cloud.message.completed');
    await waitFor(async () => expect(await messageStatus(sessionStub, 'm1')).toBe('completed'));

    // Replay after reconnect: the persisted terminal event arrives again.
    stream.close();
    const reconnected = await connectStream(sessionName);
    const replayed = await waitForStreamEvent(reconnected, 'cloud.message.completed');
    expect(replayed.data).toMatchObject({ messageId: 'm1', status: 'completed' });
    reconnected.close();
  });

  it('delivers on the old grant and retries the re-issue on the next send when deliver cannot re-issue credentials', async () => {
    const sessionId = newSessionId();
    const sandboxId = unique('sbx__session_v2');
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const sandboxStub = sandboxes.getByName(sandboxId);
    // The default test provider is not Vercel, so the real policy refresh is a
    // no-op. Force the credential-policy outcome this test needs.
    let policyOk = true;
    await runInDurableObject(sandboxStub, async instance => {
      await instance.getAllocationState();
      installFakeCredentialEnv(instance.env, broker);
      Object.assign(instance, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
        refreshVercelNetworkPolicy: async () => policyOk,
      });
    });

    const sessionName = sessionDoName(SESSION_OWNER_ID, sessionId);
    const sessionStub = sessions.getByName(sessionName);
    await sessionStub.registerSession(registration(sandboxId, sessionId));

    await sessionStub.send(promptPayload('m1'));
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const launchEnv = provider.launchEnvs[0];
    if (!launchEnv) throw new Error('provider.launch was not called');
    const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
    const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
    if (!credential || !allocationId) throw new Error('launch environment is missing identity');

    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    await wrapper.hello({ wrapperId: 'wr_1', allocationId });
    expect((await wrapper.next())?.type).toBe('session.prepare');
    wrapper.send({ type: 'session.ready', sessionId });
    await waitFor(async () => expect(await messageStatus(sessionStub, 'm1')).toBe('running'));
    await wrapper.next();

    // Bring the grant inside the re-issue window, then fail the policy while a
    // second message is queued behind the ready route.
    await setGrantExpiry(
      sandboxStub,
      sessionId,
      Date.now() + CONTROL_PLANE_TIMERS.sandbox.credentialGrantReissueBelowMs / 2
    );
    const aliasBefore = await readGrantAlias(sandboxStub, sessionId);
    const framesBefore = wrapper.receivedFrames();
    policyOk = false;
    await sessionStub.send(promptPayload('m2'));

    // The still-due old grant carries m2: no credentials frame, the prompt is
    // delivered, and the route stays ready to retry the re-issue.
    await waitFor(async () => expect(await messageStatus(sessionStub, 'm2')).toBe('running'));
    expect(await wrapper.next()).toMatchObject({ type: 'session.prompt', sessionId });
    expect(wrapper.receivedFrames()).toBe(framesBefore + 1);
    expect(await sandboxStub.status({ sessionId })).toEqual({
      sessionId,
      view: { state: 'ready', attemptId: expect.any(String) },
    });
    expect(await readGrantAlias(sandboxStub, sessionId)).toBe(aliasBefore);

    // The next send retries the re-issue and sends the fresh frame first.
    policyOk = true;
    await sessionStub.send(promptPayload('m3'));
    await waitFor(async () => expect(await messageStatus(sessionStub, 'm3')).toBe('running'));
    expect((await wrapper.next())?.type).toBe('session.credentials');
    expect((await readGrantAlias(sandboxStub, sessionId)) === aliasBefore).toBe(true);
    expect(await wrapper.next()).toMatchObject({ type: 'session.prompt', sessionId });
  });

  it('fails a queued message promptly when deliver cannot re-issue credentials and the old grant expired', async () => {
    const sessionId = newSessionId();
    const sandboxId = unique('sbx__session_v2');
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const sandboxStub = sandboxes.getByName(sandboxId);
    // The default test provider is not Vercel, so the real policy refresh is a
    // no-op. Force the credential-policy outcome this test needs.
    let policyOk = true;
    await runInDurableObject(sandboxStub, async instance => {
      await instance.getAllocationState();
      installFakeCredentialEnv(instance.env, broker);
      Object.assign(instance, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
        refreshVercelNetworkPolicy: async () => policyOk,
      });
    });

    const sessionName = sessionDoName(SESSION_OWNER_ID, sessionId);
    const sessionStub = sessions.getByName(sessionName);
    await sessionStub.registerSession(registration(sandboxId, sessionId));

    await sessionStub.send(promptPayload('m1'));
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const launchEnv = provider.launchEnvs[0];
    if (!launchEnv) throw new Error('provider.launch was not called');
    const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
    const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
    if (!credential || !allocationId) throw new Error('launch environment is missing identity');

    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    await wrapper.hello({ wrapperId: 'wr_1', allocationId });
    expect((await wrapper.next())?.type).toBe('session.prepare');
    wrapper.send({ type: 'session.ready', sessionId });
    await waitFor(async () => expect(await messageStatus(sessionStub, 'm1')).toBe('running'));
    await wrapper.next();

    // The re-issue window is only entered while the grant is still due; push it
    // past expiry so the failed policy has no usable grant to fall back on.
    await setGrantExpiry(sandboxStub, sessionId, Date.now() - 1);
    policyOk = false;
    await sessionStub.send(promptPayload('m2'));

    // The policy failure fails the route and releases the queued message with
    // the real reason now, without running the queued backstop.
    expect(await messageStatus(sessionStub, 'm2')).toBe('failed');
    expect(await readMessageReason(sessionStub, 'm2')).toBe('workspace_setup_failed');
    expect(await readAlarm(sessionStub)).toBeNull();
  });

  it('fails a queued message promptly on any re-issue failure once the old grant expired', async () => {
    const sessionId = newSessionId();
    const sandboxId = unique('sbx__session_v2');
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const sandboxStub = sandboxes.getByName(sandboxId);
    await runInDurableObject(sandboxStub, async instance => {
      await instance.getAllocationState();
      installFakeCredentialEnv(instance.env, broker);
      Object.assign(instance, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
      });
    });

    const sessionName = sessionDoName(SESSION_OWNER_ID, sessionId);
    const sessionStub = sessions.getByName(sessionName);
    await sessionStub.registerSession(registration(sandboxId, sessionId));

    await sessionStub.send(promptPayload('m1'));
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const launchEnv = provider.launchEnvs[0];
    if (!launchEnv) throw new Error('provider.launch was not called');
    const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
    const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
    if (!credential || !allocationId) throw new Error('launch environment is missing identity');

    const wrapper = await FakeWrapper.connect({ sandboxId, credential });
    await wrapper.hello({ wrapperId: 'wr_1', allocationId });
    expect((await wrapper.next())?.type).toBe('session.prepare');
    wrapper.send({ type: 'session.ready', sessionId });
    await waitFor(async () => expect(await messageStatus(sessionStub, 'm1')).toBe('running'));
    await wrapper.next();

    // A plain issuance failure is not a provider policy failure, but with an
    // expired old grant it is just as unrecoverable: the route must fail now
    // instead of leaving the queued message for the queued backstop.
    await setGrantExpiry(sandboxStub, sessionId, Date.now() - 1);
    await runInDurableObject(sandboxStub, async instance => {
      Object.assign(instance, {
        issueRouteGrant: async () => {
          throw new Error('token service unavailable');
        },
      });
    });
    await sessionStub.send(promptPayload('m2'));

    expect(await messageStatus(sessionStub, 'm2')).toBe('failed');
    expect(await readMessageReason(sessionStub, 'm2')).toBe('workspace_setup_failed');
    expect(await readAlarm(sessionStub)).toBeNull();
  });
});
