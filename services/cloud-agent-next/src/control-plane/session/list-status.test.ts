import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeTime } from 'ulid';
import {
  publishCloudAgentSessionStatusSchema,
  type PublishCloudAgentSessionStatusParams,
} from '@kilocode/session-ingest-contracts';
import {
  createSessionListStatusOutbox,
  deriveSessionListStatus,
  LIST_STATUS_RETRY_MS,
  LIST_STATUS_REFRESH_MS,
} from './list-status.js';

vi.mock('../../logger.js', () => ({ logger: { withFields: () => ({ warn: vi.fn() }) } }));

const identity = {
  sessionId: `ses_${'a'.repeat(26)}`,
  kiloUserId: 'oauth/status-test',
  cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
} satisfies Pick<
  PublishCloudAgentSessionStatusParams,
  'sessionId' | 'kiloUserId' | 'cloudAgentSessionId'
>;

function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    kv: {
      get: (key: string) => values.get(key),
      put: (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    },
  } as Pick<DurableObjectStorage, 'kv'>;
  const publish = vi.fn(async (_update: PublishCloudAgentSessionStatusParams): Promise<void> => {});
  return { values, storage, publish, outbox: createSessionListStatusOutbox({ storage, publish }) };
}

afterEach(() => vi.useRealTimers());

describe('session-list status', () => {
  const idle = {
    messages: [],
    nativeStatus: undefined,
    pendingInteractions: undefined,
    routeState: 'ready',
  };

  it.each(['queued', 'accepted'] as const)(
    'shows %s work as busy, including preparation',
    state => {
      expect(
        deriveSessionListStatus({ ...idle, messages: [{ state }], routeState: 'preparing' })
      ).toBe('busy');
    }
  );
  it('uses native status for autonomous work without a Cloud message', () => {
    expect(deriveSessionListStatus({ ...idle, nativeStatus: 'busy' })).toBe('busy');
    expect(deriveSessionListStatus({ ...idle, nativeStatus: 'retry' })).toBe('retry');
    expect(deriveSessionListStatus({ ...idle, nativeStatus: 'offline' })).toBe('retry');
  });
  it('shows pending input even when a turn has settled', () => {
    const pendingInteractions = { revision: 1, questions: [{}], permissions: [] };
    expect(deriveSessionListStatus({ ...idle, pendingInteractions })).toBe('question');
    expect(
      deriveSessionListStatus({
        ...idle,
        pendingInteractions: { ...pendingInteractions, permissions: [{}] },
      })
    ).toBe('permission');
    expect(deriveSessionListStatus(idle)).toBe('idle');
  });
  it('does not leave a genuine failure looking busy or waiting for an unanswerable request', () => {
    expect(deriveSessionListStatus({ ...idle, routeState: 'failed', nativeStatus: 'busy' })).toBe(
      'failed'
    );
    expect(
      deriveSessionListStatus({
        ...idle,
        messages: [{ state: 'failed' }],
        pendingInteractions: { revision: 1, questions: [{}], permissions: [] },
      })
    ).toBe('failed');
    expect(deriveSessionListStatus({ ...idle, messages: [{ state: 'cancelled' }] })).toBe('idle');
    expect(
      deriveSessionListStatus({ ...idle, messages: [{ state: 'failed' }], nativeStatus: 'busy' })
    ).toBe('busy');
  });
});

