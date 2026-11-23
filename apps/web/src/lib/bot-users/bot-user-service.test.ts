jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/utils.server'),
  logExceptInTest: jest.fn(),
  errorExceptInTest: jest.fn(),
}));

import { Client, db } from '@kilocode/web-shared/lib/drizzle';
import { computeDatabaseUrl } from '@kilocode/db';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { errorExceptInTest, logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { Client as PgClient } from 'pg';
import { randomUUID } from 'crypto';
import {
  ensureBotUserForOrg,
  ensureInternalBotUser,
  InternalBotUnusableError,
} from './bot-user-service';
import { generateBotUserId } from './types';

async function membershipsOf(userId: string) {
  return db
    .select()
    .from(organization_memberships)
    .where(eq(organization_memberships.kilo_user_id, userId));
}

async function newOrganization() {
  const owner = await insertTestUser();
  return createTestOrganization('Internal bots', owner.id, 0);
}

/**
 * Counts backends the blocker connection is holding up. The observation runs on
 * its own connection, and `pg_backend_pid()` keeps the counter from matching the
 * observation statement itself.
 */
const BLOCKED_BY = `
  SELECT count(*)::int AS blocked
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
    AND state = 'active'
    AND wait_event_type = 'Lock'
    AND $1::int = ANY(pg_blocking_pids(pid))
`;

/**
 * Poll pacing for the lock wait below. The awaited condition is the Postgres
 * lock, which no fake timer can drive; 20 ms only bounds how often the monitor
 * looks.
 */
async function pollDelay(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 20);
  return promise;
}

/** The backend pid of `client`'s single connection. */
async function backendPid(client: PgClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('expected pg_backend_pid() to return a pid');
  return pid;
}

/** Waits until a backend is queued behind the blocker's open transaction. */
async function waitForBlockedBy(monitor: PgClient, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await monitor.query<{ blocked: number }>(BLOCKED_BY, [blockerPid]);
    if ((rows[0]?.blocked ?? 0) > 0) {
      return;
    }
    await pollDelay();
  }
  throw new Error('expected a backend to wait on the blocker connection');
}

/**
 * Every message on the `.cause` chain. Drizzle wraps a driver failure in a
 * `DrizzleQueryError` whose own message names only the statement, so the
 * server's text sits one level down.
 */
function errorChainText(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const { message, cause } = current as { message?: unknown; cause?: unknown };
    if (typeof message === 'string') messages.push(message);
    current = cause;
  }
  return messages.join('\n');
}

/** The message of every `logExceptInTest` call, in order. */
function loggedMessages(): string[] {
  return jest.mocked(logExceptInTest).mock.calls.map(call => String(call[0]));
}

/** The message of every `errorExceptInTest` call, in order. */
function errorMessages(): string[] {
  return jest.mocked(errorExceptInTest).mock.calls.map(call => String(call[0]));
}

beforeEach(() => {
  jest.mocked(logExceptInTest).mockClear();
  jest.mocked(errorExceptInTest).mockClear();
});

