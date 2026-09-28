/**
 * The production shape from Pylon 28572: a queued message whose workspace has no
 * runtime while a runtime replacement is in flight. The preparation deadline must
 * not terminalize the head with `preparation_timeout`; the head waits for the
 * replacement and is delivered once it rebinds. A replacement that never binds
 * still reaches the terminal path once the deferral budget is spent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECTORY,
  NEXT_RUNTIME_ID,
  RUNTIME_ID,
  SANDBOX_ID,
  SESSION_ID,
  controlFailure,
  controlResponse,
  createSessionFixture,
  delegateRequest,
} from '../session-fixture.test-helpers.js';
import { RUNTIME_REPLACEMENT_WAIT_LIMIT } from '../session-message-queue.js';
import type { SessionEnvelope, SessionMessage } from '../../sandbox-state/model/session.js';
import { readSessionValueSync, writeSessionMessages } from '../../sandbox-state/persist/access.js';
import { readRawSessionMessages } from '../../sandbox-state/persist/load.js';
import type { SessionOperationAuthorization } from '../../shared/sandbox-control-protocol.js';

const orchestrationMocks = vi.hoisted(() => ({
  eventQueries: vi.fn(),
  signedAttachments: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown
    ) {}
  },
}));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('drizzle-orm/durable-sqlite', () => ({ drizzle: vi.fn() }));
vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({ migrate: vi.fn(async () => undefined) }));
vi.mock('../../../drizzle/migrations', () => ({ default: {} }));
vi.mock('../../session/queries/index.js', () => ({
  createEventQueries: orchestrationMocks.eventQueries,
}));
vi.mock('../../model-validation.js', () => ({
  assertKiloModelAvailable: vi.fn(async () => undefined),
}));
vi.mock('../../execution/attachment-prompt-parts.js', () => ({
  buildSignedPromptAttachments: orchestrationMocks.signedAttachments,
}));
vi.mock('../../websocket/stream.js', () => ({
  createStreamHandler: (
    _state: unknown,
    _queries: unknown,
    _sessionId: string,
    options?: {
      deriveCloudStatus?: () => Promise<unknown>;
      deriveQueuedMessages?: () => Promise<unknown>;
      readPendingInteractions?: () => unknown;
      deriveSessionStatus?: () => Promise<unknown>;
      getPreparationSnapshots?: () => Promise<unknown>;
    }
  ) => ({
    broadcastEvent: orchestrationMocks.broadcast,
    handleStreamRequest: async () =>
      Response.json({
        cloudStatus: await options?.deriveCloudStatus?.(),
        queuedMessages: await options?.deriveQueuedMessages?.(),
        pendingInteractions: options?.readPendingInteractions?.(),
        sessionStatus: await options?.deriveSessionStatus?.(),
        preparationSnapshots: await options?.getPreparationSnapshots?.(),
      }),
  }),
}));

const fixtureDeps = {
  eventQueries: orchestrationMocks.eventQueries,
  signedAttachments: orchestrationMocks.signedAttachments,
};

type Fixture = ReturnType<typeof createSessionFixture>;

/** The head's durable queued state, or undefined when it is not queued. */
function queuedStateOf(fixture: Fixture, messageId: string) {
  const record = fixture.record(messageId);
  return record?.state.kind === 'queued' ? record.state : undefined;
}

function queuedDeadline(fixture: Fixture, messageId: string): number {
  const deadlineAt = queuedStateOf(fixture, messageId)?.deadlineAt;
  if (deadlineAt === undefined || deadlineAt === null) throw new Error('missing delivery deadline');
  return deadlineAt;
}

/** Rewrites the stored head through the same writer the DO uses. */
function rewriteHead(
  fixture: Fixture,
  messageId: string,
  rewrite: (message: SessionMessage) => SessionMessage,
  binding?: SessionEnvelope['binding']
): void {
  const envelope = readSessionValueSync<SessionEnvelope>(fixture.storage.kv);
  if (!envelope) throw new Error('missing session envelope');
  writeSessionMessages(
    fixture.storage.kv,
    binding ?? envelope.binding,
    readRawSessionMessages(fixture.storage.kv).map(message =>
      message.messageId === messageId ? rewrite(message) : message
    )
  );
}

