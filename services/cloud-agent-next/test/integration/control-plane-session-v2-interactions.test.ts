import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-plane.js';
import { createMessageId, MESSAGE_ID_PATTERN } from '../../src/session/message-id.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import type { ControlPlanePromptPayload } from '../../src/shared/control-plane-protocol.js';
import type { ControlPlaneWrapperFrame } from '../../src/shared/control-plane-protocol.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import {
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace })
  .SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const NATIVE_KILO_TOKEN = 'native-kilo-token-user';
const USER_ID = 'user_123';
const ORG_ID = 'org_123';

function newSessionId(): string {
  return `workspace_${crypto.randomUUID()}`;
}

function kiloSessionId(): string {
  // `containedKiloSessionIdSchema` requires exactly 26 alphanumerics.
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

function messageId(): string {
  // `MessageIdSchema`: `msg_` + 12 lowercase hex + 14 base62.
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
  return `msg_${hex}${suffix}`;
}

function metadata(input: {
  sessionId: string;
  kiloSessionId: string;
  sandboxId: string;
  workspacePath?: string;
}) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: input.kiloSessionId, kilocodeToken: NATIVE_KILO_TOKEN },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'git', url: 'https://github.com/acme/widgets.git', platform: 'github' },
    workspace: {
      branchName: 'kilo/test-branch',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare',
      ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function promptPayload(messageId: string, prompt = 'hello'): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt },
    agent: { mode: 'code', model: 'test/model' },
  };
}

type FakeProvider = { adapter: ProviderAdapter; launchEnvs: Record<string, string>[] };

function createFakeProvider(): FakeProvider {
  const provider = {
    adapter: null as unknown as ProviderAdapter,
    launchEnvs: [] as Record<string, string>[],
  };
  provider.adapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, launchEnv) {
      provider.launchEnvs.push({ ...launchEnv });
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop() {
      return 'terminal' as StopResult;
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
    installFakeCredentialEnv(instance.env, broker, {
      SandboxSmallContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
      WORKER_URL: 'https://control.test',
      KILOCODE_BACKEND_BASE_URL: 'https://control.test',
      KILO_OPENROUTER_BASE: 'https://control.test',
      KILO_SESSION_INGEST_URL: 'https://control.test',
    });
    Object.assign(instance, { createProviderAdapter: () => provider, provider });
  });
  return sandboxStub;
}

type PromptFrame = Extract<ControlPlaneWrapperFrame, { type: 'session.prompt' }>;
type AbortFrame = Extract<ControlPlaneWrapperFrame, { type: 'session.abort' }>;
type AnswerFrame = Extract<ControlPlaneWrapperFrame, { type: 'session.answer' }>;

type Recording = {
  prepares: string[];
  prompts: PromptFrame[];
  aborts: AbortFrame[];
  answers: AnswerFrame[];
};

/**
 * Consume wrapper frames for the life of the test, answering every
 * `session.prepare` with `session.ready`. That is the whole wrapper side the
 * Stop, answer and delivery paths need; prompts, aborts and answers are
 * recorded for assertions.
 */
function startWrapperPump(wrapper: FakeWrapper, recording: Recording): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const frame = await wrapper.next(250);
      if (frame === null) continue;
      try {
        switch (frame.type) {
          case 'session.prepare':
            recording.prepares.push(frame.spec.sessionId);
            wrapper.send({ type: 'session.ready', sessionId: frame.spec.sessionId });
            break;
          case 'session.prompt':
            recording.prompts.push(frame);
            break;
          case 'session.abort':
            recording.aborts.push(frame);
            break;
          case 'session.answer':
            recording.answers.push(frame);
            break;
          default:
            break;
        }
      } catch {
        // The socket closed while the test tore down; nothing left to answer.
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

async function setupSiblingPair(): Promise<{
  sandboxStub: DurableObjectStub<SandboxControlV2>;
  sessionA: string;
  sessionB: string;
  stubA: DurableObjectStub<SandboxSessionV2>;
  stubB: DurableObjectStub<SandboxSessionV2>;
  messageA: string;
  messageB: string;
  recording: Recording;
  stopPump: () => void;
}> {
  const sessionA = newSessionId();
  const sessionB = newSessionId();
  const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionA);
  const provider = createFakeProvider();
  const sandboxStub = await installSandbox(sandboxId, provider.adapter);

  const stubA = sessions.getByName(sessionDoName(USER_ID, sessionA));
  const messageA = messageId();
  await stubA.createSessionWithInitialAdmission({
    metadata: metadata({ sessionId: sessionA, kiloSessionId: kiloSessionId(), sandboxId }),
    message: promptPayload(messageA, 'first'),
    sandboxSelection: { provider: 'cloudflare' },
  });

  const stubB = sessions.getByName(sessionDoName(USER_ID, sessionB));
  await stubB.registerSessionFromMetadata({
    metadata: metadata({
      sessionId: sessionB,
      kiloSessionId: kiloSessionId(),
      sandboxId,
      workspacePath: '/workspace/worktrees/shared',
    }),
    sandboxSelection: { provider: 'cloudflare' },
  });
  const messageB = messageId();
  await stubB.send(promptPayload(messageB, 'second'));

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
    wrapperId: 'wr_sibling',
    allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID,
  });
  expect(welcome).toEqual({ type: 'welcome', protocolVersion: 2 });

  const recording: Recording = { prepares: [], prompts: [], aborts: [], answers: [] };
  const stopPump = startWrapperPump(wrapper, recording);

  // Both routes prepare on connect; the pump answers ready, and each Session DO
  // then delivers its queued prompt.
  await waitFor(async () => {
    expect(await messageStatus(stubA, messageA)).toBe('running');
    expect(await messageStatus(stubB, messageB)).toBe('running');
  });

  return { sandboxStub, sessionA, sessionB, stubA, stubB, messageA, messageB, recording, stopPump };
}