describe('ensureInternalBotUser', () => {
  it('creates one eligible bot user and one member row, and reuses both on repeat', async () => {
    const org = await newOrganization();
    const slug = `t-${randomUUID().slice(0, 8)}`;
    const input = { slug, displayName: 'Test Bot', organizationId: org.id };

    const first = await ensureInternalBotUser(input);
    const second = await ensureInternalBotUser(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(`bot-internal-${slug}`);
    expect(second.user.api_token_pepper).toBe(first.user.api_token_pepper);
    expect(first.user).toMatchObject({
      is_bot: true,
      google_user_email: `${slug}-internal-bot@kilocode.internal`,
      auto_top_up_enabled: false,
      blocked_at: null,
    });
    expect(first.user.api_token_pepper).toMatch(/^[a-f0-9]{64}$/);
    expect(first.user.stripe_customer_id).toMatch(/^bot_stripe_/);

    const users = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, first.user.id));
    expect(users).toHaveLength(1);
    const memberships = await membershipsOf(first.user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ organization_id: org.id, role: 'member' });
  });

  it('adds a membership for an existing bot in a second organization without re-creating it', async () => {
    const [orgA, orgB] = [await newOrganization(), await newOrganization()];
    const slug = `t-${randomUUID().slice(0, 8)}`;
    const first = await ensureInternalBotUser({ slug, displayName: 'A', organizationId: orgA.id });
    const second = await ensureInternalBotUser({ slug, displayName: 'B', organizationId: orgB.id });

    expect(second.created).toBe(false);
    expect(second.user.google_user_name).toBe('A');
    const orgIds = (await membershipsOf(first.user.id)).map(m => m.organization_id).sort();
    expect(orgIds).toEqual([orgA.id, orgB.id].sort());
  });

  it('keeps an existing membership role instead of inserting a duplicate', async () => {
    const org = await newOrganization();
    const slug = `t-${randomUUID().slice(0, 8)}`;
    const { user } = await ensureInternalBotUser({
      slug,
      displayName: 'Test Bot',
      organizationId: org.id,
    });
    await db
      .update(organization_memberships)
      .set({ role: 'owner' })
      .where(eq(organization_memberships.kilo_user_id, user.id));

    await ensureInternalBotUser({ slug, displayName: 'Test Bot', organizationId: org.id });

    const memberships = await membershipsOf(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe('owner');
  });

  it.each([
    ['a non-bot user', { is_bot: false }, /is not a bot/],
    [
      'a bot with blocked_at set',
      { is_bot: true, blocked_at: '2026-10-01T00:00:00.000Z' },
      /is blocked/,
    ],
    ['a soft-deleted bot', { is_bot: true, blocked_reason: 'soft-deleted' }, /is blocked/],
    ['a bot with an empty pepper', { is_bot: true, api_token_pepper: '' }, /no API token pepper/],
  ])('refuses to adopt %s that holds the internal bot id', async (_label, overrides, reason) => {
    const org = await newOrganization();
    const slug = `t-${randomUUID().slice(0, 8)}`;
    // Every fixture except the empty-pepper case has a valid pepper, so each
    // case fails only on the condition it names.
    await insertTestUser({
      id: `bot-internal-${slug}`,
      api_token_pepper: 'a'.repeat(64),
      ...overrides,
    });

    const attempt = ensureInternalBotUser({
      slug,
      displayName: 'Test Bot',
      organizationId: org.id,
    });
    await expect(attempt).rejects.toBeInstanceOf(InternalBotUnusableError);
    await expect(attempt).rejects.toThrow(reason);
    expect(await membershipsOf(`bot-internal-${slug}`)).toHaveLength(0);
  });

  it('creates exactly one user and one membership under concurrent calls', async () => {
    const org = await newOrganization();
    const slug = `t-${randomUUID().slice(0, 8)}`;
    const input = { slug, displayName: 'Test Bot', organizationId: org.id };

    const results = await Promise.all([ensureInternalBotUser(input), ensureInternalBotUser(input)]);

    expect(results.map(r => r.user.id)).toEqual([`bot-internal-${slug}`, `bot-internal-${slug}`]);
    expect(await membershipsOf(`bot-internal-${slug}`)).toHaveLength(1);
  });

  it('rejects a slug outside the allowed pattern', async () => {
    const org = await newOrganization();
    await expect(
      ensureInternalBotUser({ slug: '-Bad', displayName: 'x', organizationId: org.id })
    ).rejects.toThrow('Invalid internal bot slug');
  });
});

