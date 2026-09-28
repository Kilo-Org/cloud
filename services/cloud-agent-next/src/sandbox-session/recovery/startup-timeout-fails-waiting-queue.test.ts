import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEADLINE_MS } from '../../sandbox-control/deadlines.js';
import { createSessionFixture, RUNTIME_ID } from '../session-fixture.test-helpers.js';
import type { SessionEnvelope } from '../../sandbox-state/model/session.js';
import { readSessionValueSync, writeSessionMessages } from '../../sandbox-state/persist/access.js';
import { readRawSessionMessages } from '../../sandbox-state/persist/load.js';
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

describe('startup timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    orchestrationMocks.broadcast.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails the head at its delivery deadline while the environment is unavailable', async () => {
    // The two-minute startup budget is the named preparation bound.
    expect(DEADLINE_MS.startup).toBe(2 * 60_000);

    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({
      physical: 'stopped',
      connection: 'disconnected',
      wrapperInstanceId: RUNTIME_ID,
    });
    await fixture.admit('a');
    await fixture.flush();

    const deadlineAt = Date.now() + 20_000;
    const envelope = readSessionValueSync<SessionEnvelope>(fixture.storage.kv);
    if (!envelope) throw new Error('missing session envelope');
    const stored = readRawSessionMessages(fixture.storage.kv);
    writeSessionMessages(
      fixture.storage.kv,
      envelope.binding,
      stored.map(message =>
        message.messageId === 'a' && message.state.kind === 'queued'
          ? { ...message, state: { ...message.state, deadlineAt } }
          : message
      )
    );

    // Before the deadline the unavailable environment parks the head: the real
    // `deadlineAt` path must not terminalize yet.
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')?.state.kind).toBe('queued');
    expect(fixture.alarmAt()).not.toBeNull();

    // At the head deadline the real drain check fails the head with the
    // preparation reason.
    vi.setSystemTime(deadlineAt);
    await fixture.fireAlarm();
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'preparation_timeout', at: deadlineAt },
    });
  });
});
