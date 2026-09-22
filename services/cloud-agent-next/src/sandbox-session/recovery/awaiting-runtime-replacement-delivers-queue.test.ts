import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEXT_RUNTIME_ID,
  RUNTIME_ID,
  createSessionFixture,
} from '../session-fixture.test-helpers.js';
import type { SessionMessageRecord } from '../session-message-queue.js';

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
});
