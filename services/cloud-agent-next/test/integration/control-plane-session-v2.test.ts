import { env, evictAllDurableObjects, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { routes as routesTable } from '../../src/control-plane/sandbox/sqlite-schema.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
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
import type {
  ControlPlanePromptPayload,
  ControlPlaneRouteSpec,
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
    const grant = JSON.parse(rows[0]?.grant ?? '{}') as Record<string, unknown>;
    await db
      .update(routesTable)
      .set({ grant: JSON.stringify({ ...grant, expiresAt }) })
      .where(eq(routesTable.session_id, sessionId));
  });
}

async function readGrantAlias(
  stub: DurableObjectStub<SandboxControlV2>,
  sessionId: string
): Promise<string | null> {
  return runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
    const grant = JSON.parse(rows[0]?.grant ?? '{}') as { kilo?: { alias?: string } };
    return grant.kilo?.alias ?? null;
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
      const ref = `mem_${intent.intentId}`;
      provider.refs.push(ref);
      return { providerRef: ref };
    },
    async launch(_ref, launchEnv) {
      provider.launchEnvs.push({ ...launchEnv });
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

    await stub.onRoute({ state: 'lost', attemptId: peer.attemptId, reason: 'connection_lost' });
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

    await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));
    expect(await messageStatus(stub, 'm1')).toBe('running');
    expect(peer.deliverCalls).toHaveLength(1);
    expect(peer.deliverCalls[0]?.messages.map(message => message.messageId)).toEqual(['m1', 'm2']);
  });

  it('accepts a message when deliver outlives the old 2 s deadline', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    peer.deliverDelayMs = 2_500;

    const started = Date.now();
    await stub.send(promptPayload('m1'));

    // The old bounded deadline would have given up at 2 s and left it queued.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    expect(await messageStatus(stub, 'm1')).toBe('running');
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
    peer.prepareView = peer.view('reconnecting');
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

  it('renders wrapper setup output as a preparing step_output', async () => {
    const { sessionId, stub, peer } = await setup();
    const stream = await connectStream(sessionId);
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
    await stub.onRoute({ state: 'preparing', step: 'setup', attemptId: peer.attemptId });
    await stub.onEvents({
      events: [
        { type: 'session.setup.output', properties: { command: 1, output: 'npm install\n' } },
      ],
    });

    const messages = await drainStream(stream);
    const output = messages.find(
      message =>
        message.streamEventType === 'preparing' &&
        (message.data as { action?: string }).action === 'step_output'
    );
    expect(output?.data).toMatchObject({
      action: 'step_output',
      step: 'setup_commands',
      output: 'npm install\n',
    });
    // The rendered preparing row replaces the raw wrapper event.
    expect(messages.some(message => message.streamEventType === 'kilocode')).toBe(false);
    stream.close();
  });

  it('derives the connected cloud status from the persisted route view after eviction', async () => {
    const { sessionId, stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(promptPayload('m1'));
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
    expect(helloReply).toEqual({ type: 'welcome', protocolVersion: 2 });

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
    expect(await readGrantAlias(sandboxStub, sessionId)).not.toBe(aliasBefore);
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
    // the real reason now, without running the 20-minute backstop.
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
    // instead of leaving the queued message for the 20-minute backstop.
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
