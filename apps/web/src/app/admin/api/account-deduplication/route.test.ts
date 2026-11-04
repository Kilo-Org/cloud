import { NextRequest } from 'next/server';
import { kilocode_users } from '@kilocode/db';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET, MAX_ACCOUNTS_PER_GROUP, type AccountDeduplicationResponse } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

const groups = [
  { email: 'a@example.com', reasons: ['test', 'test'] },
  { email: 'b@example.com', reasons: ['test', null] },
  { email: 'c@example.com', reasons: [null, null] },
];

async function getResponse(params: Record<string, string>) {
  return GET(
    new NextRequest(
      `http://localhost/admin/api/account-deduplication?${new URLSearchParams(params)}`
    )
  );
}

async function getPage(params: Record<string, string>) {
  const response = await getResponse(params);
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

  it('lists a bounded slice of a large group and reports its full size', async () => {
    const largeEmail = 'large@example.com';
    const largeGroupSize = MAX_ACCOUNTS_PER_GROUP + 5;
    await db
      .insert(kilocode_users)
      .values(
        Array.from({ length: largeGroupSize }, () =>
          defineTestUser({ normalized_email: largeEmail })
        )
      );

    const result = await getPage({});

    expect(result.pagination.total).toBe(4);
    const largeGroup = result.groups.find(group => group.normalized_email === largeEmail);
    expect(largeGroup?.users).toHaveLength(MAX_ACCOUNTS_PER_GROUP);
    expect(largeGroup?.account_count).toBe(largeGroupSize);
    const aGroup = result.groups.find(group => group.normalized_email === 'a@example.com');
    expect(aGroup?.users).toHaveLength(2);
    expect(aGroup?.account_count).toBe(2);
  });

  it('reads the accounts of a large group in creation order', async () => {
    const largeEmail = 'ordered@example.com';
    const oldestFirst = Array.from({ length: MAX_ACCOUNTS_PER_GROUP + 1 }, (_, i) =>
      new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString()
    );
    await db.insert(kilocode_users).values(
      oldestFirst
        .slice()
        .reverse()
        .map(created_at => defineTestUser({ normalized_email: largeEmail, created_at }))
    );

    const result = await getPage({});
    const largeGroup = result.groups.find(group => group.normalized_email === largeEmail);
    const expected = oldestFirst.slice(0, MAX_ACCOUNTS_PER_GROUP);
    expect(largeGroup?.users.map(user => new Date(user.created_at).getTime())).toEqual(
      expected.map(createdAt => new Date(createdAt).getTime())
    );
  });

  it('rejects query parameters that are not valid numbers', async () => {
    const invalidParams: Record<string, string>[] = [
      { page: 'abc' },
      { limit: '0' },
      { minAccounts: '1' },
      { minAccounts: 'x' },
    ];
    for (const params of invalidParams) {
      const response = await getResponse(params);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid query parameters' });
    }
  });
});