async function messageStatus(
  stub: DurableObjectStub<SandboxSessionV2>,
  messageId: string
): Promise<string | null> {
  const result = await stub.getMessageResult(messageId);
  return result.type === 'found' ? result.result.status : null;
}

/** A registered session with a recording sandbox peer and no prompt. */
async function registerOnlySession(): Promise<{
  sessionId: string;
  stub: DurableObjectStub<SandboxSessionV2>;
}> {
  const sessionId = newSessionId();
  const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
  const stub = sessions.getByName(sessionId);
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => new FakeSandboxPeer();
  });
  await stub.registerSessionFromMetadata({
    metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
    sandboxSelection: { provider: 'cloudflare' },
  });
  return { sessionId, stub };
}

afterEach(async () => {
  await reset();
});

describe('SandboxSessionV2 Stop, answers and permissions', () => {
  it('stops one session without affecting a sibling route on the same sandbox', async () => {
    const pair = await setupSiblingPair();
    try {
      await pair.stubA.stop();
      await waitFor(() => expect(pair.recording.aborts).toHaveLength(1));
      expect(pair.recording.aborts[0]).toMatchObject({
        type: 'session.abort',
        sessionId: pair.sessionA,
      });
      // The sibling route and its accepted message are untouched.
      expect(pair.recording.aborts.some(frame => frame.sessionId === pair.sessionB)).toBe(false);
      expect(await messageStatus(pair.stubB, pair.messageB)).toBe('running');
      await expect(pair.sandboxStub.status({ sessionId: pair.sessionB })).resolves.toMatchObject({
        sessionId: pair.sessionB,
        view: { state: 'ready' },
      });

      // And the sibling stays usable: a new message is delivered on its route.
      const followUp = messageId();
      await pair.stubB.send(promptPayload(followUp, 'still working'));
      await waitFor(() =>
        expect(pair.recording.prompts.some(frame => frame.payload.messageId === followUp)).toBe(
          true
        )
      );
    } finally {
      pair.stopPump();
    }
  });

  it('forwards a live answer under this session, ignoring the caller session id', async () => {
    const pair = await setupSiblingPair();
    try {
      // The reply names the sibling B, but the RPC runs on A: the frame the
      // wrapper receives must carry A, so a wrong id cannot reach B's route.
      await expect(
        pair.stubA.answer({
          sessionId: pair.sessionB,
          reply: { action: 'answer', questionId: 'q_1', answers: [['yes']] },
        })
      ).resolves.toBe('sent');
      await waitFor(() => expect(pair.recording.answers).toHaveLength(1));
      expect(pair.recording.answers[0]).toMatchObject({
        type: 'session.answer',
        sessionId: pair.sessionA,
        reply: { action: 'answer', questionId: 'q_1', answers: [['yes']] },
      });
      expect(pair.recording.answers.some(frame => frame.sessionId === pair.sessionB)).toBe(false);
    } finally {
      pair.stopPump();
    }
  });

  it('admits a settled answer as a time-sortable new message', async () => {
    const pair = await setupSiblingPair();
    try {
      await pair.stubA.stop();
      await waitFor(() => expect(pair.recording.aborts).toHaveLength(1));
      expect(await messageStatus(pair.stubA, pair.messageA)).toBe('interrupted');

      const startedAt = Date.now();
      await pair.stubA.onEvents({
        events: [{ type: 'question.asked', properties: { id: 'q_1' } }],
      });

      const promptsBefore = pair.recording.prompts.length;
      await expect(
        pair.stubA.answer({
          sessionId: pair.sessionA,
          reply: { action: 'answer', questionId: 'q_1', answers: [['Option A']] },
        })
      ).resolves.toBe('sent');

      // The answer is queued as a fresh message and delivered on the warm route.
      await waitFor(() => expect(pair.recording.prompts.length).toBeGreaterThan(promptsBefore));
      const delivered = pair.recording.prompts
        .slice(promptsBefore)
        .find(
          frame => frame.payload.turn.type === 'prompt' && frame.payload.turn.prompt === 'Option A'
        );
      expect(delivered).toBeDefined();

      // The id is time-derived (canonical pattern, prefix between the ids the
      // canonical generator makes around this moment), so it sorts with the
      // transcript rather than by random suffix.
      if (delivered === undefined) throw new Error('answer prompt was not delivered');
      const answerId = delivered.payload.messageId;
      expect(MESSAGE_ID_PATTERN.test(answerId)).toBe(true);
      const answerPrefix = answerId.slice(4, 16);
      expect(answerPrefix >= createMessageId(startedAt).slice(4, 16)).toBe(true);
      expect(answerPrefix <= createMessageId(Date.now()).slice(4, 16)).toBe(true);

      const snapshot = await pair.stubA.getSession();
      expect(snapshot.type).toBe('found');
      if (snapshot.type === 'found') {
        expect(snapshot.messages).toHaveLength(2);
        expect(snapshot.messages.find(m => m.messageId === pair.messageA)?.state).toBe('cancelled');
        expect(snapshot.messages.find(m => m.messageId === answerId)?.state).toBe('accepted');
      }
      // The answered question left the pending set.
      await expect(pair.stubA.getPendingInteractions()).resolves.toEqual({
        questions: [],
        permissions: [],
      });
    } finally {
      pair.stopPump();
    }
  });

  it('refuses a settled answer whose id is unknown, repeated or already answered', async () => {
    // No sandbox route goes ready, so an admitted answer stays queued and the
    // turn stays settled for every attempt below.
    const { sessionId, stub } = await registerOnlySession();
    await stub.send(promptPayload(messageId(), 'start'));
    const before = await stub.getSession();
    const beforeCount = before.type === 'found' ? before.messages.length : -1;

    // Unknown id: nothing is pending.
    await expect(
      stub.answer({
        sessionId,
        reply: { action: 'answer', questionId: 'q_unknown', answers: [['x']] },
      })
    ).resolves.toBe('not_connected');

    // Ask, answer once (admitted), then repeat with the resolved id.
    await stub.onEvents({ events: [{ type: 'question.asked', properties: { id: 'q_1' } }] });
    await expect(
      stub.answer({
        sessionId,
        reply: { action: 'answer', questionId: 'q_1', answers: [['yes']] },
      })
    ).resolves.toBe('sent');
    await expect(
      stub.answer({
        sessionId,
        reply: { action: 'answer', questionId: 'q_1', answers: [['yes']] },
      })
    ).resolves.toBe('not_connected');

    const after = await stub.getSession();
    const afterCount = after.type === 'found' ? after.messages.length : -1;
    // Exactly one turn was admitted across the three attempts.
    expect(afterCount).toBe(beforeCount + 1);
    await expect(stub.getPendingInteractions()).resolves.toEqual({
      questions: [],
      permissions: [],
    });
  });

  it('projects questions and permissions and resolves each through getPendingInteractions', async () => {
    const { sessionId, stub } = await registerOnlySession();
    await stub.onEvents({
      events: [
        { type: 'question.asked', properties: { id: 'q_1' } },
        { type: 'permission.asked', properties: { id: 'p_1' } },
      ],
    });
    await expect(stub.getPendingInteractions()).resolves.toMatchObject({
      questions: [{ id: 'q_1' }],
      permissions: [{ id: 'p_1' }],
    });

    await stub.onEvents({
      events: [
        { type: 'question.replied', properties: { requestID: 'q_1' } },
        { type: 'permission.replied', properties: { requestID: 'p_1' } },
      ],
    });
    await expect(stub.getPendingInteractions()).resolves.toEqual({
      questions: [],
      permissions: [],
    });
  });

  it('uses the metadata model when the settled turn is a model-less command', async () => {
    const { sessionId, stub } = await registerOnlySession();
    const commandId = messageId();
    await stub.send({
      messageId: commandId,
      turn: { type: 'command', command: 'init', arguments: '' },
      agent: { mode: 'code' },
    });
    await stub.onEvents({
      events: [{ type: 'question.asked', properties: { id: 'q_1' } }],
    });
    await expect(
      stub.answer({
        sessionId,
        reply: { action: 'answer', questionId: 'q_1', answers: [['go']] },
      })
    ).resolves.toBe('sent');

    const snapshot = await stub.getSession();
    expect(snapshot.type).toBe('found');
    if (snapshot.type === 'found') {
      expect(snapshot.messages).toHaveLength(2);
      expect(snapshot.messages.map(message => message.messageId)).toContain(commandId);
    }
  });
});
