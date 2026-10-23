import { NextRequest } from 'next/server';
import { kilocode_users } from '@kilocode/db';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET, type AccountDeduplicationResponse } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

const groups = [
  { email: 'a@example.com', reasons: ['test', 'test'] },
  { email: 'b@example.com', reasons: ['test', null] },
  { email: 'c@example.com', reasons: [null, null] },
];

async function getPage(params: Record<string, string>) {
  const response = await GET(
    new NextRequest(
      `http://localhost/admin/api/account-deduplication?${new URLSearchParams(params)}`
    )
  );
  expect(response.status).toBe(200);
  return (await response.json()) as AccountDeduplicationResponse;
}

beforeEach(async () => {
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user: defineTestUser({ is_admin: true }),
    authFailedResponse: null,
  });
  await db
    .insert(kilocode_users)
    .values(
      groups.flatMap(group =>
        group.reasons.map(blocked_reason =>
          defineTestUser({ normalized_email: group.email, blocked_reason })
        )
      )
    );
});

afterEach(cleanupDbForTest);

describe('admin account review results', () => {
  it('applies the selected group criteria to results and totals', async () => {
    const result = await getPage({ hideAllBlocked: 'true' });
    expect(result.groups.map(group => group.normalized_email)).toEqual([
      'b@example.com',
      'c@example.com',
    ]);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(result.groups[0].users.map(user => user.blocked_reason).sort()).toEqual([null, 'test']);
    expect(result.groups[1].users.map(user => user.blocked_reason)).toEqual([null, null]);
  });

  it('returns the complete default result set', async () => {
    const result = await getPage({});
    expect(result.groups.map(group => group.normalized_email)).toEqual(
      groups.map(group => group.email)
    );
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
  });

  it('paginates the selected result set', async () => {
    const first = await getPage({ hideAllBlocked: 'true', limit: '1' });
    const second = await getPage({ hideAllBlocked: 'true', limit: '1', page: '2' });
    expect(first.groups.map(group => group.normalized_email)).toEqual(['b@example.com']);
    expect(second.groups.map(group => group.normalized_email)).toEqual(['c@example.com']);
    expect(first.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(second.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
  });
});