describe('session-list status outbox', () => {
  it('publishes only transitions, not each native event, and remembers delivery across eviction', async () => {
    const { outbox, storage, publish } = fixture();
    outbox.record(identity, 'busy', 1000);
    await outbox.repair(1000);
    expect(publishCloudAgentSessionStatusSchema.parse(publish.mock.calls[0]?.[0])).toMatchObject({
      ...identity,
      status: 'busy',
    });
    expect(outbox.nextDueAt()).toBeNull();
    const rehydrated = createSessionListStatusOutbox({ storage, publish });
    rehydrated.record(identity, 'busy', 2000);
    await rehydrated.repair(2000);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('coalesces unobserved transitions into one bounded snapshot', async () => {
    const { outbox, values, publish } = fixture();
    for (let i = 0; i < 100; i++) outbox.record(identity, i % 2 === 0 ? 'busy' : 'idle', 1000);
    expect(values.size).toBe(1);
    await outbox.repair(1000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ status: 'idle' });
  });

  it('refreshes active summaries at most once per minute so the sidebar does not age out long-running work', async () => {
    const { outbox, publish } = fixture();
    outbox.record(identity, 'busy', 1000);
    await outbox.repair(1000);
    outbox.record(identity, 'busy', 1000 + LIST_STATUS_REFRESH_MS - 1);
    await outbox.repair(1000 + LIST_STATUS_REFRESH_MS - 1);
    expect(publish).toHaveBeenCalledTimes(1);
    outbox.record(identity, 'busy', 1000 + LIST_STATUS_REFRESH_MS);
    await outbox.repair(1000 + LIST_STATUS_REFRESH_MS);
    expect(publish).toHaveBeenCalledTimes(2);
    outbox.record(identity, 'idle', 1000 + LIST_STATUS_REFRESH_MS + 1);
    await outbox.repair(1000 + LIST_STATUS_REFRESH_MS + 1);
    outbox.record(identity, 'idle', 1000 + 10 * LIST_STATUS_REFRESH_MS);
    await outbox.repair(1000 + 10 * LIST_STATUS_REFRESH_MS);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('retains failures for alarm retry after eviction without retrying early', async () => {
    const { outbox, storage, publish } = fixture();
    publish.mockRejectedValueOnce(new Error('unavailable'));
    outbox.record(identity, 'question', 1000);
    await outbox.repair(1000);
    expect(outbox.nextDueAt()).toBe(1000 + LIST_STATUS_RETRY_MS);
    const rehydrated = createSessionListStatusOutbox({ storage, publish });
    await rehydrated.repair(1001);
    expect(publish).toHaveBeenCalledTimes(1);
    await rehydrated.repair(1000 + LIST_STATUS_RETRY_MS);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toEqual(publish.mock.calls[0]?.[0]);
    expect(rehydrated.nextDueAt()).toBeNull();
  });

  it('never acknowledges a newer snapshot when an older publication completes', async () => {
    const { outbox, publish } = fixture();
    let resolve: (() => void) | undefined;
    publish.mockImplementationOnce(
      () =>
        new Promise<void>(done => {
          resolve = done;
        })
    );
    outbox.record(identity, 'busy', 1000);
    const first = outbox.repair(1000);
    expect(outbox.repair(1000)).toBe(first);
    outbox.record(identity, 'idle', 1001);
    resolve?.();
    await first;
    expect(outbox.nextDueAt()).toBe(1001);
    await outbox.repair(1001);
    expect(publish.mock.calls[1]?.[0]).toMatchObject({ status: 'idle' });
  });

  it('orders transitions across same-millisecond updates, clock rollback, and eviction', async () => {
    const { outbox, storage, publish } = fixture();
    outbox.record(identity, 'busy', 1000);
    await outbox.repair(1000);
    const rehydrated = createSessionListStatusOutbox({ storage, publish });
    rehydrated.record(identity, 'idle', 500);
    await rehydrated.repair(500);
    const first = publishCloudAgentSessionStatusSchema.parse(publish.mock.calls[0]?.[0]);
    const second = publishCloudAgentSessionStatusSchema.parse(publish.mock.calls[1]?.[0]);
    expect(second.transitionId > first.transitionId).toBe(true);
    expect(decodeTime(second.transitionId)).toBe(1001);
  });

  it('bounds a hung RPC and keeps the status retryable', async () => {
    vi.useFakeTimers();
    const { outbox, publish } = fixture();
    publish.mockImplementationOnce(() => new Promise<void>(() => {}));
    outbox.record(identity, 'busy', 1000);
    const pending = outbox.repair(1000);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(outbox.nextDueAt()).toBe(1000 + LIST_STATUS_RETRY_MS);
  });

  it('does not recreate status storage if deletion wins an in-flight publication', async () => {
    const { outbox, values, publish } = fixture();
    let resolve: (() => void) | undefined;
    publish.mockImplementationOnce(
      () =>
        new Promise<void>(done => {
          resolve = done;
        })
    );
    outbox.record(identity, 'busy', 1000);
    const pending = outbox.repair(1000);
    values.clear();
    resolve?.();
    await pending;
    expect(values.size).toBe(0);
  });
});
