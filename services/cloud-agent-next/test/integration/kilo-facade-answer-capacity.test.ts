import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { QUEUED_MESSAGE_LIMIT } from '../../src/control-plane/session/messages.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { createMessageId } from '../../src/session/message-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import type { ControlPlanePromptPayload } from '../../src/shared/control-plane-protocol.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';
import {
  clearTestSessionIngestState,
  writeTestSessionIngestState,
} from './helpers/session-ingest-double.js';
import { waitFor } from './wait-for.js';

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;

const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_answer_capacity';
const ORG_ID = '11111111-2222-4333-8444-555555555555';

const kiloSessionId = `ses_${'answerCapacitySett1ed'.padEnd(26, '0')}`;
const cloudAgentSessionId = 'workspace_30000000-0000-4000-8000-000000000002';
const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;

/**
 * The question reply route answers through the Session DO's answer path. A
 * settled asking turn makes the reply a new turn, so the queue capacity gate
 * runs before the payer balance read. This harness keeps the facade, both
 * Durable Objects and the durable queue real, and records every outbound
 * backend call so a leaked balance read is observable.
 */
type FetchScope = {
  fetch: typeof fetch;
  __answerCapacityOriginalFetch?: typeof fetch;
  __answerCapacityRequests?: string[];
};

function facadeStub() {
  return env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(USER_ID));
}

async function installBackendResponder(): Promise<{
  release: () => Promise<void>;
  requests: () => Promise<string[]>;
}> {
  const facade = facadeStub();
  await runInDurableObject(facade, () => {
    const scope = globalThis as unknown as FetchScope;
    scope.__answerCapacityOriginalFetch ??= scope.fetch;
    scope.__answerCapacityRequests = [];
    scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      scope.__answerCapacityRequests?.push(url.pathname);
      if (url.pathname.endsWith('/balance')) {
        return Response.json({ balance: 20, isDepleted: false });
      }
      if (url.pathname.endsWith('/models/validate')) return Response.json({ valid: true });
      throw new Error(`unexpected outbound fetch ${url.origin}${url.pathname}`);
    };
  });
  return {
    release: async () => {
      await runInDurableObject(facade, () => {
        const scope = globalThis as unknown as FetchScope;
        if (scope.__answerCapacityOriginalFetch !== undefined) {
          scope.fetch = scope.__answerCapacityOriginalFetch;
          delete scope.__answerCapacityOriginalFetch;
        }
        delete scope.__answerCapacityRequests;
      });
    },
    requests: () =>
      runInDurableObject(facade, () => {
        const scope = globalThis as unknown as FetchScope;
        return [...(scope.__answerCapacityRequests ?? [])];
      }),
  };
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
    auth: { kiloSessionId, kilocodeToken: 'test-token' },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'git', url: 'https://github.com/acme/widgets.git', platform: 'github' },
    workspace: {
      branchName: 'kilo/answer-capacity',
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

function promptPayload(messageId: string, prompt: string): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt },
    agent: { mode: 'code', model: 'test/model' },
  };
}

function seedFacadeRoot(): Promise<void> {
  return runInDurableObject(facadeStub(), async (_instance, state) => {
    await writeTestSessionIngestState(state.storage, {
      roots: [{ kiloSessionId, cloudAgentSessionId, title: 'answer capacity' }],
    });
  });
}

function clearFacadeRoots(): Promise<void> {
  return runInDurableObject(facadeStub(), async (_instance, state) => {
    await clearTestSessionIngestState(state.storage);
  });
}

function answerUrl(): string {
  return `http://worker.test/kilo-test/kilo/question/q_1/reply?userId=${USER_ID}&directory=${encodeURIComponent(publicDirectory)}`;
}

function postAnswer(): Promise<Response> {
  return SELF.fetch(answerUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: [['Blue']] }),
  });
}

