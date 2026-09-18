import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startSession: vi.fn(),
  sendMessage: vi.fn(),
  openStream: vi.fn(),
  openConnectedStream: vi.fn(),
  interruptSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchFakeRequests: vi.fn(),
  fetchFakeScenarioStatus: vi.fn(),
  getMessageResult: vi.fn(),
  getSessionSnapshot: vi.fn(),
  prepareBrowserSession: vi.fn(),
  releaseGate: vi.fn(),
  waitForGateEngaged: vi.fn(),
  gateEngagementDetail: vi.fn(),
}));

// Only the network functions are faked. `collectUntilTerminal`,
// `fakeDirective`, `hasPreparationForMessage` and `isMessageCompleted` stay
// real so the scenario's assertions are exercised against the real helpers.
vi.mock('../../e2e/client.js', async importOriginal => {
  const actual = await importOriginal<typeof ClientModule>();
  return {
    ...actual,
    startSession: mocks.startSession,
    sendMessage: mocks.sendMessage,
    openStream: mocks.openStream,
    openConnectedStream: mocks.openConnectedStream,
    interruptSession: mocks.interruptSession,
    deleteSession: mocks.deleteSession,
    fetchFakeRequests: mocks.fetchFakeRequests,
    fetchFakeScenarioStatus: mocks.fetchFakeScenarioStatus,
    getMessageResult: mocks.getMessageResult,
    getSessionSnapshot: mocks.getSessionSnapshot,
    prepareBrowserSession: mocks.prepareBrowserSession,
    releaseGate: mocks.releaseGate,
    waitForGateEngaged: mocks.waitForGateEngaged,
    gateEngagementDetail: mocks.gateEngagementDetail,
  };
});

// `client.js` statically imports `auth.js`, which imports `@kilocode/db`. The
// real client only uses these two exporters, and the faked network functions
// never reach them, so stubbing them keeps `@kilocode/db` out of this test's
// module graph without changing pure-helper behaviour.
vi.mock('../../e2e/auth.js', () => ({
  mintApiToken: vi.fn(() => 'minted-token'),
  mintStreamTicket: vi.fn(() => 'minted-ticket'),
}));

import type { DriverConfig, StreamConnection, StreamEvent } from '../../e2e/client.js';
import type * as ClientModule from '../../e2e/client.js';
import type { LifecycleArgs, LifecycleResult } from '../../e2e/lifecycle.js';
import { runSharedScenario } from '../../e2e/scenario-capabilities.js';
import type {
  CallbackObservation,
  CallbackPayload,
  SandboxObservation,
  ScenarioEnvironment,
  SessionSandboxObservation,
} from '../../e2e/scenario-capabilities.js';
import {
  buildAuthRejectProbes,
  classifyAuthProbe,
  collectChildMessageText,
  echoDirectivePayload,
  echoPayloadMatches,
  hasCorrelatedStreamProgress,
  sendAuthProbe,
  SHARED_SCENARIOS,
  trailingNonEmptyLine,
  type AuthProbe,
} from '../../e2e/scenarios-shared.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const KILO_SESSION_ID = 'ses_aaaaaaaaaaaaBBBBBBBBBBBBBB';
const COLD_MESSAGE_ID = 'message_cold';
const COLD_ASSISTANT_MESSAGE_ID = 'message_cold_assistant';
const COLD_TEXT_PART_ID = 'part_cold_text';
const HOT_MESSAGE_IDS = ['message_hot_1', 'message_hot_2', 'message_hot_3'];
const MODEL_TOKEN = 'deployed-token';
const ADMIN_TOKEN = 'unit-admin-token';

const config: DriverConfig = {
  workerUrl: 'https://worker.example.test',
  user: { id: 'usr_deployed', email: 'deployed@example.test' },
  bearerToken: 'deployed-token',
  fetchStreamTicket: async () => 'ticket',
  skipBalanceCheck: false,
  gitUrl: 'https://example.test/repo.git',
  model: 'kilo/fake-deterministic',
  fakeLlmUrl: 'https://fake.example.test',
};

function deployedEnvironment(): ScenarioEnvironment {
  return {
    profile: 'deployed',
    requireControlPlaneSession: true,
    deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
  };
}

function localEnvironment(sandbox: SandboxObservation): ScenarioEnvironment {
  return { profile: 'local', requireControlPlaneSession: false, sandbox };
}

function coldHot(
  args: {
    config: DriverConfig;
    conversation: string;
    api?: 'unified' | 'legacy';
    timeoutMs?: number;
  },
  env: ScenarioEnvironment = deployedEnvironment()
) {
  return runSharedScenario(SHARED_SCENARIOS['cold-hot'], { ...args, env });
}

function unknownModel(
  args: { config: DriverConfig; conversation: string; api?: 'unified' | 'legacy' },
  env: ScenarioEnvironment = deployedEnvironment()
) {
  return runSharedScenario(SHARED_SCENARIOS['unknown-model'], { ...args, env });
}

function authReject(
  args: { config: DriverConfig; conversation: string },
  env: ScenarioEnvironment = deployedEnvironment()
) {
  return runSharedScenario(SHARED_SCENARIOS['auth-reject'], { ...args, env });
}

let nextEventId = 1;

function streamEvent(streamEventType: string, data: Record<string, unknown> = {}): StreamEvent {
  return {
    eventId: nextEventId++,
    executionId: null,
    sessionId: SESSION_ID,
    streamEventType,
    timestamp: new Date(0).toISOString(),
    data,
  };
}

function preparingEvent(triggerMessageId: string): StreamEvent {
  return streamEvent('preparing', {
    version: 2,
    attemptId: 'attempt_1',
    triggerMessageId,
    revision: 1,
    timestamp: new Date(0).toISOString(),
    step: 'sandbox',
    message: 'preparing sandbox',
    action: 'step_progress',
  });
}

function completedEvent(messageId: string): StreamEvent {
  return streamEvent('cloud.message.completed', { messageId });
}

function kilocodeEvent(): StreamEvent {
  return streamEvent('kilocode', { type: 'message.start' });
}

function messageEvent(role: string, parentID: string, id: string): StreamEvent {
  return streamEvent('kilocode', {
    type: 'message.updated',
    properties: { info: { id, parentID, role } },
  });
}

function assistantMessageEvent(parentID: string, id: string): StreamEvent {
  return messageEvent('assistant', parentID, id);
}

function textPartEvent(
  partId: string,
  messageID: string,
  text: string,
  extra: Record<string, unknown> = {}
): StreamEvent {
  return streamEvent('kilocode', {
    type: 'message.part.updated',
    properties: { part: { id: partId, messageID, type: 'text', text, ...extra } },
  });
}

function partRemovedEvent(messageID: string, partID: string): StreamEvent {
  return streamEvent('kilocode', {
    type: 'message.part.removed',
    properties: { messageID, partID },
  });
}

function messageRemovedEvent(messageID: string): StreamEvent {
  return streamEvent('kilocode', {
    type: 'message.removed',
    properties: { messageID },
  });
}

function coldEchoEvents(text: string): StreamEvent[] {
  return [
    preparingEvent(COLD_MESSAGE_ID),
    assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
    textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, text),
    completedEvent(COLD_MESSAGE_ID),
  ];
}

type FakeStream = StreamConnection & {
  close: ReturnType<typeof vi.fn>;
  waitForTerminal: ReturnType<typeof vi.fn>;
};

function fakeStream(events: StreamEvent[], terminal: StreamEvent): FakeStream {
  return {
    events,
    close: vi.fn(),
    waitFor: predicate => Promise.resolve(events.find(predicate) ?? null),
    waitForTerminal: vi.fn().mockResolvedValue(terminal),
    get receivedCount() {
      return events.length;
    },
    get isOpen() {
      return true;
    },
  };
}

function installColdHotScenario(options?: {
  coldEvents?: StreamEvent[];
  hotEvents?: StreamEvent[][];
}): { coldStream: FakeStream; hotStreams: FakeStream[] } {
  const coldEvents = options?.coldEvents ?? coldEchoEvents('hi');
  const hotEvents =
    options?.hotEvents ?? HOT_MESSAGE_IDS.map(id => [kilocodeEvent(), completedEvent(id)]);

  const coldStream = fakeStream(coldEvents, completedEvent(COLD_MESSAGE_ID));
  const hotStreams = hotEvents.map((events, index) =>
    fakeStream(events, completedEvent(HOT_MESSAGE_IDS[index]!))
  );

  const streams: FakeStream[] = [coldStream, ...hotStreams];
  mocks.openConnectedStream.mockImplementation(async () => {
    const stream = streams.shift();
    if (!stream) throw new Error('unexpected extra openConnectedStream call');
    return stream;
  });
  const queuedMessageIds = [...HOT_MESSAGE_IDS];
  mocks.sendMessage.mockImplementation(async () => {
    const messageId = queuedMessageIds.shift();
    if (!messageId) throw new Error('unexpected extra sendMessage call');
    return { messageId, delivery: 'sent' };
  });
  mocks.startSession.mockResolvedValue({
    cloudAgentSessionId: SESSION_ID,
    kiloSessionId: KILO_SESSION_ID,
    messageId: COLD_MESSAGE_ID,
    delivery: 'sent',
  });

  return { coldStream, hotStreams };
}