/** Forces the head's durable delivery deadline, as an expired window would. */
function setDeliveryDeadline(fixture: Fixture, messageId: string, deadlineAt: number): void {
  rewriteHead(fixture, messageId, message =>
    message.state.kind === 'queued'
      ? { ...message, state: { ...message.state, deadlineAt } }
      : message
  );
}

describe('awaiting a runtime replacement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    orchestrationMocks.broadcast.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers the head past its deadline and delivers once the replacement rebinds', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      runtimeReplacementInFlight: true,
    });
    await fixture.admit('a');
    await fixture.flush();

    const deadlineAt = Date.now() + 20_000;
    setDeliveryDeadline(fixture, 'a', deadlineAt);

    // The deadline lands while the workspace has no runtime and a replacement is
    // in flight: the head stays queued on a fresh window instead of failing.
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('queued');
    expect(queuedDeadline(fixture, 'a')).toBeGreaterThan(deadlineAt);

    // The replacement rebinds inside the window: the head is delivered.
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: NEXT_RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
    });
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
  });

  it('re-arms a head that already bound an acquisition as a new acquisition', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    const originalEnsureReady = fixture.control.ensureReady.getMockImplementation();
    if (!originalEnsureReady) throw new Error('Missing ensureReady fixture');
    // The control plane binds an acquisition id to its original deadline and
    // rejects a changed deadline for the same id, so a re-armed window must be a
    // new acquisition rather than a mutated one.
    const boundDeadlines = new Map<string, number>();
    fixture.control.ensureReady.mockImplementation(async input => {
      const acquisition = input.acquisition;
      if (acquisition) {
        const bound = boundDeadlines.get(acquisition.id);
        if (bound !== undefined && bound !== acquisition.deadlineAt)
          throw new Error('Sandbox acquisition deadline changed');
        boundDeadlines.set(acquisition.id, acquisition.deadlineAt);
      }
      return originalEnsureReady(input);
    });
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
    });
    await fixture.admit('a');
    await fixture.flush();
    expect(queuedStateOf(fixture, 'a')?.preparationAttemptId).toBeDefined();
    expect(boundDeadlines.size).toBe(1);

    const deadlineAt = Date.now() + 20_000;
    setDeliveryDeadline(fixture, 'a', deadlineAt);
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      runtimeReplacementInFlight: true,
    });
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('queued');
    expect(queuedDeadline(fixture, 'a')).toBeGreaterThan(deadlineAt);

    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: NEXT_RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
    });
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('accepted');
    expect(boundDeadlines.size).toBe(2);
  });

  it('retires a bound attach proof into retiredAttach while deferring', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    delegateRequest(fixture, 'session.attach', async () => controlFailure(true, 'not_ready'));
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      operationResults: true,
      runtimeReplacementInFlight: true,
    });
    await fixture.admit('a');
    await fixture.flush();

    const attach = fixture.record('a')?.proofs?.attach;
    if (!attach?.dispatched) throw new Error('Missing dispatched attach proof');

    const deadlineAt = Date.now() + 20_000;
    setDeliveryDeadline(fixture, 'a', deadlineAt);
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();

    const record = fixture.record('a');
    expect(record?.state.kind).toBe('queued');
    expect(record?.proofs?.attach).toBeUndefined();
    expect(record?.proofs?.retiredAttach).toEqual(attach);
  });

  it('does not rewrite a head another event delivered during the probe', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
    });
    await fixture.admit('a');
    await fixture.flush();
    const attemptId = queuedStateOf(fixture, 'a')?.preparationAttemptId;
    if (!attemptId) throw new Error('Missing preparation attempt');

    const deadlineAt = Date.now() + 20_000;
    setDeliveryDeadline(fixture, 'a', deadlineAt);

    // `runtimeReplacementInFlight` is a cross-DO probe: another event may deliver
    // the head while it is outstanding, so only a still-queued head is rewritten.
    const originalGetStatus = fixture.control.getStatus.getMockImplementation();
    if (!originalGetStatus) throw new Error('Missing getStatus fixture');
    fixture.control.getStatus.mockImplementation(async () => {
      // The head was delivered by the concurrent event; acceptance requires a
      // bound attachment, so the stored envelope carries the bound handle.
      rewriteHead(
        fixture,
        'a',
        message =>
          message.state.kind === 'queued'
            ? {
                ...message,
                state: {
                  kind: 'accepted',
                  intent: message.state.intent,
                  acceptedAt: Date.now(),
                  executionDeadlineAt: Date.now() + 60_000,
                  ...(message.state.legacy === undefined ? {} : { legacy: message.state.legacy }),
                  ...(message.state.legacyInvalidIntent === undefined
                    ? {}
                    : { legacyInvalidIntent: message.state.legacyInvalidIntent }),
                  ...(message.state.queuedAt === undefined
                    ? {}
                    : { queuedAt: message.state.queuedAt }),
                  ...(message.state.wrapperInstanceId === undefined
                    ? {}
                    : { wrapperInstanceId: message.state.wrapperInstanceId }),
                  ...(message.state.preparationAttemptId === undefined
                    ? {}
                    : { preparationAttemptId: message.state.preparationAttemptId }),
                },
              }
            : message,
        {
          kind: 'bound',
          handle: { incarnation: 'incarnation_1', wrapper: RUNTIME_ID, epoch: 0 },
        }
      );
      return { ...(await originalGetStatus()), runtimeReplacementInFlight: true as const };
    });

    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'accepted', preparationAttemptId: attemptId },
    });
  });

  it('fails the head once the deferral budget is spent', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      runtimeReplacementInFlight: true,
    });
    await fixture.admit('a');
    await fixture.flush();
    setDeliveryDeadline(fixture, 'a', Date.now() + 20_000);

    // Each deferral spends one unit of the budget and grants a fresh window.
    for (let wait = 0; wait < RUNTIME_REPLACEMENT_WAIT_LIMIT; wait += 1) {
      const deadlineAt = queuedDeadline(fixture, 'a');
      vi.setSystemTime(deadlineAt);
      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('a')?.state.kind).toBe('queued');
      expect(queuedDeadline(fixture, 'a')).toBeGreaterThan(deadlineAt);
      expect(queuedStateOf(fixture, 'a')?.replacementWaits).toBe(wait + 1);
    }

    // A replacement that never completes exhausts the budget and the existing
    // terminal path fails the head exactly as before.
    vi.setSystemTime(queuedDeadline(fixture, 'a'));
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state).toMatchObject({
      kind: 'failed',
      reason: 'preparation_timeout',
    });
  });

  it('resets the deferral budget when a native runtime rebinds in place', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    const retiredNativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const replacementNativeRuntimeId = '44444444-4444-4444-8444-444444444444';

    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      runtimeReplacementInFlight: true,
    });
    await fixture.admit('a');
    await fixture.flush();

    // The head binds a native runtime before the retirement, so the fence holds
    // its attach epoch and the in-place rebind must advance past it.
    const authorization: SessionOperationAuthorization = {
      operation: 'session.attach',
      operationId: '11111111-1111-4111-8111-111111111111',
      messageId: 'a',
      session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
      wrapperInstanceId: RUNTIME_ID,
      dispatchDeadlineAt: Date.now() + 60_000,
    };
    rewriteHead(fixture, 'a', message => ({
      ...message,
      proofs: {
        attach: {
          authorization,
          dispatched: true,
          completedAt: Date.now(),
          attachmentEpoch: 1,
        },
      },
    }));
    await fixture.session.recordNativeRuntime({
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: RUNTIME_ID,
      nativeRuntimeId: retiredNativeRuntimeId,
      authorization,
    });
    expect(fixture.values.get('native_runtime_fence')).toMatchObject({
      nativeRuntimeId: retiredNativeRuntimeId,
      attachmentEpoch: 1,
    });

    // Fence A: the head defers once and spends one unit of the budget.
    const fenceDeadline = Date.now() + 20_000;
    setDeliveryDeadline(fixture, 'a', fenceDeadline);
    vi.setSystemTime(fenceDeadline);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(queuedStateOf(fixture, 'a')?.replacementWaits).toBe(1);
    expect(fixture.record('a')?.proofs?.retiredAttach).toMatchObject({ attachmentEpoch: 1 });

    // Fence A clears by recreating only the native runtime in place: the wrapper
    // incarnation stays RUNTIME_ID, so only the attach result's native runtime
    // identity changes. The attach binds it while the prompt stays retryable, so
    // the head is still queued when the replacement has bound.
    delegateRequest(fixture, 'session.attach', async () =>
      controlResponse({ attached: true, nativeRuntimeId: replacementNativeRuntimeId })
    );
    delegateRequest(fixture, 'session.prompt', async () => controlFailure(true, 'not_ready'));
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      operationResults: true,
    });
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.values.get('native_runtime_fence')).toMatchObject({
      nativeRuntimeId: replacementNativeRuntimeId,
    });
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', wrapperInstanceId: RUNTIME_ID, replacementWaits: undefined },
    });
  });

  it('keeps the attach-epoch pool across a second deferral so the rebind still binds', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    const retiredNativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const replacementNativeRuntimeId = '44444444-4444-4444-8444-444444444444';

    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      runtimeReplacementInFlight: true,
    });
    await fixture.admit('a');
    await fixture.flush();

    // The head binds a native runtime at attach epoch 1 before the retirement, so
    // the fence holds 1 and the in-place rebind must advance past it.
    const boundAuthorization: SessionOperationAuthorization = {
      operation: 'session.attach',
      operationId: '11111111-1111-4111-8111-111111111111',
      messageId: 'a',
      session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
      wrapperInstanceId: RUNTIME_ID,
      dispatchDeadlineAt: Date.now() + 60_000,
    };
    rewriteHead(fixture, 'a', message => ({
      ...message,
      proofs: {
        attach: {
          authorization: boundAuthorization,
          dispatched: true,
          completedAt: Date.now(),
          attachmentEpoch: 1,
        },
      },
    }));
    await fixture.session.recordNativeRuntime({
      sandboxId: SANDBOX_ID,
      wrapperInstanceId: RUNTIME_ID,
      nativeRuntimeId: retiredNativeRuntimeId,
      authorization: boundAuthorization,
    });
    expect(fixture.values.get('native_runtime_fence')).toMatchObject({ attachmentEpoch: 1 });

    // Deferral one retires the completed attach, whose epoch the fence holds.
    const firstDeadline = Date.now() + 20_000;
    setDeliveryDeadline(fixture, 'a', firstDeadline);
    vi.setSystemTime(firstDeadline);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.proofs?.retiredAttach).toMatchObject({ attachmentEpoch: 1 });

    // The redelivery dispatches a fresh attach, and its result has not arrived
    // when the next deadline lands: the second deferral retires an epoch-less
    // proof over the completed one.
    const pendingAuthorization: SessionOperationAuthorization = {
      operation: 'session.attach',
      operationId: '22222222-2222-4222-8222-222222222222',
      messageId: 'a',
      session: { sessionId: SESSION_ID, kiloSessionId: 'kilo_root', directory: DIRECTORY },
      wrapperInstanceId: RUNTIME_ID,
      dispatchDeadlineAt: Date.now() + 60_000,
    };
    rewriteHead(fixture, 'a', message => ({
      ...message,
      proofs: {
        ...message.proofs,
        attach: { authorization: pendingAuthorization, dispatched: true },
      },
    }));
    const secondDeadline = Date.now() + 20_000;
    setDeliveryDeadline(fixture, 'a', secondDeadline);
    vi.setSystemTime(secondDeadline);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(queuedStateOf(fixture, 'a')?.replacementWaits).toBe(2);
    // Dropping the epoch here makes the next attach mint at or below the fence's
    // epoch, so the replacement looks like a stale result and never binds.
    expect(fixture.record('a')?.proofs?.retiredAttach).toMatchObject({ attachmentEpoch: 1 });

    // The replacement binds in place: the attach result carries the replacement
    // native runtime identity, and the fence must advance to it.
    delegateRequest(fixture, 'session.attach', async () =>
      controlResponse({ attached: true, nativeRuntimeId: replacementNativeRuntimeId })
    );
    delegateRequest(fixture, 'session.prompt', async () => controlFailure(true, 'not_ready'));
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      operationResults: true,
    });
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.values.get('native_runtime_fence')).toMatchObject({
      nativeRuntimeId: replacementNativeRuntimeId,
    });
  });
});