/** Fills the pending queue and asks a question the asking turn already settled. */
async function fillQueueAndAsk(stub: DurableObjectStub<SandboxSessionV2>): Promise<string[]> {
  const sent: string[] = [];
  for (let index = 0; index < QUEUED_MESSAGE_LIMIT; index += 1) {
    const messageId = createMessageId();
    sent.push(messageId);
    await stub.send(promptPayload(messageId, `start ${index}`));
  }
  await stub.onEvents({ events: [{ type: 'question.asked', properties: { id: 'q_1' } }] });
  return sent;
}

function messageStates(states: readonly string[], expected: string): boolean {
  return states.every(state => state === expected);
}

afterEach(async () => {
  await clearFacadeRoots().catch(() => undefined);
  await reset();
});

describe('facade answer capacity', { timeout: 30_000 }, () => {
  it('refuses a question reply for capacity with the retryable prompt error', async () => {
    const { stub } = await registerColdSession();
    await seedFacadeRoot();
    const backend = await installBackendResponder();
    try {
      const sent = await fillQueueAndAsk(stub);

      const response = await postAnswer();
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({ error: 'KILO_PROMPT_QUEUE_FULL' });

      // The capacity gate runs before any payer balance read.
      const issued = await backend.requests();
      expect(issued.filter(path => path.endsWith('/balance'))).toHaveLength(0);
      expect(issued.filter(path => path.endsWith('/models/validate'))).toHaveLength(0);

      // The interaction stays answerable, and the reply was not queued.
      await expect(stub.getPendingInteractions()).resolves.toMatchObject({
        questions: [{ id: 'q_1' }],
      });
      const snapshot = await stub.getSession();
      if (snapshot.type !== 'found') throw new Error('Session disappeared');
      expect(snapshot.messages.map(message => message.messageId)).toEqual(sent);
    } finally {
      await backend.release();
    }
  });

  it('keeps the reply pending after a capacity refusal', async () => {
    const { stub, peer } = await registerColdSession();
    await seedFacadeRoot();
    const backend = await installBackendResponder();
    try {
      await fillQueueAndAsk(stub);

      const refused = await postAnswer();
      expect(refused.status).toBe(429);
      await expect(refused.json()).resolves.toMatchObject({ error: 'KILO_PROMPT_QUEUE_FULL' });

      // Free capacity: the route goes ready, so the queue drains into the turn.
      peer.prepareView = peer.view('ready');
      await stub.onRoute({ state: 'ready', attemptId: peer.attemptId });
      await waitFor(async () => {
        const ready = await stub.getSession();
        if (ready.type !== 'found') throw new Error('Session disappeared');
        expect(ready.messages.some(message => message.state === 'queued')).toBe(false);
      });
      const delivered = await stub.getSession();
      if (delivered.type !== 'found') throw new Error('Session disappeared');
      const accepted = delivered.messages.filter(message => message.state === 'accepted');
      expect(accepted.length).toBeGreaterThan(0);
      // The turn then settles, so the next answer continues the chat.
      const last = accepted[accepted.length - 1];
      if (last === undefined) throw new Error('No accepted message');
      await stub.onOutcome({
        sessionId: cloudAgentSessionId,
        status: 'completed',
        lastMessageId: last.messageId,
      });
      const drained = await stub.getSession();
      if (drained.type !== 'found') throw new Error('Session disappeared');
      expect(messageStates(drained.messages.map(message => message.state), 'queued')).toBe(false);
      expect(drained.messages.some(message => message.state === 'accepted')).toBe(false);

      // The retry reaches the payer preflight because the interaction is pending.
      const retried = await postAnswer();
      expect(retried.status).toBe(503);
      expect(retried.status).not.toBe(409);
      await expect(retried.json()).resolves.toEqual({
        error: 'KILO_BALANCE_VALIDATION_FAILED',
        message: 'Session access is temporarily unavailable; retry the request',
      });
      await expect(stub.getPendingInteractions()).resolves.toMatchObject({
        questions: [{ id: 'q_1' }],
      });
    } finally {
      await backend.release();
    }
  });
});