function sandboxStub(overrides: Partial<SandboxObservation> = {}): SandboxObservation {
  return {
    snapshotContainerIds: vi.fn(async () => new Set<string>()),
    waitForOwnedContainer: vi.fn(async () => null),
    waitForNewContainer: vi.fn(async () => null),
    ...overrides,
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  nextEventId = 1;
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.interruptSession.mockResolvedValue({ success: true });
  mocks.deleteSession.mockResolvedValue({ success: true });
  mocks.fetchFakeRequests.mockResolvedValue({ chatCompletions: 3 });
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('cold-hot warm reuse', () => {
  it('accepts a realistic v2 preparing shape and completes all hot turns', async () => {
    const { coldStream, hotStreams } = installColdHotScenario();

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain(`session=${SESSION_ID}`);
    expect(result.message).toContain('cold=complete');
    expect(result.message).toContain('cold-content="hi"');
    expect(result.message).toMatch(/echo:hot:complete\/\d+ms/);
    expect(result.message).toMatch(/slow:3:50:complete\/\d+ms/);
    expect(result.message).toMatch(/echo:followup:complete\/\d+ms/);
    expect(result.message).toContain('identity=unchecked(no-sandbox-capability)');
    expect(result.message).toContain('not physical container identity');

    expect(mocks.interruptSession).toHaveBeenCalledTimes(1);
    expect(mocks.interruptSession).toHaveBeenCalledWith(
      config,
      SESSION_ID,
      expect.any(AbortSignal)
    );
    expect(mocks.deleteSession).toHaveBeenCalledTimes(1);
    expect(mocks.deleteSession).toHaveBeenCalledWith(config, SESSION_ID, expect.any(AbortSignal));

    expect(coldStream.close).toHaveBeenCalledTimes(1);
    for (const stream of hotStreams) expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('fails when the cold echo text does not match the directive', async () => {
    installColdHotScenario({ coldEvents: coldEchoEvents('not-hi') });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('expected correlated child text "hi"');
    expect(result.message).toContain('observed "not-hi"');
    // A failed cold assertion still cleans up the started session.
    expect(mocks.interruptSession).toHaveBeenCalledTimes(1);
    expect(mocks.deleteSession).toHaveBeenCalledTimes(1);
  });

  it('accepts correlated text whose trailing line is the echo payload with a LF separator', async () => {
    installColdHotScenario({
      coldEvents: coldEchoEvents('⠸ Initializing snapshot…\nhi'),
    });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('cold-content="hi"');
  });

  it('accepts correlated text whose trailing line is the echo payload with a CR separator', async () => {
    installColdHotScenario({
      coldEvents: coldEchoEvents('⠸ Initializing snapshot…\rhi'),
    });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('cold-content="hi"');
  });

  it('accepts correlated text whose trailing line is the echo payload with a CRLF separator', async () => {
    installColdHotScenario({
      coldEvents: coldEchoEvents('⠸ Initializing snapshot…\r\nhi'),
    });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('cold-content="hi"');
  });

  it('accepts a single-line ANSI spinner status with the answer and no separator', async () => {
    installColdHotScenario({
      coldEvents: coldEchoEvents('⠋ Initializing snapshot…hi'),
    });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('cold-content="⠋ Initializing snapshot…hi"');
  });

  it('fails when the correlated text does not end with the echo payload', async () => {
    installColdHotScenario({ coldEvents: coldEchoEvents('Initializing snapshot…') });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('expected correlated child text "hi"');
    expect(result.message).toContain('observed tail "Initializing snapshot…"');
  });

  it('fails on empty observed text', async () => {
    installColdHotScenario({ coldEvents: coldEchoEvents('') });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('expected correlated child text "hi"');
  });

  it('fails when the correlated text merely contains the payload but does not end with it', async () => {
    installColdHotScenario({ coldEvents: coldEchoEvents('hi\ntrailing noise') });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('expected correlated child text "hi"');
    expect(result.message).toContain('observed "hi\\ntrailing noise"');
  });

  it('skips the cold content assertion for a non-echo directive', async () => {
    installColdHotScenario();

    const result = await coldHot({ config, conversation: 'realistic:hello' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('cold-content=skipped(not-echo:<token>)');
  });

  it('fails when the cold turn has no preparing event for the cold message', async () => {
    installColdHotScenario({ coldEvents: [completedEvent(COLD_MESSAGE_ID)] });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('cold turn');
    expect(result.message).toContain('preparation evidence');
  });

  it('fails when a hot turn carries a preparing event for the hot message', async () => {
    installColdHotScenario({
      hotEvents: [
        [kilocodeEvent(), preparingEvent(HOT_MESSAGE_IDS[0]!), completedEvent(HOT_MESSAGE_IDS[0]!)],
        [kilocodeEvent(), completedEvent(HOT_MESSAGE_IDS[1]!)],
        [kilocodeEvent(), completedEvent(HOT_MESSAGE_IDS[2]!)],
      ],
    });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('echo:hot');
    expect(result.message).toContain('unexpected preparing event');
  });

  it.each([
    ['a completion for a different message', completedEvent('message_other')],
    ['a failure event', streamEvent('cloud.message.failed', { messageId: HOT_MESSAGE_IDS[0]! })],
  ] as const)('fails a hot turn whose terminal is %s', async (_name, terminal) => {
    const { hotStreams } = installColdHotScenario();
    hotStreams[0]?.waitForTerminal.mockResolvedValue(terminal);

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('expected message completion');
    expect(result.message).toContain(HOT_MESSAGE_IDS[0]);
  });

  it('still attempts deleteSession when interruptSession rejects and keeps the result', async () => {
    installColdHotScenario();
    mocks.interruptSession.mockRejectedValue(new Error('interrupt wedged'));

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(true);
    expect(mocks.interruptSession).toHaveBeenCalledTimes(1);
    expect(mocks.deleteSession).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('interruptSession'));
  });

  it('fails when the start does not return a workspace_ session', async () => {
    installColdHotScenario();
    mocks.startSession.mockResolvedValue({
      cloudAgentSessionId: 'agent_legacy_session',
      kiloSessionId: KILO_SESSION_ID,
      messageId: COLD_MESSAGE_ID,
      delivery: 'sent',
    });

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('workspace_');
    // The deployed config no longer sets `expectControlPlane`, so startSession
    // returns instead of throwing client-side. The scenario records the
    // returned session before its workspace check, so `finally` cleans it up.
    expect(mocks.interruptSession).toHaveBeenCalledWith(
      config,
      'agent_legacy_session',
      expect.any(AbortSignal)
    );
    expect(mocks.deleteSession).toHaveBeenCalledWith(
      config,
      'agent_legacy_session',
      expect.any(AbortSignal)
    );
  });
});

describe('cold-hot stream closure on failure', () => {
  it('closes the cold and hot streams when the hot send fails', async () => {
    const { coldStream, hotStreams } = installColdHotScenario();
    mocks.sendMessage.mockRejectedValueOnce(new Error('send failed'));

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('threw: send failed');
    expect(coldStream.close).toHaveBeenCalledTimes(1);
    expect(hotStreams[0]?.close).toHaveBeenCalledTimes(1);
    expect(mocks.interruptSession).toHaveBeenCalledTimes(1);
  });

  it('closes the hot stream when terminal collection throws', async () => {
    const { hotStreams } = installColdHotScenario();
    hotStreams[0]?.waitForTerminal.mockRejectedValue(new Error('collection failed'));

    const result = await coldHot({ config, conversation: 'echo:hi' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('threw: collection failed');
    expect(hotStreams[0]?.close).toHaveBeenCalledTimes(1);
    expect(mocks.interruptSession).toHaveBeenCalledTimes(1);
  });
});

describe('cold-hot sandbox identity', () => {
  it('checks the cold container persists and no new container appears when sandbox is present', async () => {
    installColdHotScenario();
    const waitForOwnedContainer = vi.fn(async () => 'container_cold');
    const sandbox = sandboxStub({
      snapshotContainerIds: vi.fn(async () => new Set(['container_cold'])),
      waitForOwnedContainer,
    });

    const result = await coldHot({ config, conversation: 'echo:hi' }, localEnvironment(sandbox));

    expect(result.ok).toBe(true);
    expect(result.message).toContain('cold-sandbox=container_cold');
    expect(result.message).not.toContain('identity=unchecked(no-sandbox-capability)');
    expect(result.message).not.toContain('not physical container identity');
    expect(waitForOwnedContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudAgentSessionId: SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
        timeoutMs: 240_000,
      })
    );
  });

  it('fails a hot turn when a new container appeared', async () => {
    installColdHotScenario();
    let call = 0;
    const sandbox = sandboxStub({
      snapshotContainerIds: vi.fn(async () => {
        call += 1;
        if (call === 1) return new Set<string>();
        if (call === 2) return new Set(['container_cold']);
        return new Set(['container_cold', 'container_new']);
      }),
      waitForOwnedContainer: vi.fn(async () => 'container_cold'),
    });

    const result = await coldHot({ config, conversation: 'echo:hi' }, localEnvironment(sandbox));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('sandbox identity changed');
    expect(result.message).toContain('container_new');
  });

  it('fails a hot turn when the cold container disappeared', async () => {
    installColdHotScenario();
    let call = 0;
    const sandbox = sandboxStub({
      snapshotContainerIds: vi.fn(async () => {
        call += 1;
        if (call === 1) return new Set<string>();
        if (call === 2) return new Set(['container_cold']);
        return new Set(['container_replacement']);
      }),
      waitForOwnedContainer: vi.fn(async () => 'container_cold'),
    });

    const result = await coldHot({ config, conversation: 'echo:hi' }, localEnvironment(sandbox));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('sandbox identity changed');
  });

  it('fails when the cold container cannot be identified', async () => {
    const { coldStream } = installColdHotScenario();
    const sandbox = sandboxStub({ waitForOwnedContainer: vi.fn(async () => null) });

    const result = await coldHot({ config, conversation: 'echo:hi' }, localEnvironment(sandbox));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('could not identify an exclusively owned sandbox');
    // The failure diagnostic keeps the cold stream events buffered so far.
    expect(result.events).toHaveLength(coldStream.events.length);
    expect(result.events).toEqual(coldStream.events);
    expect(mocks.interruptSession).toHaveBeenCalledTimes(1);
  });

  it('treats an ambiguous-ownership throw as a failure and still cleans up', async () => {
    installColdHotScenario();
    const sandbox = sandboxStub({
      waitForOwnedContainer: vi.fn(async () => {
        throw new Error('Multiple containers match; refusing ambiguous ownership');
      }),
    });

    const result = await coldHot({ config, conversation: 'echo:hi' }, localEnvironment(sandbox));

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBeUndefined();
    expect(result.message).toContain('threw:');
    expect(result.message).toContain('ambiguous ownership');
    expect(mocks.interruptSession).toHaveBeenCalledTimes(1);
    expect(mocks.deleteSession).toHaveBeenCalledTimes(1);
  });
});

describe('unknown-model', () => {
  it('passes when the start is rejected and the fake saw no new completion', async () => {
    mocks.startSession.mockRejectedValue(
      new Error('tRPC start failed: 400 — FORBIDDEN: Selected model is not available')
    );

    const result = await unknownModel({
      config,
      conversation: 'echo:ignored',
      api: 'unified',
    });

    expect(result.ok).toBe(true);
    expect(mocks.fetchFakeRequests).toHaveBeenCalledTimes(2);
  });

  it('fails when the start is accepted', async () => {
    mocks.startSession.mockResolvedValue({
      cloudAgentSessionId: SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      messageId: COLD_MESSAGE_ID,
      delivery: 'sent',
    });

    const result = await unknownModel({
      config,
      conversation: 'echo:ignored',
      api: 'unified',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('accepted');
    // An unexpectedly accepted start must still be cleaned up.
    expect(mocks.interruptSession).toHaveBeenCalledWith(
      config,
      SESSION_ID,
      expect.any(AbortSignal)
    );
    expect(mocks.deleteSession).toHaveBeenCalledWith(config, SESSION_ID, expect.any(AbortSignal));
  });

  it('fails when the rejection message is unexpected', async () => {
    mocks.startSession.mockRejectedValue(new Error('tRPC start failed: 500 — boom'));

    const result = await unknownModel({
      config,
      conversation: 'echo:ignored',
      api: 'unified',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('unexpected error');
  });

  it('waits for a delayed new container when sandbox is present', async () => {
    mocks.startSession.mockRejectedValue(
      new Error('tRPC start failed: 400 — FORBIDDEN: Selected model is not available')
    );
    const waitForNewContainer = vi.fn(async () => null);
    const waitForOwnedContainer = vi.fn(async () => null);
    const sandbox = sandboxStub({
      snapshotContainerIds: vi.fn(async () => new Set(['container_known'])),
      waitForNewContainer,
      waitForOwnedContainer,
    });

    const result = await unknownModel(
      { config, conversation: 'echo:ignored', api: 'unified' },
      localEnvironment(sandbox)
    );

    expect(result.ok).toBe(true);
    expect(waitForNewContainer).toHaveBeenCalledTimes(1);
    expect(waitForNewContainer).toHaveBeenCalledWith(new Set(['container_known']), 2_000);
    expect(waitForOwnedContainer).not.toHaveBeenCalled();
  });

  it('fails when a delayed observation finds a new container', async () => {
    mocks.startSession.mockRejectedValue(
      new Error('tRPC start failed: 400 — FORBIDDEN: Selected model is not available')
    );
    const sandbox = sandboxStub({
      snapshotContainerIds: vi.fn(async () => new Set(['container_known'])),
      waitForNewContainer: vi.fn(async () => 'container_new'),
    });

    const result = await unknownModel(
      { config, conversation: 'echo:ignored', api: 'unified' },
      localEnvironment(sandbox)
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('container_new');
    expect(result.message).toContain('expected no sandbox');
  });
});

describe('collectChildMessageText', () => {
  it('keeps the latest text snapshot per part id', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'hel'),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'hello'),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('hello');
  });

  it('joins multiple distinct text parts of the same assistant message', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent('part_first', COLD_ASSISTANT_MESSAGE_ID, 'hello '),
      textPartEvent('part_second', COLD_ASSISTANT_MESSAGE_ID, 'world'),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('hello world');
  });

  // The cold-turn shape observed in the live probe: a transient CLI spinner
  // part, the real answer part, then another transient spinner part, with the
  // product's end-of-turn removal events for both spinners. The reduction must
  // yield exactly the answer, never `spinner…answer…spinner`.
  it('excludes transient CLI progress parts around the real answer', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent('part_spinner_before', COLD_ASSISTANT_MESSAGE_ID, '⠇ Initializing snapshot…', {
        metadata: { 'kilocode.lifecycle': 'transient' },
      }),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'probe'),
      textPartEvent('part_spinner_after', COLD_ASSISTANT_MESSAGE_ID, '⠋ Initializing snapshot…', {
        metadata: { 'kilocode.lifecycle': 'transient' },
      }),
      partRemovedEvent(COLD_ASSISTANT_MESSAGE_ID, 'part_spinner_before'),
      partRemovedEvent(COLD_ASSISTANT_MESSAGE_ID, 'part_spinner_after'),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('probe');
  });

  // The documented cleanup-failure case: the transient marker alone must exclude
  // the part, because the removal event never arrives.
  it('excludes a transient part whose removal event never arrived', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'probe'),
      textPartEvent('part_spinner', COLD_ASSISTANT_MESSAGE_ID, '⠋ Initializing snapshot…', {
        metadata: { 'kilocode.lifecycle': 'transient' },
      }),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('probe');
  });

  it('excludes a matching-parent message with a non-assistant role', () => {
    const events = [
      messageEvent('user', COLD_MESSAGE_ID, 'message_user'),
      textPartEvent('part_user', 'message_user', 'leaked'),
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'hi'),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('hi');
  });

  it('selects a text part by messageID even when part.parentID is unrelated or absent', () => {
    const withForeignParentId = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'hi', {
        parentID: 'message_someone_else',
      }),
    ];
    const withoutParentId = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'hi'),
    ];

    expect(collectChildMessageText(withForeignParentId, COLD_MESSAGE_ID)).toBe('hi');
    expect(collectChildMessageText(withoutParentId, COLD_MESSAGE_ID)).toBe('hi');
  });

  it('excludes parts whose message belongs to a different parent', () => {
    const events = [
      assistantMessageEvent('message_other_user', 'message_other_assistant'),
      textPartEvent('part_other', 'message_other_assistant', 'nope'),
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'hi'),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('hi');
  });

  it('ignores unknown event shapes instead of throwing', () => {
    const events = [
      streamEvent('kilocode', { type: 'message.part.updated', properties: {} }),
      streamEvent('kilocode', { type: 'message.updated' }),
      streamEvent('other', { type: 'message.updated', properties: { info: {} } }),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('');
  });

  it('drops a tracked part whose removal event follows its update', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'hello'),
      partRemovedEvent(COLD_ASSISTANT_MESSAGE_ID, COLD_TEXT_PART_ID),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('');
  });

  it('contributes a part again after a removal followed by a re-update', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'stale'),
      partRemovedEvent(COLD_ASSISTANT_MESSAGE_ID, COLD_TEXT_PART_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'fresh'),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('fresh');
  });

  it('is a no-op when the removal targets an untracked part or message', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'hello'),
      partRemovedEvent(COLD_ASSISTANT_MESSAGE_ID, 'part_unknown'),
      messageRemovedEvent('message_unknown'),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('hello');
  });

  it('drops a child message whose message.removed event follows its update', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'hello'),
      messageRemovedEvent(COLD_ASSISTANT_MESSAGE_ID),
    ];

    expect(collectChildMessageText(events, COLD_MESSAGE_ID)).toBe('');
  });
});

