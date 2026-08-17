import { afterEach, describe, expect, it } from '@jest/globals';
import {
  kilocode_users,
  organization_group_policy_settings,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { createAllowPredicateFromRestrictions } from '@/lib/model-allow.server';
import {
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
} from '@/lib/organizations/effective-model-access.server';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';

/**
 * Deployment guard for organizations that predate groups: legacy model/provider
 * restrictions live in `organizations.settings`, no group exists, and no
 * `organization_group_policy_settings` row has ever been written.
 *
 * Group policy evaluation replaced `createAllowPredicateFromRestrictions` on
 * every read path, so these cases assert the new evaluator returns exactly what
 * the pre-groups predicate returned for the same organization.
 */
const MODEL_PROVIDER_ROUTES: Record<string, string[]> = {
  'denied/model': ['openai'],
  'allowed/model': ['openai'],
  'blocked-provider/model': ['anthropic'],
  'unknown-routes/model': [],
};

const providerLookup = async (modelId: string) => new Set(MODEL_PROVIDER_ROUTES[modelId] ?? []);

const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

async function seedLegacyOrganization(
  name: string,
  settings: Record<string, unknown>,
  requireSeats = false
) {
  const owner = await insertTestUser();
  createdUserIds.push(owner.id);
  const organization = await createTestOrganization(
    name,
    owner.id,
    1_000_000,
    settings,
    requireSeats
  );
  createdOrganizationIds.push(organization.id);
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organization.id))
    .limit(1);
  return { owner, organization: row };
}

/** Compare the new evaluator against the legacy predicate for every fixture model. */
async function expectParityWithLegacyPredicate(
  organizationRow: typeof organizations.$inferSelect,
  ownerId: string
) {
  const legacyIsAllowed = createAllowPredicateFromRestrictions(
    getEffectiveModelRestrictions(organizationRow),
    providerLookup
  );
  const policy = await resolveOrganizationMemberModelPolicy({
    organizationId: organizationRow.id,
    kiloUserId: ownerId,
  });

  const legacy: Record<string, boolean> = {};
  const current: Record<string, boolean> = {};
  for (const modelId of Object.keys(MODEL_PROVIDER_ROUTES)) {
    legacy[modelId] = await legacyIsAllowed(modelId);
    current[modelId] = (await getEffectiveModelDecision(policy, modelId, providerLookup)).allowed;
  }
  expect(current).toEqual(legacy);
  return { policy, legacy };
}

describe('legacy organization restrictions with no groups or policies', () => {
  afterEach(async () => {
    for (const organizationId of createdOrganizationIds.splice(0)) {
      await db
        .delete(organization_group_policy_settings)
        .where(eq(organization_group_policy_settings.organization_id, organizationId));
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
    for (const userId of createdUserIds.splice(0)) {
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  });

  it('matches the pre-groups predicate for a deny list plus provider allow list', async () => {
    const { owner, organization } = await seedLegacyOrganization('Legacy Enterprise Both', {
      model_deny_list: ['denied/model'],
      provider_allow_list: ['openai'],
    });

    const [existingSettings] = await db
      .select()
      .from(organization_group_policy_settings)
      .where(eq(organization_group_policy_settings.organization_id, organization.id))
      .limit(1);
    expect(existingSettings).toBeUndefined();

    const { policy, legacy } = await expectParityWithLegacyPredicate(organization, owner.id);

    // Sanity-check the fixture actually exercises both restriction kinds rather
    // than trivially allowing everything.
    expect(legacy).toEqual({
      'denied/model': false,
      'allowed/model': true,
      'blocked-provider/model': false,
      'unknown-routes/model': false,
    });

    // Reading policy must not materialize a settings row or invent a revision.
    expect(policy.policyRevision).toBe(0);
    const [afterSettings] = await db
      .select()
      .from(organization_group_policy_settings)
      .where(eq(organization_group_policy_settings.organization_id, organization.id))
      .limit(1);
    expect(afterSettings).toBeUndefined();
  });

  it('matches the pre-groups predicate for a deny list only', async () => {
    const { owner, organization } = await seedLegacyOrganization('Legacy Enterprise Deny', {
      model_deny_list: ['denied/model'],
    });
    const { legacy } = await expectParityWithLegacyPredicate(organization, owner.id);
    expect(legacy['denied/model']).toBe(false);
    expect(legacy['blocked-provider/model']).toBe(true);
    expect(legacy['unknown-routes/model']).toBe(false);
  });

  it('matches the pre-groups predicate for a provider allow list only', async () => {
    const { owner, organization } = await seedLegacyOrganization('Legacy Enterprise Providers', {
      provider_allow_list: ['openai'],
    });
    const { legacy } = await expectParityWithLegacyPredicate(organization, owner.id);
    expect(legacy['allowed/model']).toBe(true);
    expect(legacy['blocked-provider/model']).toBe(false);
  });

  it('requires snapshot membership for Enterprise without configured restrictions', async () => {
    const { owner, organization } = await seedLegacyOrganization(
      'Legacy Enterprise Snapshot Only',
      {}
    );

    const { legacy } = await expectParityWithLegacyPredicate(organization, owner.id);
    expect(legacy).toEqual({
      'denied/model': true,
      'allowed/model': true,
      'blocked-provider/model': true,
      'unknown-routes/model': false,
    });
  });

  it('keeps stored restrictions unenforced on Teams, as before', async () => {
    const { owner, organization } = await seedLegacyOrganization(
      'Legacy Teams',
      { model_deny_list: ['denied/model'], provider_allow_list: ['openai'] },
      true
    );
    expect(organization.plan).toBe('teams');

    const { legacy } = await expectParityWithLegacyPredicate(organization, owner.id);
    expect(legacy).toEqual({
      'denied/model': true,
      'allowed/model': true,
      'blocked-provider/model': true,
      'unknown-routes/model': true,
    });
  });
});
