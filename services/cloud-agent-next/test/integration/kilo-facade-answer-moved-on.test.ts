import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import type * as RuntimeAuthorizationPersistence from '../../src/session/runtime-authorization-persistence.js';
import type * as SessionAccessModule from '../../src/session-access.js';
import { createMessageId } from '../../src/session/message-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import type { ControlPlanePromptPayload } from '../../src/shared/control-plane-protocol.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';
import {
  clearTestSessionIngestState,
  writeTestSessionIngestState,
} from './helpers/session-ingest-double.js';
import { waitFor } from './wait-for.js';

// The hoisted factory below reads these, so the payer-scope double is in place
// for the facade Durable Object's module graph from its first import.
const fixture = vi.hoisted(() => {
  const kiloSessionId = `ses_${'answerMovedOnSett1edTurn'.padEnd(26, '0')}`;
  return {
    userId: 'user_answer_moved_on',
    organizationId: '11111111-2222-4333-8444-555555555555',
    kiloSessionId,
    cloudAgentSessionId: 'workspace_40000000-0000-4000-8000-000000000001',
    publicDirectory: `/cloud-agent/sessions/${kiloSessionId}`,
  };
});

const USER_ID = fixture.userId;
const ORG_ID = fixture.organizationId;
const kiloSessionId = fixture.kiloSessionId;
const cloudAgentSessionId = fixture.cloudAgentSessionId;
const QUESTION_ID = 'q_1';

/**
 * The test worker binds no HYPERDRIVE, so the payer-scope read has no database
 * to consult. The double returns the scope a session-access gate resolves, which
 * is what the tRPC answer routes hand their preflight.
 */
vi.mock('../../src/session-access.js', async importOriginal => ({
  ...(await importOriginal<typeof SessionAccessModule>()),
  requireCurrentSessionAccess: async () => ({
    kiloSessionId,
    organizationId: ORG_ID,
  }),
}));

/**
 * The catalogue read the answer preflights runs through the Session DO's token
 * renewal, which needs a stored authorization this fixture does not carry. The
 * seam returns the bearer the outbound double below answers, so the catalogue
 * request itself stays real.
 */
vi.mock('../../src/session/runtime-authorization-persistence.js', async importOriginal => {
  const actual = await importOriginal<typeof RuntimeAuthorizationPersistence>();
  return {
    ...actual,
    renewStoredRuntimeAuthorization: async () => 'test-token',
  };
});

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;

// The test worker's `env` loses the DO export class; assert the binding once,
// named, so `sessions` is typed where it is used.
const testEnv = env as unknown as { SANDBOX_SESSION: SessionNamespace };
const sessions = testEnv.SANDBOX_SESSION;

/**
 * The facade runs the payer and model preflight before the Session DO admits a
 * settled answer's continuation. The double below holds the payer read and
 * answers the catalogue read; the facade, both Durable Objects and the durable
 * queue all run for real.
 *
 * The hold is a promise this facade object owns, resolved by another
 * `runInDurableObject` call: a promise never crosses the boundary, only the
 * resolver call and the recorded counters.
 */
type FacadeFetchScope = {
  fetch: typeof fetch;
  __answerMovedOnOriginalFetch?: typeof fetch;
  __answerMovedOnRequests?: string[];
  __answerMovedOnBalanceArrivals?: number;
  __answerMovedOnBalanceGate?: { promise: Promise<void>; resolve: () => void };
};

function facadeStub() {
  return env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(USER_ID));
}

function inFacade<T>(read: (scope: FacadeFetchScope) => T): Promise<T> {
  return runInDurableObject(facadeStub(), () => read(globalThis as unknown as FacadeFetchScope));
}

async function installBackendResponder(): Promise<{
  balanceArrivals: () => Promise<number>;
  requests: () => Promise<string[]>;
  releaseBalance: () => Promise<void>;
  restore: () => Promise<void>;
}> {
  await runInDurableObject(facadeStub(), () => {
    const scope = globalThis as unknown as FacadeFetchScope;
    scope.__answerMovedOnOriginalFetch ??= scope.fetch;
    scope.__answerMovedOnRequests = [];
    scope.__answerMovedOnBalanceArrivals = 0;
    scope.__answerMovedOnBalanceGate = Promise.withResolvers<void>();
    const gate = scope.__answerMovedOnBalanceGate;
    scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      scope.__answerMovedOnRequests?.push(url.pathname);
      if (url.pathname.endsWith('/balance')) {
        scope.__answerMovedOnBalanceArrivals = (scope.__answerMovedOnBalanceArrivals ?? 0) + 1;
        await gate.promise;
        return Response.json({ balance: 20, isDepleted: false });
      }
      if (url.pathname.endsWith('/models/validate')) return Response.json({ valid: true });
      throw new Error(`unexpected outbound fetch ${url.origin}${url.pathname}`);
    };
  });
  return {
    balanceArrivals: () => inFacade(scope => scope.__answerMovedOnBalanceArrivals ?? 0),
    requests: () => inFacade(scope => [...(scope.__answerMovedOnRequests ?? [])]),
    releaseBalance: async () => {
      await inFacade(scope => scope.__answerMovedOnBalanceGate?.resolve());
    },
    restore: async () => {
      await inFacade(scope => {
        scope.__answerMovedOnBalanceGate?.resolve();
        if (scope.__answerMovedOnOriginalFetch !== undefined) {
          scope.fetch = scope.__answerMovedOnOriginalFetch;
          delete scope.__answerMovedOnOriginalFetch;
        }
        delete scope.__answerMovedOnRequests;
        delete scope.__answerMovedOnBalanceArrivals;
        delete scope.__answerMovedOnBalanceGate;
      });
    },
  };
}