describe('hasCorrelatedStreamProgress', () => {
  it('counts a transient text part for the paced child', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'streaming', {
        metadata: { 'kilocode.lifecycle': 'transient' },
      }),
    ];

    expect(hasCorrelatedStreamProgress(events, COLD_MESSAGE_ID)).toBe(true);
  });

  it('counts the empty transient initialization part as liveness for the paced child', () => {
    // Observed live: the paced child's only correlated part can be an empty
    // transient init part, so the predicate is a liveness check only. Proof that
    // the model was dialed comes from the request counter, not from content.
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, '', {
        metadata: { 'kilocode.lifecycle': 'transient' },
      }),
    ];

    expect(hasCorrelatedStreamProgress(events, COLD_MESSAGE_ID)).toBe(true);
  });

  it('counts any correlated part regardless of type', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      streamEvent('kilocode', {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool',
            messageID: COLD_ASSISTANT_MESSAGE_ID,
            type: 'tool',
            text: 'not-content',
          },
        },
      }),
    ];

    expect(hasCorrelatedStreamProgress(events, COLD_MESSAGE_ID)).toBe(true);
  });

  it('does not count a part for an unrelated message', () => {
    const events = [
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
      textPartEvent('part_other', 'message_other_assistant', 'nope'),
    ];

    expect(hasCorrelatedStreamProgress(events, COLD_MESSAGE_ID)).toBe(false);
  });

  it('does not count lifecycle-only events', () => {
    const events = [
      kilocodeEvent(),
      preparingEvent(COLD_MESSAGE_ID),
      messageEvent('user', 'message_parent', 'message_user'),
    ];

    expect(hasCorrelatedStreamProgress(events, COLD_MESSAGE_ID)).toBe(false);
  });

  it('counts a correlated part seen before its child message.updated', () => {
    const events = [
      textPartEvent(COLD_TEXT_PART_ID, COLD_ASSISTANT_MESSAGE_ID, 'streaming', {
        metadata: { 'kilocode.lifecycle': 'transient' },
      }),
      assistantMessageEvent(COLD_MESSAGE_ID, COLD_ASSISTANT_MESSAGE_ID),
    ];

    expect(hasCorrelatedStreamProgress(events, COLD_MESSAGE_ID)).toBe(true);
  });
});

