import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, type ControlStatus } from '../session-fixture.test-helpers.js';
import { SESSION_DELIVERY_TIMEOUT_MS } from '../control-dispatch.js';
import { getPreparationSnapshots } from '../../session/preparation-history.js';
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

const WAIT_MESSAGE = 'Waiting for the sandbox to become available…';

function preparationDetails(fixture: ReturnType<typeof createSessionFixture>) {
  return getPreparationSnapshots(fixture.eventQueries)
    .map(row => JSON.parse(row.payload) as { stepSnapshot?: { latestDetail?: string } })
    .map(data => data.stepSnapshot?.latestDetail);
}

describe('launch failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    orchestrationMocks.broadcast.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails an admitted head instead of reporting the environment wait', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({
      physical: 'failed',
      connection: 'disconnected',
      launchFailed: true,
    } satisfies ControlStatus);
    const admittedAt = Date.now();
    await fixture.admit('a');
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('failed');
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'launch_failed' },
    });
    const at = (fixture.record('a')?.state as { at?: number } | undefined)?.at;
    expect(at).toBeLessThan(admittedAt + SESSION_DELIVERY_TIMEOUT_MS);
    expect(preparationDetails(fixture)).not.toContain(WAIT_MESSAGE);
  });

  it('fails the waiting head on the next drain, before the delivery deadline', async () => {
    const fixture = createSessionFixture(fixtureDeps);
    fixture.setStatus({ physical: 'failed', connection: 'disconnected' });

    const admittedAt = Date.now();
    await fixture.admit('a');
    await fixture.flush();
    await fixture.fireAlarm();
    await fixture.flush();

    // Setup guards: the unavailable environment parks the head and reports the
    // wait reason. These already hold without the change.
    expect(fixture.record('a')?.state.kind).toBe('queued');
    expect(fixture.alarmAt()).not.toBeNull();
    expect(preparationDetails(fixture)).toContain(WAIT_MESSAGE);

    fixture.setStatus({ physical: 'failed', connection: 'disconnected', launchFailed: true });
    const retryAt = fixture.alarmAt();
    if (retryAt === null) throw new Error('expected an armed queue retry');
    expect(retryAt).toBeLessThan(admittedAt + SESSION_DELIVERY_TIMEOUT_MS);

    vi.setSystemTime(retryAt);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')?.state.kind).toBe('failed');
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'launch_failed', at: retryAt },
    });
    const failedState = fixture.record('a')?.state;
    expect(failedState?.kind === 'failed' ? failedState.reason : undefined).not.toBe(
      'preparation_timeout'
    );
  });
});
