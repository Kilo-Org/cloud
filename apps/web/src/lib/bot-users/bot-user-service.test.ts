import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { randomUUID } from 'crypto';
import { ensureInternalBotUser, InternalBotUnusableError } from './bot-user-service';

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
    ['a non-bot user', { is_bot: false }],
    ['a bot with blocked_at set', { is_bot: true, blocked_at: '2026-10-01T00:00:00.000Z' }],
    ['a soft-deleted bot', { is_bot: true, blocked_reason: 'soft-deleted' }],
    ['a bot with an empty pepper', { is_bot: true, api_token_pepper: '' }],
  ])('refuses to adopt %s that holds the internal bot id', async (_label, overrides) => {
    const org = await newOrganization();
    const slug = `t-${randomUUID().slice(0, 8)}`;
    await insertTestUser({ id: `bot-internal-${slug}`, ...overrides });

    await expect(
      ensureInternalBotUser({ slug, displayName: 'Test Bot', organizationId: org.id })
    ).rejects.toBeInstanceOf(InternalBotUnusableError);
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
