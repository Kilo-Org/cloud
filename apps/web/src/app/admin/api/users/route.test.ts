import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { blacklisted_domains, kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { captureException } from '@sentry/nextjs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { GET } from './route';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: jest.fn(),
    query: {
      kilocode_users: { findMany: jest.fn() },
      user_admin_notes: { findMany: jest.fn() },
    },
  },
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/blacklist-domains-config', () => ({
  envFallbackDomains: ['ENV.TEST', 'elsewhere.test'],
}));
jest.mock('@kilocode/web-shared/lib/admin-utils-serverside', () => ({
  describePaymentMethods: jest.fn(() => ({})),
  getPaymentStatusByUserIds: jest.fn(async () => ({})),
}));
jest.mock('@kilocode/web-shared/lib/welcomeCredits', () => ({
  getUsersWithAnyFreeWelcomeCredits: jest.fn(async () => new Set()),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/types/admin', () => ({ sortableFields: ['created_at', 'google_user_email'] }));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedFindUsers = jest.mocked(db.query.kilocode_users.findMany);
const mockedFindNotes = jest.mocked(db.query.user_admin_notes.findMany);
const mockedSelect = jest.mocked(db.select);

describe('GET /admin/api/users blacklist annotations', () => {
  const candidateLimit = jest.fn();
  const existenceLimit = jest.fn();
  const domainWhere = jest.fn();
  const domainOrderBy = jest.fn();
  const from = jest.fn();
  let users: User[];

  function user(email: string, index: number): User {
    return { id: `oauth/test-${index}`, google_user_email: email } as User;
  }

  function setUsers(emails: string[]) {
    users = emails.map(user);
    mockedFindUsers.mockResolvedValue(users);
  }

  function request(limit = '100') {
    return new NextRequest(`http://localhost/admin/api/users?limit=${limit}`);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    users = [];
    mockedGetUserFromAuth.mockResolvedValue({
      user: { is_admin: true } as User,
      authFailedResponse: null,
    });
    mockedFindUsers.mockResolvedValue(users);
    mockedFindNotes.mockResolvedValue([]);
    candidateLimit.mockResolvedValue([]);
    existenceLimit.mockResolvedValue([]);
    domainWhere.mockReturnValue({ limit: candidateLimit });
    domainOrderBy.mockReturnValue({ limit: existenceLimit });
    from.mockImplementation(table => {
      if (table === kilocode_users) {
        return { where: jest.fn(async () => [{ count: users.length }]) };
      }
      if (table === blacklisted_domains) {
        return { where: domainWhere, orderBy: domainOrderBy };
      }
      throw new Error('Unexpected table');
    });
    mockedSelect.mockReturnValue({ from } as unknown as ReturnType<typeof db.select>);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses one bounded primary-key query for a full page with 12,800 distinct suffixes', async () => {
    setUsers(
      Array.from(
        { length: 100 },
        (_, index) =>
          `user@${Array.from({ length: 128 }, (_, label) => `${index}x${label}`).join('.')}`
      )
    );
    candidateLimit.mockResolvedValue([{ domain: '0x127' }]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.users.map((row: { is_blacklisted_by_domain: boolean }) => row.is_blacklisted_by_domain)
    ).toEqual([true, ...Array(99).fill(false)]);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    expect(domainWhere).toHaveBeenCalledTimes(1);
    expect(from.mock.calls.filter(([table]) => table === blacklisted_domains)).toHaveLength(1);
    expect(from.mock.calls.filter(([table]) => table === kilocode_users)).toHaveLength(1);
    expect(candidateLimit).toHaveBeenCalledWith(12_800);
    expect(domainOrderBy).not.toHaveBeenCalled();
    const query = new PgDialect().sqlToQuery(domainWhere.mock.calls[0][0]);
    expect(query.sql).toContain('"blacklisted_domains"."domain" in (');
    expect(query.params).toHaveLength(12_800);
    expect(new Set(query.params).size).toBe(12_800);
    expect(query.params).toContain('0x127');
    expect(body.pagination).toEqual({ page: 1, limit: 100, total: 100, totalPages: 1 });
  });

  it('deduplicates normalized candidates and preserves label-boundary and malformed-address semantics', async () => {
    setUsers([
      'user@EXAMPLE.TEST',
      'user@deep.example.test',
      'user@notexample.test',
      'user@example.test.evil',
      'not-an-email.example.test',
      'example.test',
      'user@prefix@EXAMPLE.TEST',
    ]);
    candidateLimit.mockResolvedValue([{ domain: 'example.test' }]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.users.map((row: { is_blacklisted_by_domain: boolean }) => row.is_blacklisted_by_domain)
    ).toEqual([true, true, false, false, true, false, true]);
    const { params } = new PgDialect().sqlToQuery(domainWhere.mock.calls[0][0]);
    expect(params).toEqual([
      'example.test',
      'test',
      'deep.example.test',
      'notexample.test',
      'example.test.evil',
      'test.evil',
      'evil',
    ]);
    expect(candidateLimit).toHaveBeenCalledWith(params.length);
  });

  it('uses deployment fallback domains when the blacklist table is empty', async () => {
    setUsers(['user@ENV.TEST', 'user@sub.env.test', 'user@stored.test']);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.users.map((row: { is_blacklisted_by_domain: boolean }) => row.is_blacklisted_by_domain)
    ).toEqual([true, true, false]);
    expect(domainWhere).toHaveBeenCalledTimes(1);
    expect(domainOrderBy).toHaveBeenCalledTimes(1);
    expect(existenceLimit).toHaveBeenCalledWith(1);
    const probeQuery = new PgDialect().sqlToQuery(domainOrderBy.mock.calls[0][0]);
    expect(probeQuery.sql).toBe('"blacklisted_domains"."domain" asc');
  });

  it('does not use deployment fallback domains when the blacklist table is nonempty', async () => {
    setUsers(['user@ENV.TEST', 'user@sub.env.test', 'user@stored.test']);
    existenceLimit.mockResolvedValue([{ domain: 'unrelated.stored.test' }]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.users.map((row: { is_blacklisted_by_domain: boolean }) => row.is_blacklisted_by_domain)
    ).toEqual([false, false, false]);
    expect(domainWhere).toHaveBeenCalledTimes(1);
    expect(domainOrderBy).toHaveBeenCalledTimes(1);
    expect(existenceLimit).toHaveBeenCalledWith(1);
  });

  it('skips the existence probe when no unmatched page email matches deployment fallback domains', async () => {
    setUsers(['user@example.test']);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(domainWhere).toHaveBeenCalledTimes(1);
    expect(domainOrderBy).not.toHaveBeenCalled();
  });

  it('marks oversized hosts blocked without a domain query', async () => {
    setUsers([`user@${'x'.repeat(1025)}`, `user@${Array(129).fill('x').join('.')}`]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.users.map((row: { is_blacklisted_by_domain: boolean }) => row.is_blacklisted_by_domain)
    ).toEqual([true, true]);
    expect(domainWhere).not.toHaveBeenCalled();
    expect(domainOrderBy).not.toHaveBeenCalled();
  });

  it('does not query the domain table for an empty page', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect((await response.json()).users).toEqual([]);
    expect(domainWhere).not.toHaveBeenCalled();
    expect(domainOrderBy).not.toHaveBeenCalled();
  });

  it.each([
    ['not-a-number', 25],
    ['0', 1],
    ['1000', 100],
  ])('bounds the page size for limit=%s', async (limit, expectedLimit) => {
    const response = await GET(request(String(limit)));

    expect(response.status).toBe(200);
    expect(mockedFindUsers).toHaveBeenCalledWith(expect.objectContaining({ limit: expectedLimit }));
    expect((await response.json()).pagination.limit).toBe(expectedLimit);
  });

  it.each(['candidate', 'existence'])('does not hide a %s lookup failure', async lookup => {
    setUsers(['user@ENV.TEST']);
    const error = new Error('Database unavailable');
    (lookup === 'candidate' ? candidateLimit : existenceLimit).mockRejectedValueOnce(error);

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(captureException).toHaveBeenCalledWith(error, expect.any(Object));
  });

  it('returns the admin authorization failure before querying users or blacklist domains', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false, error: 'Forbidden' },
        { status: 403 }
      ),
    });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    expect(mockedFindUsers).not.toHaveBeenCalled();
    expect(mockedSelect).not.toHaveBeenCalled();
  });
});
