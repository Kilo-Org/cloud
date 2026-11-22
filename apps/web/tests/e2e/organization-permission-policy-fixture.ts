import { test } from '@chromatic-com/playwright';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import {
  ai_gateway_config,
  kilocode_users,
  organization_audit_logs,
  organization_default_policy_links,
  organization_group_memberships,
  organization_group_policy_links,
  organization_group_policy_settings,
  organization_groups,
  organization_memberships,
  organization_named_policies,
  organizations,
} from '@kilocode/db/schema';
import { hosted_domain_specials } from '@kilocode/web-shared/lib/auth/constants';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

function loopbackUrl(value: string | undefined, protocols: readonly string[]) {
  const url = URL.parse(value ?? '');
  return (
    url &&
    protocols.includes(url.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  );
}

function newUser(role: 'owner' | 'admin' | 'member', name: string) {
  const id = `e2e-permission-policy-${role}-${randomUUID()}`;
  return { id, email: `${id}+stytchpass@example.com`, name, role };
}

function permissionPolicyFixture(db: DrizzleClient['db']) {
  const owner = newUser('owner', 'Trial owner');
  const admin = newUser('admin', 'Trial administrator');
  const member = newUser('member', 'Trial engineer');
  const ungroupedMember = newUser('member', 'Trial analyst');
  const managed = { id: randomUUID(), name: 'Managed policy trial' };
  const disabled = { id: randomUUID(), name: 'Disabled policy trial' };
  const group = { id: randomUUID(), name: 'Platform Engineering' };
  const neutralGroup = { id: randomUUID(), name: 'Release Engineering' };
  const disabledGroup = { id: randomUUID(), name: 'Control Engineering' };
  const organizationIds = [managed.id, disabled.id];
  const users = [owner, admin, member, ungroupedMember];
  const features = sql`coalesce(${ai_gateway_config.config}->'organization_features', '{}'::jsonb)`;
  const allowlist = sql`coalesce(${features}->'org_permission_policy', '[]'::jsonb)`;

  return {
    admin,
    member,
    ungroupedMember,
    managed,
    disabled,
    group,
    neutralGroup,
    disabledGroup,
    async seed() {
      await db.transaction(async tx => {
        await tx.insert(kilocode_users).values(
          users.map(user => ({
            id: user.id,
            google_user_name: user.name,
            google_user_email: user.email,
            google_user_image_url: '',
            hosted_domain: hosted_domain_specials.fake_devonly,
            stripe_customer_id: `cus_${user.id}`,
            completed_welcome_form: true,
            customer_source: 'Playwright',
            has_validation_stytch: true,
          }))
        );
        await tx.insert(organizations).values(
          [managed, disabled].map<typeof organizations.$inferInsert>(organization => ({
            ...organization,
            created_by_kilo_user_id: owner.id,
            free_trial_end_at: new Date(Date.now() + 86_400_000).toISOString(),
            plan: 'enterprise',
            require_seats: false,
          }))
        );
        await tx
          .insert(organization_memberships)
          .values(
            organizationIds.flatMap(organization_id =>
              users.map(user => ({ organization_id, kilo_user_id: user.id, role: user.role }))
            )
          );
        await tx.insert(organization_groups).values([
          { ...group, organization_id: managed.id },
          { ...neutralGroup, organization_id: managed.id },
          { ...disabledGroup, organization_id: disabled.id },
        ]);
        await tx.insert(organization_group_memberships).values(
          [group, neutralGroup].map(({ id }) => ({
            group_id: id,
            organization_id: managed.id,
            kilo_user_id: member.id,
          }))
        );
        await tx.insert(ai_gateway_config).values({}).onConflictDoNothing();
        await tx
          .update(ai_gateway_config)
          .set({
            config: sql`jsonb_set(${ai_gateway_config.config}, '{organization_features}',
              jsonb_set(${features}, '{org_permission_policy}', ${allowlist} || jsonb_build_array(${managed.id}::text)))`,
          })
          .where(eq(ai_gateway_config.id, 1));
      });
    },
    async readNamedPolicies() {
      const [policies, defaultLinks, groupLinks] = await Promise.all([
        db
          .select()
          .from(organization_named_policies)
          .where(eq(organization_named_policies.organization_id, managed.id))
          .orderBy(asc(organization_named_policies.name), asc(organization_named_policies.id)),
        db
          .select()
          .from(organization_default_policy_links)
          .where(eq(organization_default_policy_links.organization_id, managed.id)),
        db
          .select()
          .from(organization_group_policy_links)
          .where(eq(organization_group_policy_links.organization_id, managed.id))
          .orderBy(asc(organization_group_policy_links.group_id)),
      ]);
      return policies.map(policy => ({
        ...policy,
        attachments: [
          ...defaultLinks
            .filter(link => link.policy_id === policy.id)
            .map(() => ({ type: 'default' as const })),
          ...groupLinks
            .filter(link => link.policy_id === policy.id)
            .map(link => ({ type: 'group' as const, groupId: link.group_id })),
        ],
      }));
    },
    async readRevision() {
      const [settings] = await db
        .select({ revision: organization_group_policy_settings.policy_revision })
        .from(organization_group_policy_settings)
        .where(eq(organization_group_policy_settings.organization_id, managed.id));
      return settings?.revision ?? 0;
    },
    async cleanup() {
      await db.transaction(async tx => {
        await tx
          .update(ai_gateway_config)
          .set({
            config: sql`jsonb_set(${ai_gateway_config.config}, '{organization_features,org_permission_policy}',
              ${allowlist} - ${managed.id}::text, false)`,
          })
          .where(eq(ai_gateway_config.id, 1));
        await tx
          .delete(organization_group_policy_links)
          .where(inArray(organization_group_policy_links.organization_id, organizationIds));
        await tx
          .delete(organization_default_policy_links)
          .where(inArray(organization_default_policy_links.organization_id, organizationIds));
        await tx
          .delete(organization_named_policies)
          .where(inArray(organization_named_policies.organization_id, organizationIds));
        await tx
          .delete(organization_audit_logs)
          .where(inArray(organization_audit_logs.organization_id, organizationIds));
        await tx
          .delete(organization_memberships)
          .where(inArray(organization_memberships.organization_id, organizationIds));
        await tx.delete(organizations).where(inArray(organizations.id, organizationIds));
        await tx.delete(kilocode_users).where(
          inArray(
            kilocode_users.id,
            users.map(user => user.id)
          )
        );
      });
    },
  };
}

export const permissionPolicyTest = test.extend<{
  permissionFixture: ReturnType<typeof permissionPolicyFixture>;
}>({
  permissionFixture: async ({ baseURL }, use) => {
    const connectionString = process.env.POSTGRES_URL;
    if (
      !connectionString ||
      !loopbackUrl(connectionString, ['postgres:', 'postgresql:']) ||
      !loopbackUrl(baseURL, ['http:', 'https:']) ||
      process.env.USE_PRODUCTION_DB === 'true' ||
      process.env.NODE_ENV === 'production' ||
      process.env.SKIP_STRIPE_API !== 'true'
    ) {
      throw new Error(
        'Permission policy E2E requires a disposable loopback web server and database with SKIP_STRIPE_API=true'
      );
    }

    const { db, pool } = createDrizzleClient({
      connectionString,
      poolConfig: { max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 },
    });
    try {
      const fixture = permissionPolicyFixture(db);
      await fixture.seed();
      try {
        await use(fixture);
      } finally {
        await fixture.cleanup();
      }
    } finally {
      await pool.end();
    }
  },
});