/** A token whose claims carry the runtime authorization registration expects. */
function runtimeAuthorizedKiloToken(): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    runtimeAuthorization: { id: 'ra_answer_moved_on' },
  })}.sig`;
}

function metadata(input: { sandboxId: string }) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: cloudAgentSessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId, kilocodeToken: runtimeAuthorizedKiloToken() },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'git', url: 'https://github.com/acme/widgets.git', platform: 'github' },
    workspace: {
      branchName: 'kilo/answer-moved-on',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare-containers',
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

/** A registered hosted session whose sandbox transport is a recording peer. */
async function registerColdSession(): Promise<{
  stub: DurableObjectStub<SandboxSessionV2>;
  peer: FakeSandboxPeer;
}> {
  const stub = sessions.getByName(sessionDoName(USER_ID, cloudAgentSessionId));
  const peer = new FakeSandboxPeer();
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => peer;
  });
  const created = await stub.registerSessionFromMetadata({
    metadata: metadata({ sandboxId: await generateSandboxId(cloudAgentSessionId) }),
    sandboxSelection: { provider: 'cloudflare-containers' },
  });
  if (created.success !== true) {
    throw new Error(`session registration failed: ${JSON.stringify(created)}`);
  }
  return { stub, peer };
}

function promptPayload(
  messageId: string,
  prompt: string,
  model = 'test/model'
): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt },
    agent: { mode: 'code', model },
  };
}

function seedFacadeRoot(): Promise<void> {
  return runInDurableObject(facadeStub(), async (_instance, state) => {
    await writeTestSessionIngestState(state.storage, {
      roots: [{ kiloSessionId, cloudAgentSessionId, title: 'answer moved on' }],
    });
  });
}

function clearFacadeRoots(): Promise<void> {
  return runInDurableObject(facadeStub(), async (_instance, state) => {
    await clearTestSessionIngestState(state.storage);
  });
}

function postAnswer(): Promise<Response> {
  const url = `http://worker.test/kilo-test/kilo/question/${QUESTION_ID}/reply?userId=${USER_ID}&directory=${encodeURIComponent(fixture.publicDirectory)}`;
  return SELF.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: [['Blue']] }),
  });
}

/** One turn that ran, settled, and asked a question the settlement left waiting. */
async function settleTurnAndAsk(
  stub: DurableObjectStub<SandboxSessionV2>,
  peer: FakeSandboxPeer
): Promise<string> {
  const messageId = createMessageId();
  await expect(stub.send(promptPayload(messageId, 'start'))).resolves.toEqual({ type: 'ok' });
  peer.prepareView = peer.view('ready');
  await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });
  await waitFor(async () => {
    const live = await stub.getSession();
    if (live.type !== 'found') throw new Error('Session disappeared');
    expect(live.messages.map(message => message.state)).toEqual(['accepted']);
  });
  await stub.onOutcome({
    sessionId: cloudAgentSessionId,
    status: 'completed',
    lastMessageId: messageId,
  });
  await stub.onEvents({ events: [{ type: 'question.asked', properties: { id: QUESTION_ID } }] });
  return messageId;
}

/** One turn still live on the route that asks a question nothing answered yet. */
async function startLiveTurnAndAsk(
  stub: DurableObjectStub<SandboxSessionV2>,
  peer: FakeSandboxPeer
): Promise<void> {
  await expect(stub.send(promptPayload(createMessageId(), 'start'))).resolves.toEqual({
    type: 'ok',
  });
  peer.prepareView = peer.view('ready');
  await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });
  await waitFor(async () => {
    const live = await stub.getSession();
    if (live.type !== 'found') throw new Error('Session disappeared');
    expect(live.messages.map(message => message.state)).toEqual(['accepted']);
  });
  await stub.onEvents({ events: [{ type: 'question.asked', properties: { id: QUESTION_ID } }] });
}

