import { describe, test, expect, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { and, count, eq, gte, inArray, lte, not, sql } from 'drizzle-orm';
import {
  cloud_agent_code_reviews,
  microdollar_usage,
  organization_memberships,
  organizations,
  sharedCliSessions,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { AUTOCOMPLETE_MODEL } from '@kilocode/web-shared/lib/constants';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { insertUsageWithOverrides } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { addUserToOrganization, createOrganization, getOrganizationMembers } from './organizations';
import {
  getAgentInteractionsPerDay,
  getCloudAgentSessionsPerDay,
  getCodeReviewsPerDay,
} from './organization-usage';

const START = '2025-08-01T00:00:00.000Z';
const END = '2025-08-31T00:00:00.000Z';

const createdOrganizationIds: string[] = [];

async function setup() {
  const organization = await createOrganization(`Adoption reads ${randomUUID()}`);
  createdOrganizationIds.push(organization.id);
  const [active, otherActive, former, bot, outsider] = await Promise.all([
    insertTestUser(),
    insertTestUser(),
    insertTestUser(),
    insertTestUser({ is_bot: true }),
    insertTestUser(),
  ]);
  await addUserToOrganization(organization.id, active.id, 'owner');
  await addUserToOrganization(organization.id, otherActive.id, 'billing_manager');
  await addUserToOrganization(organization.id, former.id, 'member');
  await addUserToOrganization(organization.id, bot.id, 'member');

  const activity = [
    { user: active, day: '2025-08-10', model: 'anthropic/claude-sonnet' },
    { user: active, day: '2025-08-10', model: 'anthropic/claude-sonnet' },
    { user: active, day: '2025-08-11', model: 'anthropic/claude-sonnet' },
    { user: active, day: '2025-08-11', model: AUTOCOMPLETE_MODEL },
    { user: otherActive, day: '2025-08-12', model: 'anthropic/claude-sonnet' },
    { user: former, day: '2025-08-12', model: 'anthropic/claude-sonnet' },
    { user: bot, day: '2025-08-12', model: 'anthropic/claude-sonnet' },
    { user: outsider, day: '2025-08-12', model: 'anthropic/claude-sonnet' },
  ];
  for (const { user, day, model } of activity) {
    await insertUsageWithOverrides({
      kilo_user_id: user.id,
      organization_id: organization.id,
      created_at: `${day}T12:00:00.000Z`,
      model,
    });
    await db.insert(sharedCliSessions).values({
      kilo_user_id: user.id,
      created_at: `${day}T12:00:00.000Z`,
    });
    await db.insert(cloud_agent_code_reviews).values({
      owned_by_organization_id: organization.id,
      repo_full_name: 'owner/repo',
      pr_number: 1,
      pr_url: 'https://example.com/pr/1',
      pr_title: 'Title',
      pr_author: 'author',
      base_ref: 'main',
      head_ref: 'feature',
      head_sha: 'abc',
      created_at: `${day}T12:00:00.000Z`,
    });
  }

  // `former` leaves the organization after producing usage.
  await db
    .delete(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organization.id),
        eq(organization_memberships.kilo_user_id, former.id)
      )
    );

  return { organization, active, otherActive, former, bot, outsider };
}

function normalize<T extends { userId: string | null; date: string }>(rows: T[]) {
  return rows
    .map(row => JSON.stringify(row))
    .sort()
    .map(row => JSON.parse(row) as T);
}

async function memberIds(organizationId: string): Promise<string[]> {
  const members = await getOrganizationMembers(organizationId);
  return members.flatMap(member => (member.status === 'active' ? [member.id] : []));
}

describe('AI adoption per-day reads', () => {
  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
    }
  });

  test('agent interactions match the old member id list and exclude former members', async () => {
    const { organization, active, otherActive, former, bot, outsider } = await setup();
    const userIds = await memberIds(organization.id);
    expect(userIds.sort()).toEqual([active.id, otherActive.id].sort());

    const reference = await db
      .select({
        userId: microdollar_usage.kilo_user_id,
        date: sql<string>`DATE(${microdollar_usage.created_at})`.as('date'),
        requestCount: count(microdollar_usage.id),
      })
      .from(microdollar_usage)
      .where(
        and(
          eq(microdollar_usage.organization_id, organization.id),
          gte(microdollar_usage.created_at, START),
          lte(microdollar_usage.created_at, END),
          not(eq(microdollar_usage.model, AUTOCOMPLETE_MODEL)),
          inArray(microdollar_usage.kilo_user_id, userIds)
        )
      )
      .groupBy(microdollar_usage.kilo_user_id, sql`DATE(${microdollar_usage.created_at})`);

    const rows = await getAgentInteractionsPerDay(organization.id, START, END);

    expect(normalize(rows)).toEqual(normalize(reference));
    expect(rows).toHaveLength(3);
    expect(rows.find(r => r.userId === active.id && r.date === '2025-08-10')?.requestCount).toBe(2);
    expect(rows.find(r => r.userId === active.id && r.date === '2025-08-11')?.requestCount).toBe(1);
    const returnedUsers = new Set(rows.map(r => r.userId));
    for (const excluded of [former, bot, outsider]) {
      expect(returnedUsers.has(excluded.id)).toBe(false);
    }
  });

  test('cloud agent sessions and code reviews exclude former members and bots', async () => {
    const { organization, active, otherActive, former, bot, outsider } = await setup();

    const sessions = await getCloudAgentSessionsPerDay(organization.id, START, END);
    const reviews = await getCodeReviewsPerDay(organization.id, START, END);
    // Organization-owned reviews have no owning user, so the user filter matches none of them,
    // exactly as the member id list did.
    const referenceReviews = await db
      .select({ userId: cloud_agent_code_reviews.owned_by_user_id })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          eq(cloud_agent_code_reviews.owned_by_organization_id, organization.id),
          inArray(cloud_agent_code_reviews.owned_by_user_id, await memberIds(organization.id))
        )
      );
    expect(reviews).toEqual(referenceReviews);

    const expected = [active.id, otherActive.id].sort();
    expect([...new Set(sessions.map(r => r.userId))].sort()).toEqual(expected);
    expect(
      sessions.find(r => r.userId === active.id && r.date === '2025-08-11')?.sessionCount
    ).toBe(2);
    for (const excluded of [former, bot, outsider]) {
      expect(sessions.some(r => r.userId === excluded.id)).toBe(false);
    }
  });

  test('reads run on the connection passed as fromDb', async () => {
    const { organization } = await setup();
    const spy = jest.spyOn(db, 'select');
    try {
      await getAgentInteractionsPerDay(organization.id, START, END, db);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const fakeDb = {
      select: jest.fn(() => {
        throw new Error('used fromDb');
      }),
    } as never;
    await expect(getAgentInteractionsPerDay(organization.id, START, END, fakeDb)).rejects.toThrow(
      'used fromDb'
    );
  });
});
