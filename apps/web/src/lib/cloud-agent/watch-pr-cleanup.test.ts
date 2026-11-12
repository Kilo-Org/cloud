import { PgDialect } from 'drizzle-orm/pg-core';
import { cloud_agent_pr_watch_activity, cloud_agent_pr_watches } from '@kilocode/db/schema';
import { cleanupWatchPrData } from './watch-pr-cleanup';

const mockDelete = jest.fn();
const mockUpdate = jest.fn();

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    delete: (...args: unknown[]) => mockDelete(...args),
    transaction: (callback: (tx: unknown) => unknown) =>
      callback({
        delete: (...args: unknown[]) => mockDelete(...args),
        update: (...args: unknown[]) => mockUpdate(...args),
      }),
  },
}));

it('retains live and paused watches and deletes only old finished watches', async () => {
  const activityWhere = jest.fn().mockResolvedValue({ rowCount: 3 });
  const watchWhere = jest
    .fn()
    .mockReturnValue({ returning: async () => [{ id: 'watch-retained-chat' }] });
  const clearLinks = jest.fn().mockResolvedValue({ rowCount: 1 });
  mockUpdate.mockReturnValue({ set: () => ({ where: clearLinks }) });
  mockDelete.mockReturnValueOnce({ where: activityWhere });
  mockDelete.mockReturnValueOnce({ where: watchWhere });

  const result = await cleanupWatchPrData(new Date('2026-11-12T12:00:00.000Z'));

  expect(mockDelete.mock.calls).toEqual([
    [cloud_agent_pr_watch_activity],
    [cloud_agent_pr_watches],
  ]);
  const condition = watchWhere.mock.calls[0]?.[0];
  if (!condition) throw new Error('Missing watch retention condition');
  const query = new PgDialect().sqlToQuery(condition);
  expect(query.sql).toContain('"cloud_agent_pr_watches"."status" = $1');
  expect(query.sql).toContain(
    'coalesce("cloud_agent_pr_watches"."finished_at", "cloud_agent_pr_watches"."updated_at") < $2'
  );
  expect(query.params).toEqual(['finished', '2026-10-13T12:00:00.000Z']);
  expect(clearLinks).toHaveBeenCalledTimes(1);
  const activityCondition = activityWhere.mock.calls[0]?.[0];
  if (!activityCondition) throw new Error('Missing activity retention condition');
  const activityQuery = new PgDialect().sqlToQuery(activityCondition);
  expect(activityQuery.sql).toContain('"cloud_agent_pr_watch_activity"."kind" = \'reply\'');
  expect(activityQuery.sql).toContain('"cloud_agent_pr_watches"."status" <> \'finished\'');
  expect(activityQuery.sql).toContain(
    '"cloud_agent_pr_watches"."id" = "cloud_agent_pr_watch_activity"."watch_id"'
  );
  expect(result).toEqual({
    cutoff: '2026-10-13T12:00:00.000Z',
    deletedActivityCount: 3,
    deletedWatchCount: 1,
  });
});