afterEach(async () => {
  await clearFacadeRoots().catch(() => undefined);
  await reset();
});

describe('facade answer for a session that moved on', { timeout: 30_000 }, () => {
  it('refuses with the retryable answer error when the session moves on mid-preflight', async () => {
    const { stub, peer } = await registerColdSession();
    await seedFacadeRoot();
    const backend = await installBackendResponder();
    try {
      const settledMessageId = await settleTurnAndAsk(stub, peer);
      // The second prompt stays queued: this case is a changed last intent, not
      // a live turn taking the reply.
      peer.deliverResult = 'not_ready';

      const answered = postAnswer();

      // The answer RPC already built its continuation from the settled turn, and
      // the route now waits on the payer read.
      await waitFor(async () => expect(await backend.balanceArrivals()).toBe(1));

      // A prompt with a different model is sent inside that window, so admission
      // rebuilds an intent that differs from the one that was preflighted.
      const movedOnMessageId = createMessageId();
      await expect(
        stub.send(promptPayload(movedOnMessageId, 'start elsewhere', 'test/other-model'))
      ).resolves.toEqual({ type: 'ok' });

      await backend.releaseBalance();
      const response = await answered;

      expect(response.status).toBe(409);
      expect(response.headers.get('retry-after')).toBe('1');
      const body = (await response.json()) as { error: string; message: string };
      expect(body).toEqual({
        error: 'KILO_ANSWER_RETRY_REQUIRED',
        message: 'The session moved on; send the answer again',
      });
      // A retry is reported distinctly from an unavailable interaction.
      expect(body.error).not.toBe('KILO_INTERACTION_UNAVAILABLE');

      // The interaction still waits, and the reply admitted no turn of its own.
      await expect(stub.getPendingInteractions()).resolves.toMatchObject({
        questions: [{ id: QUESTION_ID }],
      });
      const snapshot = await stub.getSession();
      if (snapshot.type !== 'found') throw new Error('Session disappeared');
      expect(snapshot.messages.map(message => message.messageId)).toEqual([
        settledMessageId,
        movedOnMessageId,
      ]);
      expect(snapshot.messages.some(message => message.state === 'accepted')).toBe(false);

      // The refusal came from admission, not from a preflight that never ran:
      // the balance read happened, and the model read followed it.
      const issued = await backend.requests();
      expect(issued.filter(path => path.endsWith('/balance'))).toHaveLength(1);
      const balance = issued.findIndex(path => path.endsWith('/balance'));
      const validate = issued.findIndex(path => path.endsWith('/models/validate'));
      expect(validate).toBeGreaterThan(balance);
    } finally {
      await backend.restore();
    }
  });

  it('refuses with the retryable answer error when the live route cannot take the reply', async () => {
    const { stub, peer } = await registerColdSession();
    await seedFacadeRoot();
    const answer = peer.answer.bind(peer);
    try {
      await startLiveTurnAndAsk(stub, peer);
      // The live path takes the reply in the Session DO and reads no payer, so
      // only the peer forward is replaced here.
      await runInDurableObject(stub, () => {
        Object.assign(peer, { answer: async () => 'not_connected' });
      });

      const response = await postAnswer();

      expect(response.status).toBe(409);
      expect(response.headers.get('retry-after')).toBe('1');
      await expect(response.json()).resolves.toEqual({
        error: 'KILO_ANSWER_RETRY_REQUIRED',
        message: 'The session moved on; send the answer again',
      });
      // The interaction still waits, so the same reply is admissible again.
      await expect(stub.getPendingInteractions()).resolves.toMatchObject({
        questions: [{ id: QUESTION_ID }],
      });
    } finally {
      await runInDurableObject(stub, () => {
        peer.answer = answer;
      });
    }
  });

  it('keeps the terminal answer error when a runtime event already resolved the interaction', async () => {
    const { stub, peer } = await registerColdSession();
    await seedFacadeRoot();
    await startLiveTurnAndAsk(stub, peer);
    // The runtime answered the question itself while the turn stayed live, so
    // nothing waits on this reply any more.
    await stub.onEvents({
      events: [{ type: 'question.replied', properties: { requestID: QUESTION_ID } }],
    });

    const response = await postAnswer();

    // A resolved interaction stays terminal: no retry header, no retryable code.
    expect(response.status).toBe(409);
    expect(response.headers.get('retry-after')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_INTERACTION_UNAVAILABLE',
      message: 'The session does not wait on this interaction',
    });
    await expect(stub.getPendingInteractions()).resolves.toEqual({
      questions: [],
      permissions: [],
    });
  });
});