describe('trailingNonEmptyLine', () => {
  it('returns the trailing non-empty line of the correlated text', () => {
    // The wrapper's own progress line precedes the answer, LF- or CR-separated.
    expect(trailingNonEmptyLine('⠸ Initializing snapshot…\nhi')).toBe('hi');
    expect(trailingNonEmptyLine('⠸ Initializing snapshot…\rhi')).toBe('hi');

    // Trailing whitespace or a final newline after the payload is not the answer.
    expect(trailingNonEmptyLine('⠸ Initializing snapshot…\nhi\n')).toBe('hi');
    expect(trailingNonEmptyLine('⠸ Initializing snapshot…\n  hi  ')).toBe('hi');

    // No non-empty line at all yields the empty string.
    expect(trailingNonEmptyLine('')).toBe('');
    expect(trailingNonEmptyLine('   \n\r\n\t')).toBe('');

    // A payload that is not the final line is not the answer.
    expect(trailingNonEmptyLine('hi\ntrailing noise')).toBe('trailing noise');
  });
});

describe('echoPayloadMatches', () => {
  it('passes when an ANSI spinner status and the answer share one line', () => {
    expect(echoPayloadMatches('⠋ Initializing snapshot…hi', 'hi')).toBe(true);
  });

  it('passes when the observed text is exactly the payload', () => {
    expect(echoPayloadMatches('hi', 'hi')).toBe(true);
  });

  it('fails when the payload is glued to a payload-class character', () => {
    expect(echoPayloadMatches('somethinghi', 'hi')).toBe(false);
  });

  it('fails when the payload is not at the end', () => {
    expect(echoPayloadMatches('hi there', 'hi')).toBe(false);
  });

  it('fails when the observed text ends without the payload', () => {
    expect(echoPayloadMatches('⠋ Initializing snapshot…', 'hi')).toBe(false);
  });

  it('fails on empty observed text', () => {
    expect(echoPayloadMatches('', 'hi')).toBe(false);
  });

  it('fails when the preceding character is inside the payload class', () => {
    expect(echoPayloadMatches('_hi', 'hi')).toBe(false);
    expect(echoPayloadMatches('-hi', 'hi')).toBe(false);
  });
});

describe('echoDirectivePayload', () => {
  it.each([
    ['echo:hi', 'hi'],
    ['echo:_token-1', '_token-1'],
  ])('extracts the token for the literal echo:<token> form %s', (directive, expected) => {
    expect(echoDirectivePayload(directive)).toBe(expected);
  });

  it.each(['realistic:hello', 'slow:3:50', 'echo', 'echo:', 'echo:hi:there', 'echo:not a token'])(
    'returns null for %s (the assertion runs only for echo:<token>)',
    directive => {
      expect(echoDirectivePayload(directive)).toBeNull();
    }
  );
});

describe('auth-reject probes', () => {
  const input = {
    fakeLlmRootUrl: 'https://fake.example.test/',
    adminToken: 'admin-token',
    modelToken: 'model-token',
    badSignatureToken: 'bad-signature-token',
  };

  function probeNamed(probes: AuthProbe[], name: string): AuthProbe {
    const probe = probes.find(candidate => candidate.name === name);
    if (!probe) throw new Error(`missing probe ${name}`);
    return probe;
  }

  it('composes the four unauthenticated model probes after stripping a trailing slash', () => {
    const probes = buildAuthRejectProbes(input).filter(
      probe => probe.name.startsWith('model-') && probe.name.endsWith('-no-bearer')
    );

    expect(probes).toHaveLength(4);
    expect(probes.map(probe => `${probe.method} ${probe.url}`)).toEqual([
      'GET https://fake.example.test/api/openrouter/models',
      'POST https://fake.example.test/api/openrouter/models/validate',
      'POST https://fake.example.test/api/openrouter/chat/completions',
      'POST https://fake.example.test/api/openrouter/audio/transcriptions',
    ]);
    for (const probe of probes) {
      expect(probe.headers).toEqual({});
      expect(probe.expectedStatuses).toEqual([401]);
    }
  });

  it('expects 401 for a malformed bearer and for a JWT signed with a wrong secret', () => {
    const probes = buildAuthRejectProbes(input);

    expect(probeNamed(probes, 'model-models-malformed-bearer')).toMatchObject({
      method: 'GET',
      url: 'https://fake.example.test/api/openrouter/models',
      headers: { Authorization: 'Bearer not-a-jwt' },
      expectedStatuses: [401],
    });
    expect(probeNamed(probes, 'model-models-wrong-signature')).toMatchObject({
      headers: { Authorization: 'Bearer bad-signature-token' },
      expectedStatuses: [401],
    });
  });

  it('uses the real model token for the positive control and expects 200', () => {
    const probe = probeNamed(buildAuthRejectProbes(input), 'model-models-positive-control');

    expect(probe.method).toBe('GET');
    expect(probe.url).toBe('https://fake.example.test/api/openrouter/models');
    expect(probe.headers).toEqual({ Authorization: 'Bearer model-token' });
    expect(probe.expectedStatuses).toEqual([200]);
  });

  it('guards all five control routes and admits the admin bearer', () => {
    const probes = buildAuthRejectProbes(input).filter(probe => probe.name.startsWith('control-'));

    expect(probes).toHaveLength(10);
    const authorized = probes.filter(probe => !probe.name.endsWith('-no-admin'));
    const unauthenticated = probes.filter(probe => probe.name.endsWith('-no-admin'));
    expect(authorized).toHaveLength(5);
    expect(unauthenticated).toHaveLength(5);
    for (const probe of authorized) {
      expect(probe.headers).toEqual({ Authorization: 'Bearer admin-token' });
      expect(probe.expectedStatuses).toEqual([200, 204, 400, 404]);
    }
    for (const probe of unauthenticated) {
      expect(probe.headers).toEqual({});
      expect(probe.expectedStatuses).toEqual([401]);
    }
  });

  it('composes both crossover probes', () => {
    const probes = buildAuthRejectProbes(input);

    expect(probeNamed(probes, 'crossover-admin-on-models')).toMatchObject({
      url: 'https://fake.example.test/api/openrouter/models',
      headers: { Authorization: 'Bearer admin-token' },
      expectedStatuses: [401],
    });
    expect(probeNamed(probes, 'crossover-model-on-test-requests')).toMatchObject({
      url: 'https://fake.example.test/test/requests',
      headers: { Authorization: 'Bearer model-token' },
      expectedStatuses: [401],
    });
  });
});

