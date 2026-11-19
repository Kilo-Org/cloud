import { beforeAll, describe, expect, it } from '@jest/globals';
import { cli_sessions_v2, type User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { cliSessionsV2Router } from './cli-sessions-v2-router';

const USER_ID = 'oauth/github|workspace-activity-order-owner';
const createCaller = createCallerFactory(cliSessionsV2Router);
let user: User;

beforeAll(async () => {
  user = await insertTestUser({ id: USER_ID, is_admin: false });
});

describe('cliSessionsV2 activity ordering', () => {
  it('orders list and search by coalesced last activity and applies the window to that key', async () => {
    await db.insert(cli_sessions_v2).values([
      {
        session_id: 'ses_activity_stale',
        kilo_user_id: USER_ID,
        title: 'Stale activity',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-20T00:00:00.000Z',
        last_activity_at: '2020-01-01T00:00:00.000Z',
      },
      {
        session_id: 'ses_activity_fresh',
        kilo_user_id: USER_ID,
        title: 'Fresh activity',
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-01T00:00:00.000Z',
        last_activity_at: '2026-08-21T00:00:00.000Z',
      },
      {
        session_id: 'ses_activity_middle',
        kilo_user_id: USER_ID,
        title: 'Middle activity',
        created_at: '2026-08-10T00:00:00.000Z',
      },
    ]);
    const caller = createCaller({ user });
    const list = await caller.list({
      orderBy: 'activity',
      updatedSince: '2025-01-01T00:00:00.000Z',
    });
    expect(list.cliSessions.map(session => session.session_id)).toEqual([
      'ses_activity_fresh',
      'ses_activity_middle',
    ]);
    expect(new Date(list.cliSessions[0]?.last_activity_at ?? '').toISOString()).toBe(
      '2026-08-21T00:00:00.000Z'
    );
    const search = await caller.search({ search_string: 'activity', orderBy: 'activity' });
    expect(search.results.map(session => session.session_id)).toEqual([
      'ses_activity_fresh',
      'ses_activity_middle',
      'ses_activity_stale',
    ]);
  });
});