describe('ensureBotUserForOrg', () => {
  it('creates one bot user and one membership when two first calls race', async () => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Product bots', owner.id, 0);
    const botId = generateBotUserId(org.id, 'code-review');

    // Two live pool connections, so both calls read before either one inserts.
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    const results = await Promise.all([
      ensureBotUserForOrg(org.id, 'code-review'),
      ensureBotUserForOrg(org.id, 'code-review'),
    ]);

    expect(results.map(user => user.id)).toEqual([botId, botId]);
    const users = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, botId));
    expect(users).toHaveLength(1);
    expect(await membershipsOf(botId)).toEqual([
      expect.objectContaining({ organization_id: org.id, role: 'member' }),
    ]);
  });

  it('reports the bot as already a member when a concurrent insert wins the membership row lock', async () => {
    const org = await newOrganization();
    const botId = generateBotUserId(org.id, 'code-review');

    const blocker = new Client({ connectionString: computeDatabaseUrl() });
    const monitor = new Client({ connectionString: computeDatabaseUrl() });
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.connect();
      await monitor.connect();
      // Hold an uncommitted membership row, so the bot's insert queues behind it
      // and then finds the conflict once the lock is released.
      await blocker.query('BEGIN');
      await blocker.query(
        `INSERT INTO organization_memberships (organization_id, kilo_user_id, role)
         VALUES ($1, $2, 'member')`,
        [org.id, botId]
      );

      pending = ensureBotUserForOrg(org.id, 'code-review');
      await waitForBlockedBy(monitor, await backendPid(blocker));

      await blocker.query('COMMIT');
      await pending;
    } finally {
      await blocker.end().catch(() => undefined);
      await monitor.end().catch(() => undefined);
      if (pending) {
        await pending.catch(() => undefined);
      }
    }

    expect(loggedMessages()).toContainEqual(
      expect.stringContaining('Bot is already an org member')
    );
    expect(loggedMessages()).not.toContainEqual(
      expect.stringContaining('Added bot to organization')
    );
    expect(await membershipsOf(botId)).toEqual([
      expect.objectContaining({ organization_id: org.id, role: 'member' }),
    ]);
  }, 30_000);

  it('reports the bot as added when this call inserts the membership', async () => {
    const org = await newOrganization();
    const botId = generateBotUserId(org.id, 'code-review');

    await ensureBotUserForOrg(org.id, 'code-review');

    expect(
      loggedMessages().filter(message => message.includes('Added bot to organization'))
    ).toHaveLength(1);
    expect(loggedMessages()).not.toContainEqual(
      expect.stringContaining('Bot is already an org member')
    );
    expect(await membershipsOf(botId)).toEqual([
      expect.objectContaining({ organization_id: org.id, role: 'member' }),
    ]);
  });

  it('does not report the bot as ready when the membership insert fails', async () => {
    const org = await newOrganization();
    const admin = new Client({ connectionString: computeDatabaseUrl() });
    let failure: unknown;
    try {
      await admin.connect();
      await admin.query(
        `CREATE OR REPLACE FUNCTION tmp_fail_membership_insert() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'injected membership insert failure';
         END $$`
      );
      await admin.query(
        `CREATE TRIGGER tmp_fail_membership_insert BEFORE INSERT ON organization_memberships
         FOR EACH ROW EXECUTE FUNCTION tmp_fail_membership_insert()`
      );

      try {
        await ensureBotUserForOrg(org.id, 'code-review');
      } catch (error) {
        failure = error;
      }
    } finally {
      await admin
        .query('DROP TRIGGER IF EXISTS tmp_fail_membership_insert ON organization_memberships')
        .catch(() => undefined);
      await admin
        .query('DROP FUNCTION IF EXISTS tmp_fail_membership_insert()')
        .catch(() => undefined);
      await admin.end().catch(() => undefined);
    }

    expect(failure).toBeInstanceOf(Error);
    expect(errorChainText(failure)).toContain('injected membership insert failure');
    expect(errorMessages()).toContainEqual(expect.stringContaining('Failed to ensure bot user'));
    expect(loggedMessages()).not.toContainEqual(expect.stringContaining('Bot user is ready'));
  }, 30_000);

  it.each([
    ['blocked_at', { blocked_at: '2026-10-01T00:00:00.000Z' }],
    ['blocked_reason', { blocked_reason: 'soft-deleted' }],
  ])('rejects an existing bot whose %s is set', async (_label, overrides) => {
    const owner = await insertTestUser();
    const org = await createTestOrganization('Product bots', owner.id, 0);
    const botId = generateBotUserId(org.id, 'code-review');
    await insertTestUser({ id: botId, is_bot: true, ...overrides });

    await expect(ensureBotUserForOrg(org.id, 'code-review')).rejects.toThrow(
      `Cannot use blocked bot user ${botId}`
    );
    expect(await membershipsOf(botId)).toHaveLength(0);
  });
});