describe('classifyAuthProbe', () => {
  const probe: AuthProbe = {
    name: 'probe',
    url: 'https://fake.example.test/test/requests',
    method: 'GET',
    headers: {},
    expectedStatuses: [401],
  };

  it('passes on an expected status', () => {
    expect(classifyAuthProbe(probe, { status: 401 })).toEqual({
      ok: true,
      detail: 'probe: 401 as expected',
    });
  });

  it('fails on an unexpected status', () => {
    const result = classifyAuthProbe(probe, { status: 200 });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('probe: expected 401, observed 200');
  });

  it('fails a transport error instead of treating it as a pass', () => {
    const result = classifyAuthProbe(probe, { status: null, error: new Error('aborted') });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('probe: transport error');
    expect(result.detail).toContain('aborted');
  });
});

describe('sendAuthProbe deadline', () => {
  const probe: AuthProbe = {
    name: 'probe',
    url: 'https://fake.example.test/api/openrouter/models',
    method: 'GET',
    headers: {},
    expectedStatuses: [200],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aborts the request signal at the deadline', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('request aborted')));
        });
      })
    );

    const outcome = await sendAuthProbe(probe, 5);

    expect(outcome.status).toBeNull();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });
});

describe('auth-reject scenario', () => {
  let previousAdminToken: string | undefined;

  beforeEach(() => {
    previousAdminToken = process.env.FAKE_LLM_ADMIN_TOKEN;
    process.env.FAKE_LLM_ADMIN_TOKEN = ADMIN_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousAdminToken === undefined) delete process.env.FAKE_LLM_ADMIN_TOKEN;
    else process.env.FAKE_LLM_ADMIN_TOKEN = previousAdminToken;
  });

  function fakeAuthFetch(
    respond: (url: string, init: RequestInit) => number
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string, init?: RequestInit) => {
      return new Response(null, { status: respond(url, init ?? {}) });
    });
  }

  it('is unsupported under the local profile', async () => {
    const result = await authReject({ config, conversation: '_' }, localEnvironment(sandboxStub()));

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(result.message).toContain('deployedHttpAuthBoundary');
  });

  it('passes when every probe matches the deployed auth boundary', async () => {
    vi.stubGlobal(
      'fetch',
      fakeAuthFetch((url, init) => {
        const authorization = (init.headers as Record<string, string>).Authorization;
        if (url.includes('/test/')) return authorization === `Bearer ${ADMIN_TOKEN}` ? 200 : 401;
        return authorization === `Bearer ${MODEL_TOKEN}` ? 200 : 401;
      })
    );

    const result = await authReject({ config, conversation: '_' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('auth probes matched');
  });

  it('fails and names the probe when an unauthenticated model route returns 200', async () => {
    vi.stubGlobal(
      'fetch',
      fakeAuthFetch((url, init) => {
        const authorization = (init.headers as Record<string, string>).Authorization;
        if (url.endsWith('/api/openrouter/models') && !authorization) return 200;
        if (url.includes('/test/')) return authorization === `Bearer ${ADMIN_TOKEN}` ? 200 : 401;
        return authorization === `Bearer ${MODEL_TOKEN}` ? 200 : 401;
      })
    );

    const result = await authReject({ config, conversation: '_' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('model-models-no-bearer');
    expect(result.message).toContain('observed 200');
  });

  it('fails clearly when the deployed profile has no model bearer', async () => {
    const result = await authReject({
      config: { ...config, bearerToken: undefined },
      conversation: '_',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('bearerToken');
  });

  it('fails at the positive control when the fake rejects every bearer', async () => {
    vi.stubGlobal(
      'fetch',
      fakeAuthFetch(() => 401)
    );

    const result = await authReject({ config, conversation: '_' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('model-models-positive-control');
  });

  it('passes a per-request AbortSignal on every probe', async () => {
    // This proves a signal is attached; `sendAuthProbe deadline` proves it is
    // actually deadline-bounded.
    const signals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (url.includes('/test/')) {
          return new Response(null, {
            status: authorization === `Bearer ${ADMIN_TOKEN}` ? 200 : 401,
          });
        }
        return new Response(null, {
          status: authorization === `Bearer ${MODEL_TOKEN}` ? 200 : 401,
        });
      })
    );

    const result = await authReject({ config, conversation: '_' });

    expect(result.ok).toBe(true);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });
});

describe('moved streaming and failure scenarios', () => {
  const names = ['chunked-streaming', 'empty-response', 'waiters-clean', 'llm-error'];

  it.each(names)('%s is admitted through the sessionSandbox capability', async name => {
    const { SHARED_SCENARIOS } = await import('../../e2e/scenarios-shared.js');
    const definition = SHARED_SCENARIOS[name];
    expect(definition).toBeDefined();
    expect(definition.requires).toEqual(['sessionSandbox']);
    expect(definition.defaultConversation.length).toBeGreaterThan(0);
    expect(typeof definition.run).toBe('function');
  });

  it.each(names)('%s is unsupported without an injected sessionSandbox', async name => {
    const { SHARED_SCENARIOS } = await import('../../e2e/scenarios-shared.js');
    const result = await runSharedScenario(SHARED_SCENARIOS[name], {
      config,
      conversation: SHARED_SCENARIOS[name].defaultConversation,
      env: {
        profile: 'deployed',
        requireControlPlaneSession: true,
        deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
      },
    });
    expect(result.unsupported).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe('moved callback scenarios', () => {
  const names = ['callback-completion', 'callback-batch-followup', 'callback-interrupt'];

  it.each(names)(
    '%s is admitted through callbacks + sessionSandbox and pins the legacy flow',
    async name => {
      const { SHARED_SCENARIOS } = await import('../../e2e/scenarios-shared.js');
      const definition = SHARED_SCENARIOS[name];
      expect(definition).toBeDefined();
      expect(definition.requires).toEqual(['callbacks', 'sessionSandbox']);
      expect(definition.defaultApi).toBe('legacy');
      expect(definition.defaultConversation.length).toBeGreaterThan(0);
      expect(typeof definition.run).toBe('function');
    }
  );

  it.each(names)('%s is unsupported without the callbacks capability', async name => {
    const { SHARED_SCENARIOS } = await import('../../e2e/scenarios-shared.js');
    const result = await runSharedScenario(SHARED_SCENARIOS[name], {
      config,
      conversation: SHARED_SCENARIOS[name].defaultConversation,
      env: {
        profile: 'deployed',
        requireControlPlaneSession: true,
        sessionSandbox: {
          waitForContainer: async () => null,
          currentContainer: async () => null,
        },
      },
    });
    expect(result.unsupported).toBe(true);
    expect(result.message).toContain('callbacks');
  });

  it.each(names)('%s is unsupported without the sessionSandbox capability', async name => {
    const { SHARED_SCENARIOS } = await import('../../e2e/scenarios-shared.js');
    const result = await runSharedScenario(SHARED_SCENARIOS[name], {
      config,
      conversation: SHARED_SCENARIOS[name].defaultConversation,
      env: {
        profile: 'deployed',
        requireControlPlaneSession: true,
        callbacks: {
          open: async () => {
            throw new Error('open must not be called when the gate rejects');
          },
        },
      },
    });
    expect(result.unsupported).toBe(true);
    expect(result.message).toContain('sessionSandbox');
  });
});

describe('shared dispatch API resolution', () => {
  function passingScenarioResult(name: string, conversation: string): LifecycleResult {
    return { name, conversation, ok: true, message: 'ran', events: [], durationMs: 0 };
  }

  function dispatchEnv(): ScenarioEnvironment {
    return {
      profile: 'deployed',
      requireControlPlaneSession: true,
      sessionSandbox: {
        waitForContainer: async () => null,
        currentContainer: async () => null,
      },
      callbacks: {
        open: async () => {
          throw new Error('open must not be called: these tests override run');
        },
      },
    };
  }

  it('injects the callback definition pin when the API argument is omitted', async () => {
    const run = vi.fn(async (a: LifecycleArgs) =>
      passingScenarioResult('callback-completion', a.conversation)
    );

    const result = await runSharedScenario(
      { ...SHARED_SCENARIOS['callback-completion'], run },
      { config, conversation: 'echo:done', env: dispatchEnv() }
    );

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ api: 'legacy' }), expect.anything());
  });

  it('fails clearly and runs nothing when an explicit API conflicts with the callback pin', async () => {
    const run = vi.fn(async () => {
      throw new Error('run must not be called');
    });

    const result = await runSharedScenario(
      { ...SHARED_SCENARIOS['callback-completion'], run },
      { config, conversation: 'echo:done', api: 'unified', env: dispatchEnv() }
    );

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBeUndefined();
    expect(result.message).toContain('requires the legacy API');
    expect(result.message).toContain('--api=unified conflicts with it');
    expect(run).not.toHaveBeenCalled();
  });

  it('honours an explicit legacy selection for an unpinned definition', async () => {
    const run = vi.fn(async (a: LifecycleArgs) =>
      passingScenarioResult('cold-hot', a.conversation)
    );

    const result = await runSharedScenario(
      { ...SHARED_SCENARIOS['cold-hot'], run },
      { config, conversation: 'echo:hi', api: 'legacy', env: dispatchEnv() }
    );

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ api: 'legacy' }), expect.anything());
  });
});

describe('callback scenario behaviour under both profiles', () => {
  const profiles = ['local', 'local-http'] as const;

  beforeEach(() => {
    mocks.releaseGate.mockResolvedValue(undefined);
    mocks.waitForGateEngaged.mockResolvedValue(true);
    mocks.gateEngagementDetail.mockResolvedValue('gate did not engage');
  });

  function fakeSessionSandbox(): SessionSandboxObservation {
    return {
      waitForContainer: vi.fn(async () => 'container_cb'),
      currentContainer: vi.fn(async () => 'container_cb'),
    };
  }

  function callbackEnvironment(
    profile: (typeof profiles)[number],
    callbacks: CallbackObservation,
    sessionSandbox: SessionSandboxObservation
  ): ScenarioEnvironment {
    if (profile === 'local') {
      return {
        profile: 'local',
        requireControlPlaneSession: false,
        sandbox: sandboxStub(),
        sessionSandbox,
        callbacks,
      };
    }
    return {
      profile: 'local-http',
      requireControlPlaneSession: true,
      sessionSandbox,
      callbacks,
    };
  }

  type FakeCallbackSink = {
    observation: CallbackObservation;
    push(payload: CallbackPayload): void;
    closed: ReturnType<typeof vi.fn>;
  };

  function fakeCallbackSink(): FakeCallbackSink {
    const payloads: CallbackPayload[] = [];
    const closed = vi.fn(async () => {});
    return {
      push: payload => {
        payloads.push(payload);
      },
      closed,
      observation: {
        open: async () => ({
          callbackUrl: 'https://sink.example.test/cb',
          records: async () => [...payloads],
          waitFor: async (predicate, _timeoutMs) => payloads.find(predicate) ?? null,
          close: closed,
        }),
      },
    };
  }

  function startCallbackSession(messageId: string): void {
    mocks.startSession.mockResolvedValue({
      cloudAgentSessionId: SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      messageId,
      delivery: 'sent',
    });
  }

  it.each(profiles)('callback-completion passes in the %s profile', async profile => {
    const sink = fakeCallbackSink();
    startCallbackSession('message_completion');
    mocks.openStream.mockReturnValue(fakeStream([], completedEvent('message_completion')));
    sink.push({
      cloudAgentSessionId: SESSION_ID,
      messageId: 'message_completion',
      status: 'completed',
      lastAssistantMessageText: 'done',
    });

    const result = await runSharedScenario(SHARED_SCENARIOS['callback-completion'], {
      config,
      conversation: 'echo:done',
      api: 'legacy',
      env: callbackEnvironment(profile, sink.observation, fakeSessionSandbox()),
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('status=completed');
    // The scenario forwards every config field and adds its own tracking hook so
    // a prepare/initiation failure can still reach the prepared session.
    expect(mocks.startSession).toHaveBeenCalledWith(
      expect.objectContaining(config),
      expect.objectContaining({ callbackTarget: { url: 'https://sink.example.test/cb' } }),
      'legacy'
    );
    const startConfig = mocks.startSession.mock.calls[0]?.[0];
    expect(startConfig?.onSessionCreated).toBeInstanceOf(Function);
    // Finished work is not interrupted on the success path.
    expect(mocks.interruptSession).not.toHaveBeenCalled();
    expect(sink.closed).toHaveBeenCalledTimes(1);
  });

  it('callback-completion interrupts unfinished work on a mismatch', async () => {
    const sink = fakeCallbackSink();
    startCallbackSession('message_completion');
    mocks.openStream.mockReturnValue(fakeStream([], completedEvent('message_completion')));
    sink.push({
      cloudAgentSessionId: SESSION_ID,
      messageId: 'message_completion',
      status: 'interrupted',
      lastAssistantMessageText: 'done',
    });

    const result = await runSharedScenario(SHARED_SCENARIOS['callback-completion'], {
      config,
      conversation: 'echo:done',
      api: 'legacy',
      env: callbackEnvironment('local-http', sink.observation, fakeSessionSandbox()),
    });

    expect(result.ok).toBe(false);
    expect(mocks.interruptSession).toHaveBeenCalledWith(config, SESSION_ID);
  });

  it('interrupts the prepared session when a two-step start fails between prepare and initiation', async () => {
    const sink = fakeCallbackSink();
    const preparedId = 'workspace_prepared_partial';
    // The legacy prepare path reports the session id through onSessionCreated
    // before initiation; the scenario must reach that id for its failure-path
    // interrupt even though `startSession` never returns.
    mocks.startSession.mockImplementation(async (startConfig: DriverConfig) => {
      startConfig.onSessionCreated?.(preparedId);
      throw new Error('initiateFromKilocodeSessionV2 failed');
    });

    const result = await runSharedScenario(SHARED_SCENARIOS['callback-completion'], {
      config,
      conversation: 'echo:done',
      api: 'legacy',
      env: callbackEnvironment('local-http', sink.observation, fakeSessionSandbox()),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('initiateFromKilocodeSessionV2 failed');
    expect(mocks.interruptSession).toHaveBeenCalledWith(config, preparedId);
  });

  it.each(profiles)('callback-interrupt passes in the %s profile', async profile => {
    const sink = fakeCallbackSink();
    startCallbackSession('message_interrupt');
    mocks.openStream.mockReturnValue(
      fakeStream([], streamEvent('interrupted', { messageId: 'message_interrupt' }))
    );
    mocks.waitForGateEngaged.mockResolvedValue(true);
    sink.push({
      cloudAgentSessionId: SESSION_ID,
      messageId: 'message_interrupt',
      status: 'interrupted',
    });

    const result = await runSharedScenario(SHARED_SCENARIOS['callback-interrupt'], {
      config,
      conversation: '_',
      api: 'legacy',
      env: callbackEnvironment(profile, sink.observation, fakeSessionSandbox()),
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('status=interrupted');
    expect(mocks.interruptSession).toHaveBeenCalledWith(config, SESSION_ID);
    expect(mocks.releaseGate).toHaveBeenCalled();
  });

  it('callback-interrupt interrupts the created session when the gate never engages', async () => {
    const sink = fakeCallbackSink();
    startCallbackSession('message_interrupt');
    mocks.openStream.mockReturnValue(fakeStream([], completedEvent('message_interrupt')));
    mocks.waitForGateEngaged.mockResolvedValue(false);
    mocks.gateEngagementDetail.mockResolvedValue('gate:callback-interrupt did not engage');

    const result = await runSharedScenario(SHARED_SCENARIOS['callback-interrupt'], {
      config,
      conversation: '_',
      api: 'legacy',
      env: callbackEnvironment('local-http', sink.observation, fakeSessionSandbox()),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe('gate:callback-interrupt did not engage');
    expect(mocks.interruptSession).toHaveBeenCalledWith(config, SESSION_ID);
    expect(mocks.releaseGate).toHaveBeenCalled();
  });

  it.each(profiles)(
    'callback-batch-followup passes in the %s profile',
    async profile => {
      const sink = fakeCallbackSink();
      startCallbackSession('message_first');
      sink.push({
        cloudAgentSessionId: SESSION_ID,
        messageId: 'message_third',
        status: 'completed',
        lastAssistantMessageText: 'third',
      });
      mocks.sendMessage.mockImplementation(async (_config, args: { prompt: string }) => {
        if (args.prompt.includes('after-batch')) {
          sink.push({
            cloudAgentSessionId: SESSION_ID,
            messageId: 'message_after',
            status: 'completed',
            lastAssistantMessageText: 'after-batch',
          });
          return { messageId: 'message_after', delivery: 'sent' as const };
        }
        if (args.prompt.includes('second')) {
          return { messageId: 'message_second', delivery: 'queued' as const };
        }
        if (args.prompt.includes('third')) {
          return { messageId: 'message_third', delivery: 'queued' as const };
        }
        throw new Error(`unexpected sendMessage prompt: ${args.prompt}`);
      });
      mocks.openStream.mockReturnValue(
        fakeStream(
          [completedEvent('message_third'), completedEvent('message_after')],
          completedEvent('message_first')
        )
      );
      mocks.waitForGateEngaged.mockResolvedValue(true);

      const result = await runSharedScenario(SHARED_SCENARIOS['callback-batch-followup'], {
        config,
        conversation: '_',
        api: 'legacy',
        env: callbackEnvironment(profile, sink.observation, fakeSessionSandbox()),
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain('message_third -> message_after');
      expect(mocks.interruptSession).not.toHaveBeenCalled();
    },
    15_000
  );

  it('callback-batch-followup rejects a callback that arrives during the quiet window', async () => {
    const third: CallbackPayload = {
      cloudAgentSessionId: SESSION_ID,
      messageId: 'message_third',
      status: 'completed',
      lastAssistantMessageText: 'third',
    };
    const after: CallbackPayload = {
      cloudAgentSessionId: SESSION_ID,
      messageId: 'message_after',
      status: 'completed',
      lastAssistantMessageText: 'after-batch',
    };
    const extra: CallbackPayload = {
      cloudAgentSessionId: SESSION_ID,
      messageId: 'message_extra',
      status: 'completed',
      lastAssistantMessageText: 'extra',
    };
    // Call 1 validates the queued batch, call 2 the sequential pair, call 3 is
    // the quiet probe. The old body re-read the count at call 3 as its
    // baseline, so the extra record hid itself; the validated baseline of two
    // must reject it.
    let recordsCalls = 0;
    const observation: CallbackObservation = {
      open: async () => ({
        callbackUrl: 'https://sink.example.test/cb',
        records: async () => {
          recordsCalls += 1;
          if (recordsCalls === 1) return [third];
          if (recordsCalls === 2) return [third, after];
          return [third, after, extra];
        },
        waitFor: async predicate => [third, after].find(predicate) ?? null,
        close: async () => {},
      }),
    };
    startCallbackSession('message_first');
    mocks.sendMessage
      .mockResolvedValueOnce({ messageId: 'message_second', delivery: 'queued' })
      .mockResolvedValueOnce({ messageId: 'message_third', delivery: 'queued' })
      .mockResolvedValueOnce({ messageId: 'message_after', delivery: 'sent' });
    mocks.openStream.mockReturnValue(
      fakeStream(
        [completedEvent('message_third'), completedEvent('message_after')],
        completedEvent('message_first')
      )
    );
    mocks.waitForGateEngaged.mockResolvedValue(true);

    const result = await runSharedScenario(SHARED_SCENARIOS['callback-batch-followup'], {
      config,
      conversation: '_',
      api: 'legacy',
      env: callbackEnvironment('local-http', observation, fakeSessionSandbox()),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('unexpected extra callback');
    expect(result.message).toContain('message_extra');
  }, 15_000);
});

describe('moved queue, micro, and continuity scenarios', () => {
  const names = [
    'queue-while-busy',
    'queue-rapid-fire-no-gate',
    'queue-overflow',
    'queue-interrupt-clears',
    'interrupt-mid-stream',
    'interrupt-then-continue',
    'cold',
    'hot',
    'followup',
  ];

  it.each(names)('%s is admitted through the sessionSandbox capability', name => {
    const definition = SHARED_SCENARIOS[name];
    expect(definition).toBeDefined();
    expect(definition?.name).toBe(name);
    expect(definition?.requires).toEqual(['sessionSandbox']);
  });
});

describe('public-surface worktree and conversation scenarios', () => {
  const names = ['worktree-chat', 'worktree-multi-chat', 'long-conversation', 'leave-and-return'];

  it.each(names)('%s is registered as a long-running unified scenario', name => {
    const definition = SHARED_SCENARIOS[name];
    expect(definition).toBeDefined();
    expect(definition?.name).toBe(name);
    expect(definition?.requires).toEqual(['sessionSandbox']);
    expect(definition?.defaultApi).toBe('unified');
    expect(definition?.defaultConversation.length).toBeGreaterThan(0);
    expect(typeof definition?.run).toBe('function');
  });

  it.each(names)('%s is unsupported when the profile has no sessionSandbox', async name => {
    const definition = SHARED_SCENARIOS[name];
    expect(definition).toBeDefined();
    const result = await runSharedScenario(definition!, {
      config,
      conversation: definition!.defaultConversation,
      api: definition!.defaultApi ?? 'unified',
      env: deployedEnvironment(),
    });

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(result.message).toContain('sessionSandbox');
  });
});

function queueHttpEnvironment(): ScenarioEnvironment {
  return {
    profile: 'local-http',
    requireControlPlaneSession: true,
    sessionSandbox: {
      waitForContainer: vi.fn(async () => 'container_queue'),
      currentContainer: vi.fn(async () => 'container_queue'),
    },
  };
}

function startQueueSession(messageId: string): void {
  mocks.startSession.mockResolvedValue({
    cloudAgentSessionId: SESSION_ID,
    kiloSessionId: KILO_SESSION_ID,
    messageId,
    delivery: 'sent',
  });
}

function interruptedQueuedEvent(messageId: string): StreamEvent {
  return streamEvent('cloud.message.failed', {
    messageId,
    reason: 'interrupted',
    delivery: 'queued',
  });
}

describe('moved queue scenario run isolation', () => {
  beforeEach(() => {
    mocks.waitForGateEngaged.mockResolvedValue(false);
    mocks.gateEngagementDetail.mockResolvedValue('gate did not engage');
    mocks.releaseGate.mockResolvedValue(undefined);
  });

  it('uses a run-scoped overflow tag and releases it on the failure path', async () => {
    startQueueSession('message_gate');
    mocks.openStream.mockReturnValue(fakeStream([], completedEvent('message_gate')));

    const result = await runSharedScenario(SHARED_SCENARIOS['queue-overflow'], {
      config,
      conversation: '_',
      api: 'unified',
      env: queueHttpEnvironment(),
    });

    expect(result.ok).toBe(false);
    const tag = result.message.match(/overflow-[0-9a-f-]{36}/)?.[0];
    expect(tag).toBeDefined();
    expect(mocks.releaseGate).toHaveBeenCalledWith(config.fakeLlmUrl, tag, expect.any(AbortSignal));
  });

  it('uses a run-scoped intgate tag and releases it on the failure path', async () => {
    startQueueSession('message_gate');
    mocks.openStream.mockReturnValue(fakeStream([], completedEvent('message_gate')));

    const result = await runSharedScenario(SHARED_SCENARIOS['queue-interrupt-clears'], {
      config,
      conversation: '_',
      api: 'unified',
      env: queueHttpEnvironment(),
    });

    expect(result.ok).toBe(false);
    const tag = result.message.match(/intgate-[0-9a-f-]{36}/)?.[0];
    expect(tag).toBeDefined();
    expect(mocks.releaseGate).toHaveBeenCalledWith(config.fakeLlmUrl, tag, expect.any(AbortSignal));
  });
});

describe('owned gate leak detection', () => {
  function installInterruptClearsSuccess(): void {
    startQueueSession('message_gate');
    mocks.waitForGateEngaged.mockResolvedValue(true);
    mocks.sendMessage
      .mockResolvedValueOnce({ messageId: 'message_second', delivery: 'queued' })
      .mockResolvedValueOnce({ messageId: 'message_third', delivery: 'queued' });
    mocks.openStream.mockReturnValue(
      fakeStream(
        [interruptedQueuedEvent('message_second'), interruptedQueuedEvent('message_third')],
        completedEvent('message_gate')
      )
    );
    mocks.interruptSession.mockResolvedValue({ success: true });
  }

  it('fails a scenario that cannot release a tag it still owns', async () => {
    installInterruptClearsSuccess();
    mocks.releaseGate.mockRejectedValue(
      new Error('releaseGate(intgate-x) failed: 500 Internal Server Error')
    );

    const result = await runSharedScenario(SHARED_SCENARIOS['queue-interrupt-clears'], {
      config,
      conversation: '_',
      api: 'unified',
      env: queueHttpEnvironment(),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('ownedGateLeak');
  });

  it('treats a release 404 as already released, not a leak', async () => {
    installInterruptClearsSuccess();
    mocks.releaseGate.mockRejectedValue(new Error('releaseGate(intgate-x) failed: 404 Not Found'));

    const result = await runSharedScenario(SHARED_SCENARIOS['queue-interrupt-clears'], {
      config,
      conversation: '_',
      api: 'unified',
      env: queueHttpEnvironment(),
    });

    expect(result.ok).toBe(true);
    expect(result.message).not.toContain('ownedGateLeak');
  });
});

describe('moved micro scenarios', () => {
  it.each(['local', 'local-http'] as const)(
    'cold observes physical identity through sessionSandbox in the %s profile',
    async profile => {
      startQueueSession('message_cold');
      mocks.openConnectedStream.mockResolvedValue(fakeStream([], completedEvent('message_cold')));
      const waitForContainer = vi.fn(async () => 'container_micro');
      const sessionSandbox: SessionSandboxObservation = {
        waitForContainer,
        currentContainer: vi.fn(async () => 'container_micro'),
      };
      const env: ScenarioEnvironment =
        profile === 'local'
          ? { profile, requireControlPlaneSession: false, sandbox: sandboxStub(), sessionSandbox }
          : { profile, requireControlPlaneSession: true, sessionSandbox };

      const result = await runSharedScenario(SHARED_SCENARIOS['cold'], {
        config,
        conversation: 'echo:hi',
        api: 'unified',
        env,
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain('container_micro');
      expect(waitForContainer).toHaveBeenCalledWith({
        cloudAgentSessionId: SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
        timeoutMs: expect.any(Number),
      });
    }
  );

  it('hot compares the physical container before and after the warm follow-up', async () => {
    startQueueSession('message_warm');
    mocks.openConnectedStream
      .mockResolvedValueOnce(fakeStream([], completedEvent('message_warm')))
      .mockResolvedValueOnce(fakeStream([], completedEvent('message_hot')));
    mocks.sendMessage.mockResolvedValue({ messageId: 'message_hot', delivery: 'sent' });
    const currentContainer = vi.fn(async () => 'container_hot');
    const env: ScenarioEnvironment = {
      profile: 'local-http',
      requireControlPlaneSession: true,
      sessionSandbox: {
        waitForContainer: vi.fn(async () => 'container_hot'),
        currentContainer,
      },
    };

    const result = await runSharedScenario(SHARED_SCENARIOS['hot'], {
      config,
      conversation: 'echo:hi',
      api: 'unified',
      env,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('sameContainer=true');
    expect(currentContainer).toHaveBeenCalledTimes(1);
  });

  it('hot fails when the warm follow-up creates an extra container', async () => {
    startQueueSession('message_warm');
    mocks.openConnectedStream
      .mockResolvedValueOnce(fakeStream([], completedEvent('message_warm')))
      .mockResolvedValueOnce(fakeStream([], completedEvent('message_hot')));
    mocks.sendMessage.mockResolvedValue({ messageId: 'message_hot', delivery: 'sent' });
    let snapshot = 0;
    const inventory = sandboxStub({
      snapshotContainerIds: vi.fn(async () => {
        snapshot += 1;
        return snapshot === 1
          ? new Set(['container_warm'])
          : new Set(['container_warm', 'container_extra']);
      }),
    });
    const env: ScenarioEnvironment = {
      profile: 'local',
      requireControlPlaneSession: false,
      sandbox: inventory,
      sessionSandbox: {
        waitForContainer: vi.fn(async () => 'container_warm'),
        currentContainer: vi.fn(async () => 'container_warm'),
      },
    };

    const result = await runSharedScenario(SHARED_SCENARIOS['hot'], {
      config,
      conversation: 'echo:hi',
      api: 'unified',
      env,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('sameContainers=false');
    expect(result.message).toContain('container_extra');
  });

  it('hot fails when the warm container disappears before the follow-up', async () => {
    startQueueSession('message_warm');
    mocks.openConnectedStream
      .mockResolvedValueOnce(fakeStream([], completedEvent('message_warm')))
      .mockResolvedValueOnce(fakeStream([], completedEvent('message_hot')));
    mocks.sendMessage.mockResolvedValue({ messageId: 'message_hot', delivery: 'sent' });
    let snapshot = 0;
    const inventory = sandboxStub({
      snapshotContainerIds: vi.fn(async () => {
        snapshot += 1;
        return snapshot === 1 ? new Set(['container_warm']) : new Set(['container_replacement']);
      }),
    });
    const env: ScenarioEnvironment = {
      profile: 'local',
      requireControlPlaneSession: false,
      sandbox: inventory,
      sessionSandbox: {
        waitForContainer: vi.fn(async () => 'container_warm'),
        currentContainer: vi.fn(async () => 'container_warm'),
      },
    };

    const result = await runSharedScenario(SHARED_SCENARIOS['hot'], {
      config,
      conversation: 'echo:hi',
      api: 'unified',
      env,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('sameContainers=false');
    expect(result.message).toContain('container_replacement');
  });
});

function lifecycleEvent(type: string, messageId: string): StreamEvent {
  return streamEvent(type, { messageId });
}

function interruptedFailedEvent(messageId: string): StreamEvent {
  return streamEvent('cloud.message.failed', { messageId, reason: 'interrupted' });
}

describe('moved continuity scenario run isolation', () => {
  let bootMarker: string | undefined;

  /**
   * The scenario generates its run id internally, so the boot stream has to be
   * built from the marker the prepare prompt actually carried. Without this the
   * restored boot-text assertion cannot pass and the test would not reach the
   * interrupt.
   */
  function installContinuityBoot(): void {
    bootMarker = undefined;
    mocks.prepareBrowserSession.mockImplementation(
      async (_config: unknown, input: { prompt: string }) => {
        bootMarker = input.prompt.replace('__fake__:echo:', '');
        return { cloudAgentSessionId: SESSION_ID, kiloSessionId: KILO_SESSION_ID };
      }
    );
    mocks.getSessionSnapshot.mockResolvedValue({
      initialMessageId: 'message_boot',
      sandboxId: 'sandbox_boot',
    });
    mocks.getMessageResult.mockResolvedValue({ status: 'completed' });
    mocks.openConnectedStream.mockImplementationOnce(async () => {
      if (!bootMarker) throw new Error('prepare did not run before the boot stream');
      return fakeStream(
        [
          assistantMessageEvent('message_boot', 'message_boot_assistant'),
          textPartEvent(
            'part_boot_text',
            'message_boot_assistant',
            `⠋ Initializing snapshot…${bootMarker}`
          ),
          completedEvent('message_boot'),
        ],
        completedEvent('message_boot')
      );
    });
  }

  it('uses a run-scoped interrupt tag and releases it when the gate never engages', async () => {
    installContinuityBoot();
    mocks.openConnectedStream.mockResolvedValueOnce(fakeStream([], completedEvent('message_gate')));
    mocks.sendMessage.mockResolvedValue({ messageId: 'message_gate', delivery: 'sent' });
    mocks.waitForGateEngaged.mockResolvedValue(false);
    mocks.fetchFakeScenarioStatus.mockResolvedValue({
      unsupportedToolSchema: false,
      requests: 1,
      toolCalls: { write: 1, read: 0, edit: 0, question: 0 },
      toolResults: { write: 0, read: 0, edit: 0, question: 0 },
    });
    mocks.releaseGate.mockResolvedValue(undefined);

    const result = await runSharedScenario(SHARED_SCENARIOS['interrupt-then-continue'], {
      config,
      conversation: '_',
      api: 'unified',
      timeoutMs: 300,
      env: queueHttpEnvironment(),
    });

    expect(result.ok).toBe(false);
    const tag = result.message.match(/interrupt-[0-9a-f-]{36}/)?.[0];
    expect(tag).toBeDefined();
    expect(mocks.releaseGate).toHaveBeenCalledWith(config.fakeLlmUrl, tag, expect.any(AbortSignal));
  }, 15_000);

  it('fails when interrupt and follow-up succeed but the release leaves the gate parked', async () => {
    installContinuityBoot();
    mocks.openConnectedStream
      .mockResolvedValueOnce(
        fakeStream([interruptedFailedEvent('message_gate')], completedEvent('message_gate'))
      )
      .mockResolvedValueOnce(
        fakeStream(
          [
            lifecycleEvent('cloud.message.queued', 'message_followup'),
            lifecycleEvent('cloud.message.sent', 'message_followup'),
            completedEvent('message_followup'),
          ],
          completedEvent('message_followup')
        )
      );
    mocks.sendMessage
      .mockResolvedValueOnce({ messageId: 'message_gate', delivery: 'sent' })
      .mockResolvedValueOnce({ messageId: 'message_followup', delivery: 'sent' });
    mocks.waitForGateEngaged.mockResolvedValue(true);
    mocks.releaseGate.mockRejectedValue(
      new Error('releaseGate(interrupt-x) failed: 500 Internal Server Error')
    );

    const result = await runSharedScenario(SHARED_SCENARIOS['interrupt-then-continue'], {
      config,
      conversation: '_',
      api: 'unified',
      timeoutMs: 2_000,
      env: queueHttpEnvironment(),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('ownedGateLeak');
    // The interrupt and the follow-up both ran; only the release failed.
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    const tag = result.message.match(/interrupt-[0-9a-f-]{36}/)?.[0];
    expect(tag).toBeDefined();
    expect(mocks.releaseGate).toHaveBeenCalledWith(config.fakeLlmUrl, tag, expect.any(AbortSignal));
  }, 15_000);
});
