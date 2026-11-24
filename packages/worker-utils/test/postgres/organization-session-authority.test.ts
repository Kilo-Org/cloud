import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { signModernKiloToken } from '../../src/kilo-token-policy';
import { hasEffectiveOrganizationAccess } from '../../src/organization-membership';
import { createRuntimeAuthorization } from '../../src/runtime-authorization';

const secret = 'organization-session-authority-test-secret';

let client: DrizzleClient;
let parentOrganizationId: string;
let childOrganizationId: string;

const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The organization session authority tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  parentOrganizationId = await insertOrganization(null);
  childOrganizationId = await insertOrganization(parentOrganizationId);
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
async function insertUser(pepper: string): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const id = `oauth/organization-session-${suffix}`;
  await client.db.execute(sql`
    INSERT INTO kilocode_users (
      id, google_user_email, google_user_name, google_user_image_url, stripe_customer_id, api_token_pepper
    ) VALUES (
      ${id},
      ${`organization-session-${suffix}@example.test`},
      'Organization Session Authority Test',
      'https://example.test/avatar.png',
      ${`cus_test_${suffix}`},
      ${pepper}
    )
  `);
  createdUserIds.push(id);
  return id;
}

async function insertOrganization(parentId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await client.db.execute(sql`
    INSERT INTO organizations (id, name, parent_organization_id)
    VALUES (${id}, ${`Org Session Authority ${id}`}, ${parentId})
  `);
  createdOrganizationIds.push(id);
  return id;
}

async function insertMembership(
  organizationId: string,
  kiloUserId: string,
  role: string
): Promise<string> {
  const rows = await client.db.execute<{ id: string }>(sql`
    INSERT INTO organization_memberships (organization_id, kilo_user_id, role)
    VALUES (${organizationId}, ${kiloUserId}, ${role})
    RETURNING id
  `);
  const id = rows.rows[0]?.id;
  if (!id) throw new Error('The membership insert returned no row');
  return id;
}

/** Mint a human-api admission credential for the user and the organization. */
async function mintToken(options: {
  userId: string;
  pepper: string;
  organizationId: string;
}): Promise<string> {
  const { token } = await signModernKiloToken({
    userId: options.userId,
    pepper: options.pepper,
    secret,
    expiresInSeconds: 300,
    audience: 'cloud-agent-next',
    tokenPurpose: 'human-api',
    credentialExchange: false,
    env: 'production',
    extra: {
      organizationId: options.organizationId,
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: options.userId,
        authorizationPepper: options.pepper,
      },
    },
  });
  return token;
}

/** Create a runtime delegation from an admission credential for one organization. */
function delegate(token: string, organizationId: string) {
  return createRuntimeAuthorization({
    token,
    verificationSecret: secret,
    signingSecret: secret,
    connectionString: process.env.POSTGRES_URL!,
    resourceKind: 'cloud-agent-next',
    resourceId: 'session',
    environment: 'production',
    organizationId,
  });
}

async function expectReadAccess(kiloUserId: string, expected: boolean): Promise<void> {
  await expect(
    hasEffectiveOrganizationAccess(client.db, {
      kiloUserId,
      organizationId: childOrganizationId,
    })
  ).resolves.toBe(expected);
}

describe('organization session authority', () => {
  describe('direct membership roles that read and delegate', () => {
    it('a direct owner reads and receives a runtime delegation', async () => {
      const pepper = `pepper-${crypto.randomUUID()}`;
      const userId = await insertUser(pepper);
      const membershipId = await insertMembership(childOrganizationId, userId, 'owner');

      await expectReadAccess(userId, true);

      const created = await delegate(
        await mintToken({ userId, pepper, organizationId: childOrganizationId }),
        childOrganizationId
      );
      expect(created.authorization.bindings).toMatchObject({
        userMembershipId: membershipId,
        authorizationUserMembershipId: membershipId,
      });
    });

    it('a direct admin reads and receives a runtime delegation', async () => {
      const pepper = `pepper-${crypto.randomUUID()}`;
      const userId = await insertUser(pepper);
      const membershipId = await insertMembership(childOrganizationId, userId, 'admin');

      await expectReadAccess(userId, true);

      const created = await delegate(
        await mintToken({ userId, pepper, organizationId: childOrganizationId }),
        childOrganizationId
      );
      expect(created.authorization.bindings).toMatchObject({
        userMembershipId: membershipId,
        authorizationUserMembershipId: membershipId,
      });
    });

    it('a direct member reads and receives a runtime delegation', async () => {
      const pepper = `pepper-${crypto.randomUUID()}`;
      const userId = await insertUser(pepper);
      const membershipId = await insertMembership(childOrganizationId, userId, 'member');

      await expectReadAccess(userId, true);

      const created = await delegate(
        await mintToken({ userId, pepper, organizationId: childOrganizationId }),
        childOrganizationId
      );
      expect(created.authorization.bindings).toMatchObject({
        userMembershipId: membershipId,
        authorizationUserMembershipId: membershipId,
      });
    });
  });

  describe('direct membership roles that read only', () => {
    it('a direct billing manager reads while runtime delegation refuses', async () => {
      const pepper = `pepper-${crypto.randomUUID()}`;
      const userId = await insertUser(pepper);
      await insertMembership(childOrganizationId, userId, 'billing_manager');

      await expectReadAccess(userId, true);

      await expect(
        delegate(
          await mintToken({ userId, pepper, organizationId: childOrganizationId }),
          childOrganizationId
        )
      ).rejects.toThrow('Invalid runtime admission');
    });
  });

  describe('inherited parent roles that read only', () => {
    it('an inherited parent owner reads while runtime delegation refuses', async () => {
      const pepper = `pepper-${crypto.randomUUID()}`;
      const userId = await insertUser(pepper);
      await insertMembership(parentOrganizationId, userId, 'owner');

      await expectReadAccess(userId, true);

      await expect(
        delegate(
          await mintToken({ userId, pepper, organizationId: childOrganizationId }),
          childOrganizationId
        )
      ).rejects.toThrow('Invalid runtime admission');
    });

    it('an inherited parent billing manager reads while runtime delegation refuses', async () => {
      const pepper = `pepper-${crypto.randomUUID()}`;
      const userId = await insertUser(pepper);
      await insertMembership(parentOrganizationId, userId, 'billing_manager');

      await expectReadAccess(userId, true);

      await expect(
        delegate(
          await mintToken({ userId, pepper, organizationId: childOrganizationId }),
          childOrganizationId
        )
      ).rejects.toThrow('Invalid runtime admission');
    });

    it('a parent member neither reads nor delegates', async () => {
      const pepper = `pepper-${crypto.randomUUID()}`;
      const userId = await insertUser(pepper);
      await insertMembership(parentOrganizationId, userId, 'member');

      await expectReadAccess(userId, false);

      await expect(
        delegate(
          await mintToken({ userId, pepper, organizationId: childOrganizationId }),
          childOrganizationId
        )
      ).rejects.toThrow('Invalid runtime admission');
    });
  });
});
