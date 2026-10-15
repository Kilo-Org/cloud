jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { select: jest.fn() },
  readDb: {
    select: jest.fn(() => {
      throw new Error('Replica must not be used');
    }),
  },
}));
jest.mock('@kilocode/web-shared/lib/creditExpiration', () => ({
  processLocalExpirations: jest.fn(),
  processOrganizationExpirationsBatch: jest.fn(),
}));
jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => fields),
  buildScheduledJobFailureEvent: jest.fn((_run, error) => ({ error })),
  emitScheduledJobEvent: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import {
  processLocalExpirations,
  processOrganizationExpirationsBatch,
} from '@kilocode/web-shared/lib/creditExpiration';
import { GET, maxDuration } from './route';

function request(authorization = 'Bearer cron-secret') {
  return new Request('http://localhost/api/cron/expire-credits', {
    headers: { authorization },
  });
}

function queueBatch(rows: object[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn(() => ({ limit }));
  const where = jest.fn(() => ({ orderBy }));
  const from = jest.fn(() => ({ where }));
  jest.mocked(db.select).mockReturnValueOnce({ from } as never);
  return { limit, orderBy, where };
}

describe('credit expiry cron', () => {
  beforeEach(() => jest.resetAllMocks());

  it.each(['', 'Bearer wrong', 'cron-secret'])(
    'rejects invalid auth %s before database access',
    async auth => {
      expect((await GET(request(auth))).status).toBe(401);
      expect(db.select).not.toHaveBeenCalled();
    }
  );

  it('uses a bounded primary batch for each owner type without a policy activation gate', async () => {
    const users = queueBatch([{ id: 'user' }]);
    const orgs = queueBatch([{ id: 'org' }]);
    const response = await GET(request());
    expect(maxDuration).toBe(300);
    expect(await response.json()).toMatchObject({
      usersProcessed: 1,
      organizationsProcessed: 1,
      batchSize: 100,
      batchesRun: 1,
      hasMore: false,
    });
    expect(users.limit).toHaveBeenCalledWith(101);
    expect(orgs.limit).toHaveBeenCalledWith(101);
    expect(users.orderBy).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(processLocalExpirations).toHaveBeenCalledWith({ id: 'user' }, expect.any(Date));
    expect(processOrganizationExpirationsBatch).toHaveBeenCalledWith(
      [{ id: 'org' }],
      expect.any(Date)
    );
    expect(jest.mocked(processLocalExpirations).mock.calls[0][1]).toBe(
      jest.mocked(processOrganizationExpirationsBatch).mock.calls[0][1]
    );
  });

  it('caps both owner types at two batches and exposes remaining work', async () => {
    const owners = Array.from({ length: 101 }, (_, id) => ({ id: String(id) }));
    for (let index = 0; index < 4; index++) queueBatch(owners);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      usersProcessed: 200,
      organizationsProcessed: 200,
      batchesRun: 2,
      hasMore: true,
    });
    expect(db.select).toHaveBeenCalledTimes(4);
    expect(processLocalExpirations).toHaveBeenCalledTimes(200);
    expect(processOrganizationExpirationsBatch).toHaveBeenCalledTimes(2);
    for (const [orgs] of jest.mocked(processOrganizationExpirationsBatch).mock.calls) {
      expect(orgs).toHaveLength(100);
    }
  });

  it('does not revisit an exhausted owner type while draining the other', async () => {
    queueBatch([]);
    queueBatch(Array.from({ length: 101 }, (_, id) => ({ id: String(id) })));
    queueBatch([]);
    expect(await (await GET(request())).json()).toMatchObject({ batchesRun: 2, hasMore: false });
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it('continues past a failed user reconciliation and reports the run as failed for retry', async () => {
    queueBatch([{ id: 'failing-user' }, { id: 'user' }]);
    queueBatch([{ id: 'org' }]);
    const failure = new Error('reconcile failed');
    jest.mocked(processLocalExpirations).mockRejectedValueOnce(failure);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      usersProcessed: 1,
      usersFailed: 1,
      organizationsProcessed: 1,
      hasMore: false,
    });
    expect(processLocalExpirations).toHaveBeenCalledTimes(2);
    expect(processOrganizationExpirationsBatch).toHaveBeenCalledWith(
      [{ id: 'org' }],
      expect.any(Date)
    );
    expect(captureException).toHaveBeenCalledWith(failure, {
      tags: { source: 'expire_credits_cron' },
      extra: { kilo_user_id: 'failing-user' },
    });
    expect(jest.mocked(buildScheduledJobFailureEvent).mock.calls[0]).toEqual([
      undefined,
      new Error('1 user expirations failed'),
    ]);
    expect(buildScheduledJobSuccessEvent).not.toHaveBeenCalled();
  });
});
