import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  type OrganizationRole,
} from '@kilocode/db/schema';
import {
  findEffectiveOrganizationMemberRole,
  hasEffectiveOrganizationAccess,
} from '../../src/organization-membership';

let client: DrizzleClient;

const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The organization membership tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
});

afterAll(async () => {
  if (!client) return;
  if (createdOrganizationIds.length > 0) {
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
  const id = `oauth/org-membership-${suffix}`;
  await client.db.execute(sql`
    INSERT INTO kilocode_users (
      id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id
    ) VALUES (
      ${id},
      ${`org-membership-${suffix}@example.test`},
      'Org Membership Test',
      'https://example.test/avatar.png',
      ${`cus_test_${suffix}`}
    )
  `);
  createdUserIds.push(id);
  return id;
}

async function insertOrganization(parentOrganizationId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await client.db.execute(sql`
    INSERT INTO organizations (id, name, parent_organization_id)
    VALUES (${id}, ${`Org Membership ${id}`}, ${parentOrganizationId})
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

async function softDeleteOrganization(organizationId: string): Promise<void> {
  await client.db.execute(sql`
    UPDATE organizations SET deleted_at = now() WHERE id = ${organizationId}
  `);
}

/**
 * Reads the role and checks that the boolean helper reports the same answer, so
 * both entry points apply one rule.
 */
async function expectEffectiveRole(
  params: { kiloUserId: string; organizationId: string },
  role: OrganizationRole | null
): Promise<void> {
  await expect(findEffectiveOrganizationMemberRole(client.db, params)).resolves.toBe(role);
  await expect(hasEffectiveOrganizationAccess(client.db, params)).resolves.toBe(role !== null);
}

describe('findEffectiveOrganizationMemberRole', () => {
  it('returns the direct role for a direct member', async () => {
    const kiloUserId = await insertUser();
    const organizationId = await insertOrganization();
    await insertMembership(organizationId, kiloUserId, 'member');

    await expectEffectiveRole({ kiloUserId, organizationId }, 'member');
  });

  it.each(['owner', 'admin'] as const)(
    'returns the parent role %s for a child organization',
    async role => {
      const kiloUserId = await insertUser();
      const parentOrganizationId = await insertOrganization();
      const childOrganizationId = await insertOrganization(parentOrganizationId);
      await insertMembership(parentOrganizationId, kiloUserId, role);

      await expectEffectiveRole({ kiloUserId, organizationId: childOrganizationId }, role);
    }
  );

  it('returns null for a parent role that cannot inherit', async () => {
    const kiloUserId = await insertUser();
    const parentOrganizationId = await insertOrganization();
    const childOrganizationId = await insertOrganization(parentOrganizationId);
    await insertMembership(parentOrganizationId, kiloUserId, 'member');

    await expectEffectiveRole({ kiloUserId, organizationId: childOrganizationId }, null);
  });

  it('returns null when the parent organization is soft-deleted', async () => {
    const kiloUserId = await insertUser();
    const parentOrganizationId = await insertOrganization();
    const childOrganizationId = await insertOrganization(parentOrganizationId);
    await insertMembership(parentOrganizationId, kiloUserId, 'owner');
    await softDeleteOrganization(parentOrganizationId);

    await expectEffectiveRole({ kiloUserId, organizationId: childOrganizationId }, null);
  });

  it('returns null when the target organization is soft-deleted', async () => {
    const kiloUserId = await insertUser();
    const organizationId = await insertOrganization();
    await insertMembership(organizationId, kiloUserId, 'owner');
    await softDeleteOrganization(organizationId);

    await expectEffectiveRole({ kiloUserId, organizationId }, null);
  });

  it('returns null for a user who has no membership', async () => {
    const kiloUserId = await insertUser();
    const organizationId = await insertOrganization();

    await expectEffectiveRole({ kiloUserId, organizationId }, null);
  });
});
