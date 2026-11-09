import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { blacklisted_domains, domain_blacklist_state } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { backfillDomainBlacklist } from '@kilocode/web-shared/lib/blacklist-domains-migration';
import {
  MAX_BLACKLIST_DOMAINS,
  type BlacklistDomainsConfig,
} from '@kilocode/worker-utils/account-access';
import { eq, sql } from 'drizzle-orm';

beforeEach(async () => {
  await db.delete(domain_blacklist_state).where(sql`true`);
  await db.delete(blacklisted_domains).where(sql`true`);
});

const legacy = (domains: string[], fields = {}) =>
  JSON.stringify({
    domains,
    updated_at: 'legacy-version',
    updated_by: null,
    updated_by_email: null,
    ...fields,
  });

describe('domain blacklist operational backfill', () => {
  test('preserves entries beyond the old cap, existing rows, and signup/operator configuration', async () => {
    const domains = Array.from(
      { length: MAX_BLACKLIST_DOMAINS + 1 },
      (_, index) => `bulk-${index}.example`
    );
    domains.push('UPPER.example', 'UPPER.example', ' padded.example ');
    const raw = legacy(domains, {
      blocked_signup_tlds: [],
      updated_by: 'operator',
      updated_by_email: 'admin@example.com',
    });
    const read = jest.fn<() => Promise<string | null>>().mockResolvedValue(raw);
    const write = jest
      .fn<(settings: BlacklistDomainsConfig) => Promise<void>>()
      .mockResolvedValue(undefined);
    await db.insert(blacklisted_domains).values({ domain: 'preexisting.example' });
    await backfillDomainBlacklist(db, read, write);
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(blacklisted_domains);
    expect(count.count).toBe(MAX_BLACKLIST_DOMAINS + 4);
    expect(
      await db
        .select()
        .from(blacklisted_domains)
        .where(eq(blacklisted_domains.domain, `bulk-${MAX_BLACKLIST_DOMAINS}.example`))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(blacklisted_domains)
        .where(eq(blacklisted_domains.domain, ' padded.example '))
    ).toHaveLength(1);
    expect(write).toHaveBeenCalledWith({
      domains: [],
      blocked_signup_tlds: [],
      updated_at: 'legacy-version',
      updated_by: 'operator',
      updated_by_email: 'admin@example.com',
    });
    const [state] = await db.select().from(domain_blacklist_state);
    expect(state.use_env_fallback).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(backfillDomainBlacklist(db, read, write)).rejects.toThrow('already initialized');
  }, 30_000);

  test('a failed Redis source read never marks an empty table ready', async () => {
    await expect(
      backfillDomainBlacklist(
        db,
        async () => {
          throw new Error('Redis timeout');
        },
        async () => {}
      )
    ).rejects.toThrow('Redis timeout');
    expect(await db.select().from(domain_blacklist_state)).toEqual([]);
  });

  test('malformed legacy data and concurrent legacy edits abort without dropping entries', async () => {
    await db.insert(blacklisted_domains).values({ domain: 'preexisting.example' });
    await expect(
      backfillDomainBlacklist(
        db,
        async () => '{bad json',
        async () => {}
      )
    ).rejects.toThrow();
    const read = jest
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(legacy(['first.example']))
      .mockResolvedValueOnce(legacy(['first.example', 'second.example']));
    await expect(backfillDomainBlacklist(db, read, async () => {})).rejects.toThrow('changed');
    expect(await db.select().from(blacklisted_domains)).toEqual([
      { domain: 'preexisting.example' },
    ]);
    expect(await db.select().from(domain_blacklist_state)).toEqual([]);
  });

  test('settings write failure rolls back the import and leaves readiness unset', async () => {
    await expect(
      backfillDomainBlacklist(
        db,
        async () => legacy(['blocked.example']),
        async () => {
          throw new Error('Redis write failed');
        }
      )
    ).rejects.toThrow('Redis write failed');
    expect(await db.select().from(blacklisted_domains)).toEqual([]);
    expect(await db.select().from(domain_blacklist_state)).toEqual([]);
  });

  test.each([null, legacy([])])(
    'a successful absent or empty legacy config keeps deployment fallbacks (%s)',
    async raw => {
      const write = jest
        .fn<(settings: BlacklistDomainsConfig) => Promise<void>>()
        .mockResolvedValue(undefined);
      await backfillDomainBlacklist(db, async () => raw, write);
      const [state] = await db.select().from(domain_blacklist_state);
      expect(state.use_env_fallback).toBe(true);
      const [settings] = write.mock.calls[0];
      expect(settings).not.toHaveProperty('blocked_signup_tlds');
    }
  );
});
