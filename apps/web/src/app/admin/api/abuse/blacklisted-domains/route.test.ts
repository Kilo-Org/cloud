import { NextResponse } from 'next/server';
import { cleanupDbForTest, readDb } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBlacklistedDomains } from '@kilocode/web-shared/lib/blacklist-domains-config';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { BLACKLIST_STATS_ROW_LIMIT } from '@/lib/abuse/blacklist-domain-stats';
import { GET } from './route';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/blacklist-domains-config', () => ({
  getBlacklistedDomains: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBlacklistedDomains = jest.mocked(getBlacklistedDomains);

async function insertHostUsers(emailHost: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await insertTestUser({ google_user_email: `user${i}@${emailHost}` });
  }
}

describe('GET /admin/api/abuse/blacklisted-domains', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: defineTestUser({ is_admin: true }),
      authFailedResponse: null,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports per-domain blocked counts from one grouped query', async () => {
    await insertHostUsers('mailinator.com', 3);
    await insertHostUsers('sub.mailinator.com', 1);
    await insertHostUsers('spam.org', 2);
    await insertHostUsers('notmailinator.com', 2);
    // The count reads the email itself, so a row without the stored domain still counts.
    await insertTestUser({ google_user_email: 'legacy@mailinator.com', email_domain: null });

    mockedGetBlacklistedDomains.mockResolvedValue([
      'mailinator.com',
      'sub.mailinator.com',
      'spam.org',
      'unused.io',
    ]);
    const selectSpy = jest.spyOn(readDb, 'select');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    expect(selectSpy).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      domains: [
        { domain: 'mailinator.com', blockedCount: 5 },
        { domain: 'spam.org', blockedCount: 2 },
        { domain: 'sub.mailinator.com', blockedCount: 1 },
        { domain: 'unused.io', blockedCount: 0 },
      ],
      totalDomains: 4,
      totalBlockedUsers: 8,
    });
  });

  it('reads the host after the last @, and keeps an address that holds none', async () => {
    await insertHostUsers('mailinator.com', 2);
    // Sign-in reads the text after the last '@' as the host.
    await insertTestUser({ google_user_email: 'first@second@mailinator.com' });
    // An address without '@' is its own host, matched on a dotted suffix.
    await insertTestUser({ google_user_email: 'deep.spam.org' });
    // Its whole text is never an exact entry.
    await insertTestUser({ google_user_email: 'spam.org' });

    mockedGetBlacklistedDomains.mockResolvedValue(['mailinator.com', 'spam.org']);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      domains: [
        { domain: 'mailinator.com', blockedCount: 3 },
        { domain: 'spam.org', blockedCount: 1 },
      ],
      totalDomains: 2,
      totalBlockedUsers: 4,
    });
  });

  it('keeps one query and a bounded row count for a large blacklist', async () => {
    await insertHostUsers('bulk7.test', 5);
    const blacklistedDomains = Array.from({ length: 300 }, (_, i) => `bulk${i}.test`);
    mockedGetBlacklistedDomains.mockResolvedValue(blacklistedDomains);
    const selectSpy = jest.spyOn(readDb, 'select');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(selectSpy).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body.domains).toHaveLength(BLACKLIST_STATS_ROW_LIMIT);
    expect(body.domains[0]).toEqual({ domain: 'bulk7.test', blockedCount: 5 });
    expect(body.totalDomains).toBe(blacklistedDomains.length);
    expect(body.totalBlockedUsers).toBe(5);
  });

  it('rejects the request before reading the blocklist or the database', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false as const, error: 'Unauthorized' },
        { status: 401 }
      ),
    });
    mockedGetBlacklistedDomains.mockResolvedValue(['mailinator.com']);
    const selectSpy = jest.spyOn(readDb, 'select');

    const response = await GET();

    expect(response.status).toBe(401);
    expect(selectSpy).not.toHaveBeenCalled();
    expect(mockedGetBlacklistedDomains).not.toHaveBeenCalled();
  });
});
