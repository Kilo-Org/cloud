import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEXT_RUNTIME_ID,
  RUNTIME_ID,
  controlFailure,
  createSessionFixture,
  delegateRequest,
} from '../session-fixture.test-helpers.js';
import {
  RUNTIME_REPLACEMENT_WAIT_LIMIT,
  type SessionMessageRecord,
} from '../session-message-queue.js';

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

describe('runtime replacement in flight', () => {
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
    // The fence reports a directory-native retire with no rebound runtime yet.
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      runtimeReplacementInFlight: true,
    });
    await fixture.admit('a');
    await fixture.flush();

    const deadlineAt = Date.now() + 20_000;
    const stored = fixture.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
    fixture.storage.kv.put(
      'session_messages',
      stored.map(message =>
        message.messageId === 'a' ? { ...message, deliveryDeadlineAt: deadlineAt } : message
      )
    );

    // At the head deadline the replacement is in flight: the head keeps waiting
    // and re-arms its own durable deadline instead of failing.
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('queued');
    expect(fixture.record('a')?.deliveryDeadlineAt).toBeGreaterThan(deadlineAt);

    // The replacement rebinds inside the window: the head is delivered.
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: NEXT_RUNTIME_ID,
    });
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('accepted');
  });

  it('re-arms a head that already bound an acquisition as a new acquisition', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    // Emulate the control plane's acquisition receipt: a request id is bound to
    // its original deadline, and a changed deadline for the same id is rejected
    // (SandboxControl.bindAcquisition). A live allocation binds on the first
    // drain, exactly as the production head did before the runtime retired.
    const originalEnsureReady = fixture.control.ensureReady.getMockImplementation();
    if (!originalEnsureReady) throw new Error('Missing ensureReady fixture');
    const boundDeadlines = new Map<string, number>();
    fixture.control.ensureReady.mockImplementation(async input => {
      const acquisition = input.acquisition;
      if (acquisition) {
        const bound = boundDeadlines.get(acquisition.id);
        if (bound !== undefined && bound !== acquisition.deadlineAt) {
          throw new Error('Sandbox acquisition deadline changed');
        }
        boundDeadlines.set(acquisition.id, acquisition.deadlineAt);
      }
      return originalEnsureReady(input);
    });
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
    });
    await fixture.admit('a');
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('queued');
    expect(boundDeadlines.size).toBe(1);

    // The runtime retires while the head still holds that receipt.
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      runtimeReplacementInFlight: true,
    });
    const deadlineAt = Date.now() + 20_000;
    const stored = fixture.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
    fixture.storage.kv.put(
      'session_messages',
      stored.map(message =>
        message.messageId === 'a' ? { ...message, deliveryDeadlineAt: deadlineAt } : message
      )
    );

    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state).toBe('queued');
    expect(fixture.record('a')?.deliveryDeadlineAt).toBeGreaterThan(deadlineAt);

    // The replacement rebinds: the re-armed head must acquire afresh. A mutated
    // deadline on the old receipt would be rejected and terminalize the head.
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: NEXT_RUNTIME_ID,
    });
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({ state: 'accepted' });
  });

  it('retires a bound attach proof into retiredAttach while deferring', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      operationResults: true,
    });
    // The first drain dispatches the attach. The control plane rejects it
    // retryably, so the head stays queued with the live attach proof bound,
    // exactly as the production head did before the runtime retired.
    delegateRequest(fixture, 'session.attach', async () => controlFailure(true, 'not_ready'));
    await fixture.admit('a');
    await fixture.flush();

    const attach = fixture.record('a')?.operations?.attach;
    if (!attach?.dispatched) throw new Error('Missing dispatched attach proof');

    // The runtime retires while that proof is still bound to the head.
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      runtimeReplacementInFlight: true,
    });
    const deadlineAt = Date.now() + 20_000;
    const stored = fixture.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
    fixture.storage.kv.put(
      'session_messages',
      stored.map(message =>
        message.messageId === 'a' ? { ...message, deliveryDeadlineAt: deadlineAt } : message
      )
    );

    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();

    const record = fixture.record('a');
    expect(record?.state).toBe('queued');
    expect(record?.operations?.attach).toBeUndefined();
    expect(record?.operations?.retiredAttach).toEqual(attach);
  });

  it('does not rewrite a head another event delivered during the probe', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
    });
    await fixture.admit('a');
    await fixture.flush();

    const deadlineAt = Date.now() + 20_000;
    const attemptId = fixture.record('a')?.preparationAttemptId;
    if (!attemptId) throw new Error('Missing preparation attempt');
    const stored = fixture.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
    fixture.storage.kv.put(
      'session_messages',
      stored.map(message =>
        message.messageId === 'a' ? { ...message, deliveryDeadlineAt: deadlineAt } : message
      )
    );

    // The fence probe is a cross-DO RPC. While it is outstanding another event
    // can deliver the head; emulate that by accepting the row inside the probe.
    fixture.control.getStatus.mockImplementation(async () => {
      const current = fixture.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
      fixture.storage.kv.put(
        'session_messages',
        current.map(message =>
          message.messageId === 'a'
            ? { ...message, state: 'accepted' as const, acceptedAt: Date.now() }
            : message
        )
      );
      return {
        physical: 'running',
        connection: 'connected',
        wrapperInstanceId: RUNTIME_ID,
        runtimeReplacementInFlight: true,
      };
    });

    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();

    // The delivered head keeps its own attempt and deadline: the deferral must
    // not re-target a row it no longer owns.
    expect(fixture.record('a')).toMatchObject({
      state: 'accepted',
      preparationAttemptId: attemptId,
      deliveryDeadlineAt: deadlineAt,
    });
  });

  it('fails the head once the deferral budget is exhausted', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      runtimeReplacementInFlight: true,
    });
    await fixture.admit('a');
    await fixture.flush();

    const stored = fixture.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
    fixture.storage.kv.put(
      'session_messages',
      stored.map(message =>
        message.messageId === 'a'
          ? { ...message, deliveryDeadlineAt: Date.now() + 20_000 }
          : message
      )
    );

    // Each deadline pass defers and mints a fresh window. The finite budget is
    // what keeps a fence that never clears from deferring forever.
    let deadlineAt = fixture.record('a')?.deliveryDeadlineAt;
    for (let pass = 0; pass < RUNTIME_REPLACEMENT_WAIT_LIMIT; pass++) {
      if (deadlineAt === undefined) throw new Error('Missing delivery deadline');
      vi.setSystemTime(deadlineAt);
      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('a')?.state).toBe('queued');
      deadlineAt = fixture.record('a')?.deliveryDeadlineAt;
      if (deadlineAt === undefined || deadlineAt <= Date.now())
        throw new Error('Deferral did not extend the deadline');
    }

    if (deadlineAt === undefined) throw new Error('Missing delivery deadline');
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: 'failed',
      failedReason: 'preparation_timeout',
    });
  });

  it('resets the deferral budget once the head binds the replacement runtime', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: RUNTIME_ID,
      runtimeReplacementInFlight: true,
    });
    await fixture.admit('a');
    await fixture.flush();

    // Fence A: the head defers once and spends one unit of the budget.
    const fenceDeadline = Date.now() + 20_000;
    const stored = fixture.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
    fixture.storage.kv.put(
      'session_messages',
      stored.map(message =>
        message.messageId === 'a' ? { ...message, deliveryDeadlineAt: fenceDeadline } : message
      )
    );
    vi.setSystemTime(fenceDeadline);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({ state: 'queued', replacementWaits: 1 });

    // Fence A clears: the replacement rebinds with a new incarnation and the
    // head binds it, which ends the deferral chain that spent that unit.
    fixture.setStatus({
      physical: 'creating',
      connection: 'disconnected',
      wrapperInstanceId: NEXT_RUNTIME_ID,
    });
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: 'queued',
      wrapperInstanceId: NEXT_RUNTIME_ID,
      replacementWaits: undefined,
    });

    // A later, unrelated fence must get the full budget, not the five units
    // fence A left behind.
    fixture.setStatus({
      physical: 'running',
      connection: 'connected',
      wrapperInstanceId: NEXT_RUNTIME_ID,
      runtimeReplacementInFlight: true,
    });
    let deadlineAt = Date.now() + 20_000;
    const rewrite = fixture.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
    fixture.storage.kv.put(
      'session_messages',
      rewrite.map(message =>
        message.messageId === 'a' ? { ...message, deliveryDeadlineAt: deadlineAt } : message
      )
    );
    for (let pass = 0; pass < RUNTIME_REPLACEMENT_WAIT_LIMIT; pass++) {
      vi.setSystemTime(deadlineAt);
      await fixture.fireAlarm();
      await fixture.flush();
      expect(fixture.record('a')?.state).toBe('queued');
      deadlineAt = fixture.record('a')?.deliveryDeadlineAt ?? 0;
      if (deadlineAt <= Date.now()) throw new Error('Deferral did not extend the deadline');
    }

    // The budget stays finite: the next deadline exhausts it and the existing
    // terminal path runs, so a fence that never clears still fails the head.
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: 'failed',
      failedReason: 'preparation_timeout',
    });
  });
});
