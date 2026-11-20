import { inArray, sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import {
  kilocode_users,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
} from '@kilocode/db/schema';
import {
  findOrganizationMemberBalanceRow,
  findOrganizationMemberBalanceRowWithPayerFamily,
  organizationMemberBalance,
} from '../../src/account-access';

let client: DrizzleClient;

const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The account access tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
});

afterAll(async () => {
  if (!client) return;
  if (createdOrganizationIds.length > 0) {
    await client.db
      .delete(organization_user_usage)
      .where(inArray(organization_user_usage.organization_id, createdOrganizationIds));
    await client.db
      .delete(organization_user_limits)
      .where(inArray(organization_user_limits.organization_id, createdOrganizationIds));
    await client.db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, createdOrganizationIds));
    // Child rows must go before their parents: the parent reference restricts deletes.
    await client.db
      .delete(organizations)
      .where(inArray(organizations.parent_organization_id, createdOrganizationIds));
    await client.db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
  }
  if (createdUserIds.length > 0) {
    await client.db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
  }
  await client.pool.end();
});

/** Minimal kilocode_users row: the columns without defaults the table requires. */
async function insertUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const id = `oauth/account-access-${suffix}`;
  await client.db.execute(sql`
    INSERT INTO kilocode_users (
      id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id
    ) VALUES (
      ${id},
      ${`account-access-${suffix}@example.test`},
      'Account Access Test',
      'https://example.test/avatar.png',
      ${`cus_test_${suffix}`}
    )
  `);
  createdUserIds.push(id);
  return id;
}

async function insertOrganization(options: {
  acquired: number;
  used: number;
  parentOrganizationId?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await client.db.execute(sql`
    INSERT INTO organizations (
      id, name, parent_organization_id, total_microdollars_acquired, microdollars_used,
      require_seats
    ) VALUES (
      ${id},
      ${`Account Access ${id}`},
      ${options.parentOrganizationId ?? null},
      ${options.acquired},
      ${options.used},
      false
    )
  `);
  createdOrganizationIds.push(id);
  return id;
}

async function insertMembership(
  organizationId: string,
  kiloUserId: string,
  role: string
): Promise<void> {
  await client.db.execute(sql`
    INSERT INTO organization_memberships (organization_id, kilo_user_id, role)
    VALUES (${organizationId}, ${kiloUserId}, ${role})
  `);
}

async function insertUsage(
  organizationId: string,
  kiloUserId: string,
  usageDate: SQL,
  microdollars: number
): Promise<void> {
  await client.db.execute(sql`
    INSERT INTO organization_user_usage (
      organization_id, kilo_user_id, usage_date, limit_type, microdollar_usage
    ) VALUES (${organizationId}, ${kiloUserId}, ${usageDate}, 'daily', ${microdollars})
  `);
}

describe('organization member balance rows', () => {
  it('reads the same member balance with and without the payer family', async () => {
    const parentId = await insertOrganization({ acquired: 50_000_000, used: 10_000_000 });
    const childId = await insertOrganization({
      acquired: 8_000_000,
      used: 1_000_000,
      parentOrganizationId: parentId,
    });
    await insertOrganization({
      acquired: 4_000_000,
      used: 3_000_000,
      parentOrganizationId: parentId,
    });
    const userId = await insertUser();
    await insertMembership(childId, userId, 'member');
    await client.db.execute(sql`
      INSERT INTO organization_user_limits (organization_id, kilo_user_id, limit_type, microdollar_limit)
      VALUES (${childId}, ${userId}, 'daily', ${2_000_000})
    `);
    await insertUsage(childId, userId, sql`CURRENT_DATE`, 500_000);
    // Yesterday's usage does not count against today's allowance.
    await insertUsage(childId, userId, sql`CURRENT_DATE - 1`, 1_900_000);

    const lean = await findOrganizationMemberBalanceRow(client.db, childId, userId);
    const full = await findOrganizationMemberBalanceRowWithPayerFamily(client.db, childId, userId);

    expect(lean).toMatchObject({
      total_microdollars_acquired: 8_000_000,
      microdollars_used: 1_000_000,
      microdollar_limit: 2_000_000,
      microdollar_usage: 500_000,
    });
    expect(lean).not.toHaveProperty('payerRootOrganizationId');
    expect(full).toEqual({
      ...lean,
      payerRootOrganizationId: parentId,
      payerRootCreatedAt: expect.any(String),
      payerMicrodollarsUsed: 14_000_000,
      payerTotalMicrodollarsAcquired: 62_000_000,
    });
    expect(organizationMemberBalance(lean!)).toEqual(organizationMemberBalance(full!));
    expect(organizationMemberBalance(lean!)).toEqual({
      balanceMicrodollars: 1_500_000,
      limitedByUserAllowance: false,
    });
  });

  it('reads an unlimited member of a root organization', async () => {
    const organizationId = await insertOrganization({ acquired: 3_000_000, used: 1_000_000 });
    const userId = await insertUser();
    await insertMembership(organizationId, userId, 'owner');

    const lean = await findOrganizationMemberBalanceRow(client.db, organizationId, userId);
    const full = await findOrganizationMemberBalanceRowWithPayerFamily(
      client.db,
      organizationId,
      userId
    );

    expect(lean).toMatchObject({ microdollar_limit: null, microdollar_usage: null });
    expect(full).toMatchObject({
      ...lean,
      payerRootOrganizationId: organizationId,
      payerMicrodollarsUsed: 1_000_000,
      payerTotalMicrodollarsAcquired: 3_000_000,
    });
  });

  it('finds no balance for a billing manager, a non-member, or a deleted organization', async () => {
    const organizationId = await insertOrganization({ acquired: 3_000_000, used: 0 });
    const billingManagerId = await insertUser();
    const outsiderId = await insertUser();
    const memberId = await insertUser();
    await insertMembership(organizationId, billingManagerId, 'billing_manager');
    await insertMembership(organizationId, memberId, 'member');

    for (const find of [
      findOrganizationMemberBalanceRow,
      findOrganizationMemberBalanceRowWithPayerFamily,
    ]) {
      await expect(find(client.db, organizationId, billingManagerId)).resolves.toBeNull();
      await expect(find(client.db, organizationId, outsiderId)).resolves.toBeNull();
      await expect(find(client.db, organizationId, memberId)).resolves.not.toBeNull();
    }

    await client.db.execute(
      sql`UPDATE organizations SET deleted_at = now() WHERE id = ${organizationId}`
    );
    await expect(
      findOrganizationMemberBalanceRow(client.db, organizationId, memberId)
    ).resolves.toBeNull();
    await expect(
      findOrganizationMemberBalanceRowWithPayerFamily(client.db, organizationId, memberId)
    ).resolves.toBeNull();
  });
});
