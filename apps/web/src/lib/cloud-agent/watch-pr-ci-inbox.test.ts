import { redisClient } from '@kilocode/web-shared/lib/redis';
import { emptyWatchPrProjection, type WatchPrCiEvent } from './watch-pr-events';
import {
  readWatchPrCiEvents,
  replayWatchPrCiEvents,
  retainWatchPrCiEvent,
} from './watch-pr-ci-inbox';

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { eval: jest.fn(), zrange: jest.fn() },
}));

const now = Date.parse('2026-10-15T12:00:00Z');
const event: WatchPrCiEvent = {
  kind: 'status',
  installationId: '123',
  repositoryId: '456',
  key: 'status:7:ci',
  objectId: '10',
  sha: 'a'.repeat(40),
  updatedAt: '2026-10-15T11:59:00Z',
  state: 'failure',
};
const input = {
  installationId: '123',
  repositoryId: '456',
  appType: 'standard' as const,
  headSha: event.sha,
  createdAt: '2026-10-15 11:00:00+00',
};
const receipt = { deliveryId: 'delivery', event };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(redisClient.eval).mockResolvedValue(1);
  jest.mocked(redisClient.zrange).mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

describe('bounded Watch PR CI inbox', () => {
  it('stores one normalized event with an atomic count bound, age bound, TTL, and first-delivery score', async () => {
    await retainWatchPrCiEvent({ event, deliveryId: receipt.deliveryId, appType: 'standard' });
    const [script, keys, args] = jest.mocked(redisClient.eval).mock.calls[0];
    expect(keys).toEqual(['watch-pr-ci:v1:123:standard:456']);
    expect(args).toEqual([now, JSON.stringify(receipt), now - 86400000, 100, 86400]);
    expect(script).toContain("'ZADD', KEYS[1], 'NX'");
    expect(script).toContain("'ZREMRANGEBYSCORE'");
    expect(script).toContain("'ZREMRANGEBYRANK'");
    expect(script).toContain("'EXPIRE'");
  });

  it('bounds replay to the watch lifetime and the matching repository/head SHA', async () => {
    jest
      .mocked(redisClient.zrange)
      .mockResolvedValue([
        JSON.stringify(receipt),
        JSON.stringify({ ...receipt, event: { ...event, sha: 'b'.repeat(40) } }),
        JSON.stringify({ ...receipt, event: { ...event, installationId: '999' } }),
        JSON.stringify({ ...receipt, event: { ...event, repositoryId: '999' } }),
      ]);
    expect(await readWatchPrCiEvents(input)).toEqual([receipt]);
    expect(redisClient.zrange).toHaveBeenCalledWith(
      'watch-pr-ci:v1:123:standard:456',
      Date.parse(input.createdAt),
      '+inf',
      { byScore: true, offset: 0, count: 100 }
    );
  });

  it('never reads receipts older than 24 hours', async () => {
    await readWatchPrCiEvents({ ...input, createdAt: '2026-10-10T00:00:00Z' });
    expect(redisClient.zrange).toHaveBeenCalledWith(
      expect.any(String),
      now - 86400000,
      '+inf',
      expect.any(Object)
    );
  });

  it('separates standard and lite apps for the same installation and repository', async () => {
    await retainWatchPrCiEvent({ event, deliveryId: receipt.deliveryId, appType: 'lite' });
    expect(jest.mocked(redisClient.eval).mock.calls[0][1]).toEqual(['watch-pr-ci:v1:123:lite:456']);
    await readWatchPrCiEvents({ ...input, appType: 'lite' });
    expect(jest.mocked(redisClient.zrange).mock.calls[0][0]).toBe('watch-pr-ci:v1:123:lite:456');
  });

  it('validates stored events before projection', async () => {
    jest
      .mocked(redisClient.zrange)
      .mockResolvedValue([JSON.stringify({ ...receipt, event: { ...event, sha: 'not-a-sha' } })]);
    await expect(readWatchPrCiEvents(input)).rejects.toThrow();
  });

  it('batches replay receipts and projects each delivery only once', async () => {
    jest
      .mocked(redisClient.zrange)
      .mockResolvedValue([
        JSON.stringify(receipt),
        JSON.stringify(receipt),
        JSON.stringify({ deliveryId: 'already-seen', event: { ...event, objectId: '11' } }),
      ]);
    const values = jest.fn().mockResolvedValue(undefined);
    const where = jest.fn().mockResolvedValue([{ deliveryId: 'already-seen' }]);
    const tx = {
      select: () => ({ from: () => ({ where }) }),
      insert: () => ({ values }),
    } as unknown as Parameters<typeof replayWatchPrCiEvents>[0];
    const watch = {
      id: 'watch',
      created_at: input.createdAt,
      installation_id: event.installationId,
      repository_id: event.repositoryId,
    };
    const next = {
      ...watch,
      pr_number: 42,
      head_ref: 'feature',
      base_ref: 'main',
      head_sha: event.sha,
      base_sha: 'b'.repeat(40),
      status: 'paused' as const,
      generation: 3,
      pending_revision: 0,
      projection: emptyWatchPrProjection(),
      lifecycle_reason: 'user_pause',
    };
    const projected = await replayWatchPrCiEvents(tx, watch, next, 'standard');
    expect(projected).toMatchObject({
      status: 'paused',
      generation: 3,
      lifecycle_reason: 'user_pause',
      projection: { pending: [{ key: event.key, reason: 'failed_status' }] },
    });
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith([expect.objectContaining({ delivery_id: 'delivery' })]);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
