import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { blacklisted_domains, domain_blacklist_state, kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { envFallbackDomains } from '@kilocode/web-shared/lib/blacklist-domains-config';
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
  envFallbackDomains: [],
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
  const stateLimit = jest.fn();
  const domainLimit = jest.fn();
  const domainWhere = jest.fn();
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
    envFallbackDomains.length = 0;
    mockedGetUserFromAuth.mockResolvedValue({
      user: { is_admin: true } as User,
      authFailedResponse: null,
    });
    mockedFindUsers.mockResolvedValue(users);
    mockedFindNotes.mockResolvedValue([]);
    stateLimit.mockResolvedValue([{ useEnvFallback: false }]);
    domainLimit.mockResolvedValue([]);
    domainWhere.mockReturnValue({ limit: domainLimit });
    from.mockImplementation(table => {
      if (table === kilocode_users) {
        return { where: jest.fn(async () => [{ count: users.length }]) };
      }
      if (table === domain_blacklist_state) {
        return { where: jest.fn(() => ({ limit: stateLimit })) };
      }
      if (table === blacklisted_domains) return { where: domainWhere };
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
    domainLimit.mockResolvedValue([{ domain: '0x127' }]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.users.map((row: { is_blacklisted_by_domain: boolean }) => row.is_blacklisted_by_domain)
    ).toEqual([true, ...Array(99).fill(false)]);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    expect(stateLimit).toHaveBeenCalledTimes(1);
    expect(from.mock.calls.filter(([table]) => table === blacklisted_domains)).toHaveLength(1);
    expect(domainLimit).toHaveBeenCalledWith(12_800);
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
    domainLimit.mockResolvedValue([{ domain: 'example.test' }]);

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
    expect(domainLimit).toHaveBeenCalledWith(params.length);
  });

  it('uses only deployment fallback domains when the readiness state selects fallback', async () => {
    setUsers(['user@ENV.TEST', 'user@sub.env.test', 'user@stored.test']);
    envFallbackDomains.push('ENV.TEST');
    stateLimit.mockResolvedValue([{ useEnvFallback: true }]);
    domainLimit.mockResolvedValue([{ domain: 'stored.test' }]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.users.map((row: { is_blacklisted_by_domain: boolean }) => row.is_blacklisted_by_domain)
    ).toEqual([true, true, false]);
    expect(stateLimit).toHaveBeenCalledTimes(1);
    expect(domainWhere).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'marks oversized hosts blocked without a domain query (fallback=%s)',
    async fallback => {
      setUsers([`user@${'x'.repeat(1025)}`, `user@${Array(129).fill('x').join('.')}`]);
      stateLimit.mockResolvedValue([{ useEnvFallback: fallback }]);

      const response = await GET(request());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(
        body.users.map((row: { is_blacklisted_by_domain: boolean }) => row.is_blacklisted_by_domain)
      ).toEqual([true, true]);
      expect(stateLimit).toHaveBeenCalledTimes(1);
      expect(domainWhere).not.toHaveBeenCalled();
    }
  );

  it('does not query the domain table for an empty page', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect((await response.json()).users).toEqual([]);
    expect(domainWhere).not.toHaveBeenCalled();
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

  it('does not treat an unready blacklist as empty', async () => {
    setUsers(['user@example.test']);
    stateLimit.mockResolvedValue([]);

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to fetch users' });
    expect(captureException).toHaveBeenCalledWith(
      new Error('Domain blacklist initialization has not completed'),
      expect.any(Object)
    );
    expect(domainWhere).not.toHaveBeenCalled();
  });

  it.each(['state', 'domains'])('does not hide a %s lookup failure', async lookup => {
    setUsers(['user@example.test']);
    const error = new Error('Database unavailable');
    (lookup === 'state' ? stateLimit : domainLimit).mockRejectedValueOnce(error);

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(captureException).toHaveBeenCalledWith(error, expect.any(Object));
  });

  it('returns the admin authorization failure before querying users or blacklist state', async () => {
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
