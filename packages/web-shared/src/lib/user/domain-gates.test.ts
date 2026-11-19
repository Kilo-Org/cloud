jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn() },
}));

import { beforeEach, describe, expect, test } from '@jest/globals';
import { blacklisted_domains, blacklisted_domains_settings } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { clearEmailBlacklistCache } from '@kilocode/web-shared/lib/blacklist-domains-config';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';
import { isBlockedTLD, isEmailOnBlockedTld, isUserBlacklistedByDomain } from './domain-gates';

describe('signup TLD settings', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    clearEmailBlacklistCache();
    jest.mocked(redisClient.get).mockReset();
    jest.mocked(redisClient.get).mockImplementation(async <T>(key: string) =>
      key === BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY
        ? (JSON.stringify({
            blocked_signup_tlds: ['shop'],
            updated_at: null,
            updated_by: null,
            updated_by_email: null,
          }) as T)
        : null
    );
  });

  async function insertSettings(blocked_signup_tlds: string[]): Promise<void> {
    await db.insert(blacklisted_domains_settings).values({
      blocked_signup_tlds,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  }

  test('uses Postgres instead of conflicting Redis settings for signup decisions', async () => {
    await insertSettings(['asia']);

    await expect(isBlockedTLD('new@example.asia')).resolves.toBe(true);
    await expect(isBlockedTLD('new@example.shop')).resolves.toBe(false);
    expect(redisClient.get).not.toHaveBeenCalled();
  });

  test('honors an explicit empty Postgres list instead of Redis or defaults', async () => {
    await insertSettings([]);

    await expect(isBlockedTLD('new@example.shop')).resolves.toBe(false);
    await expect(isBlockedTLD('new@example.top')).resolves.toBe(false);
    expect(redisClient.get).not.toHaveBeenCalled();
  });

  test('uses updated Postgres settings on the next signup check', async () => {
    await insertSettings(['asia']);
    await expect(isBlockedTLD('new@example.asia')).resolves.toBe(true);

    await db
      .update(blacklisted_domains_settings)
      .set({ blocked_signup_tlds: ['shop'] })
      .where(eq(blacklisted_domains_settings.id, 1));

    await expect(isBlockedTLD('new@example.asia')).resolves.toBe(false);
    await expect(isBlockedTLD('new@example.shop')).resolves.toBe(true);
  });

  test('keeps existing-user domain checks separate from the signup TLD gate', async () => {
    await insertSettings(['asia']);
    await db.insert(blacklisted_domains).values({ domain: 'blocked.example' });

    await expect(isBlockedTLD('existing@example.asia')).resolves.toBe(true);
    await expect(
      isUserBlacklistedByDomain({ google_user_email: 'existing@example.asia' })
    ).resolves.toBe(false);
    await expect(
      isUserBlacklistedByDomain({ google_user_email: 'existing@sub.blocked.example' })
    ).resolves.toBe(true);
    await expect(
      isUserBlacklistedByDomain({ google_user_email: 'existing@notblocked.example' })
    ).resolves.toBe(false);
  });
});

describe('isEmailOnBlockedTld', () => {
  const defaultTlds = ['shop', 'top'];

  test('should block the default .shop and .top TLDs', () => {
    expect(isEmailOnBlockedTld('user@example.shop', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@example.top', defaultTlds)).toBe(true);
  });

  test('should block a TLD added by an admin', () => {
    expect(isEmailOnBlockedTld('user@example.asia', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.asia', [...defaultTlds, 'asia'])).toBe(true);
  });

  test('should block subdomains under blocked TLDs', () => {
    expect(isEmailOnBlockedTld('user@sub.domain.shop', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@sub.domain.top', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@sub.domain.asia', ['asia'])).toBe(true);
  });

  test('should allow .com, .org, .io TLDs', () => {
    expect(isEmailOnBlockedTld('user@example.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.org', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.io', defaultTlds)).toBe(false);
  });

  test('should be case insensitive', () => {
    expect(isEmailOnBlockedTld('user@example.SHOP', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@example.TOP', defaultTlds)).toBe(true);
    expect(isEmailOnBlockedTld('user@example.ASIA', ['asia'])).toBe(true);
    expect(isEmailOnBlockedTld('USER@EXAMPLE.Shop', defaultTlds)).toBe(true);
  });

  test('should not block domains containing blocked TLD as a non-TLD part', () => {
    expect(isEmailOnBlockedTld('user@shop.example.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@top.example.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@myshop.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@topnotch.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.shop.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.top.com', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.asia.com', ['asia'])).toBe(false);
    expect(isEmailOnBlockedTld('user@asia.example.com', ['asia'])).toBe(false);
    expect(isEmailOnBlockedTld('user@notasia.com', ['asia'])).toBe(false);
  });

  test('should require a leading dot before the blocked TLD', () => {
    expect(isEmailOnBlockedTld('user@exampleshop', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@exampletop', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@exampleasia', ['asia'])).toBe(false);
  });

  test('should allow every TLD when the admin list is empty', () => {
    expect(isEmailOnBlockedTld('user@example.shop', [])).toBe(false);
    expect(isEmailOnBlockedTld('user@example.asia', [])).toBe(false);
  });

  test('should allow other TLDs including multi-part TLDs', () => {
    expect(isEmailOnBlockedTld('user@example.co.uk', defaultTlds)).toBe(false);
    expect(isEmailOnBlockedTld('user@example.uk', defaultTlds)).toBe(false);
  });
});
