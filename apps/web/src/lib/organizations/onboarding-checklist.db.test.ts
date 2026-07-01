import { afterAll, describe, expect, it } from '@jest/globals';
import {
  agent_configs,
  organization_invitations,
  organization_memberships,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { getOrganizationOnboardingState } from './onboarding-checklist';

const createdOrganizationIds: string[] = [];

async function createFixtureOrganization() {
  const owner = await insertTestUser();
  const organization = await createOrganization(`Onboarding ${crypto.randomUUID()}`, owner.id);
  createdOrganizationIds.push(organization.id);
  return { owner, organization };
}

describe('getOrganizationOnboardingState', () => {
  afterAll(async () => {
    for (const organizationId of createdOrganizationIds) {
      await db
        .delete(organization_invitations)
        .where(eq(organization_invitations.organization_id, organizationId));
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
  });

  it('accepts an active, healthy GitHub integration', async () => {
    const { organization } = await createFixtureOrganization();
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: crypto.randomUUID(),
      integration_status: 'active',
      repository_access: 'all',
    });

    const state = await getOrganizationOnboardingState(organization.id);
    expect(state.sourceControlConnected).toBe(true);
    expect(state.connectedPlatform).toBe('github');
  });

  it('does not treat GitLab as guided source control completion', async () => {
    const { organization } = await createFixtureOrganization();
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organization.id,
      platform: 'gitlab',
      integration_type: 'oauth',
      platform_installation_id: crypto.randomUUID(),
      integration_status: 'active',
      repository_access: 'all',
    });

    const state = await getOrganizationOnboardingState(organization.id);
    expect(state.sourceControlConnected).toBe(false);
    expect(state.connectedPlatform).toBeNull();
  });

  it('detects enabled GitHub Code Reviewer configuration', async () => {
    const { owner, organization } = await createFixtureOrganization();
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: crypto.randomUUID(),
      integration_status: 'active',
      repository_access: 'all',
    });
    await db.insert(agent_configs).values({
      owned_by_organization_id: organization.id,
      agent_type: 'code_review',
      platform: 'github',
      is_enabled: true,
      created_by: owner.id,
      config: {},
    });

    expect((await getOrganizationOnboardingState(organization.id)).codeReviewerEnabled).toBe(true);
  });

  it('ignores an enabled Code Reviewer config for a different platform', async () => {
    const { owner, organization } = await createFixtureOrganization();
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: crypto.randomUUID(),
      integration_status: 'active',
      repository_access: 'all',
    });
    await db.insert(agent_configs).values({
      owned_by_organization_id: organization.id,
      agent_type: 'code_review',
      platform: 'gitlab',
      is_enabled: true,
      created_by: owner.id,
      config: {},
    });

    const state = await getOrganizationOnboardingState(organization.id);
    expect(state.connectedPlatform).toBe('github');
    expect(state.codeReviewerEnabled).toBe(false);
  });

  it.each(['member', 'owner', 'billing_manager'] as const)(
    'counts an additional human %s as team setup',
    async role => {
      const { organization } = await createFixtureOrganization();
      const teammate = await insertTestUser();
      await addUserToOrganization(organization.id, teammate.id, role);

      expect((await getOrganizationOnboardingState(organization.id)).teamInvited).toBe(true);
    }
  );

  it('does not count bot memberships', async () => {
    const { organization } = await createFixtureOrganization();
    const bot = await insertTestUser({ is_bot: true });
    await addUserToOrganization(organization.id, bot.id, 'member');

    expect((await getOrganizationOnboardingState(organization.id)).teamInvited).toBe(false);
  });

  it.each(['member', 'owner', 'billing_manager'] as const)(
    'counts a pending %s invitation',
    async role => {
      const { owner, organization } = await createFixtureOrganization();
      await db.insert(organization_invitations).values({
        organization_id: organization.id,
        email: `${crypto.randomUUID()}@example.com`,
        role,
        invited_by: owner.id,
        token: crypto.randomUUID(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });

      expect((await getOrganizationOnboardingState(organization.id)).teamInvited).toBe(true);
    }
  );

  it('ignores expired and accepted invitations', async () => {
    const { owner, organization } = await createFixtureOrganization();
    await db.insert(organization_invitations).values([
      {
        organization_id: organization.id,
        email: `${crypto.randomUUID()}@example.com`,
        role: 'member',
        invited_by: owner.id,
        token: crypto.randomUUID(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        organization_id: organization.id,
        email: `${crypto.randomUUID()}@example.com`,
        role: 'owner',
        invited_by: owner.id,
        token: crypto.randomUUID(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        accepted_at: new Date().toISOString(),
      },
    ]);

    expect((await getOrganizationOnboardingState(organization.id)).teamInvited).toBe(false);
  });

  it('requires two humans when the creator is unknown', async () => {
    const organization = await createOrganization(`Onboarding ${crypto.randomUUID()}`, null, false);
    createdOrganizationIds.push(organization.id);
    const first = await insertTestUser();
    const second = await insertTestUser();
    await addUserToOrganization(organization.id, first.id, 'owner');

    expect((await getOrganizationOnboardingState(organization.id)).teamInvited).toBe(false);

    await addUserToOrganization(organization.id, second.id, 'billing_manager');
    expect((await getOrganizationOnboardingState(organization.id)).teamInvited).toBe(true);
  });

  it('returns not found for soft-deleted organizations', async () => {
    const { organization } = await createFixtureOrganization();
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));

    await expect(getOrganizationOnboardingState(organization.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
