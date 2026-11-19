jest.mock('./api', () => ({
  createAnthropicUserProfile: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/operator', () => ({
  isClaudeOperatorConfigured: jest.fn(() => true),
}));

import { beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createAnthropicUserProfile } from './api';
import { ensureAnthropicUserProfile } from './ensure';

async function organizationProfile(organizationId: string) {
  const [row] = await db
    .select({ id: organizations.anthropic_user_profile_id })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.id;
}

describe('ensureAnthropicUserProfile', () => {
  beforeEach(() => {
    let next = 0;
    jest
      .mocked(createAnthropicUserProfile)
      .mockReset()
      .mockImplementation(async () => `uprof_${++next}_${randomUUID()}`);
  });

  it('creates and stores a passthrough profile for a user once', async () => {
    const user = await insertTestUser();
    const first = await ensureAnthropicUserProfile({ kind: 'user', userId: user.id }, 'DE');
    const second = await ensureAnthropicUserProfile({ kind: 'user', userId: user.id });
    expect(first).toMatch(/^uprof_/);
    expect(second).toBe(first);
    expect(createAnthropicUserProfile).toHaveBeenCalledTimes(1);
    expect(createAnthropicUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'user', userId: user.id, country: 'DE' })
    );
  });

  it('keeps the profile another request stored first', async () => {
    const user = await insertTestUser();
    jest.mocked(createAnthropicUserProfile).mockImplementationOnce(async () => {
      // Another instance stores its profile while this one is creating.
      await db
        .update(kilocode_users)
        .set({ anthropic_user_profile_id: 'uprof_winner' })
        .where(eq(kilocode_users.id, user.id));
      return 'uprof_loser';
    });
    expect(await ensureAnthropicUserProfile({ kind: 'user', userId: user.id })).toBe(
      'uprof_winner'
    );
  });

  it('shares one in-flight creation between concurrent calls', async () => {
    const user = await insertTestUser();
    const results = await Promise.all([
      ensureAnthropicUserProfile({ kind: 'user', userId: user.id }),
      ensureAnthropicUserProfile({ kind: 'user', userId: user.id }),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(createAnthropicUserProfile).toHaveBeenCalledTimes(1);
  });

  it('does not reattach a profile when the user is soft-deleted during the create', async () => {
    const user = await insertTestUser();
    jest.mocked(createAnthropicUserProfile).mockImplementationOnce(async () => {
      await db
        .update(kilocode_users)
        .set({
          blocked_reason: 'soft-deleted at 2026-11-19T00:00:00.000Z',
          anthropic_user_profile_id: null,
        })
        .where(eq(kilocode_users.id, user.id));
      return 'uprof_late';
    });
    expect(await ensureAnthropicUserProfile({ kind: 'user', userId: user.id })).toBeNull();
    const [row] = await db
      .select({ id: kilocode_users.anthropic_user_profile_id })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row?.id).toBeNull();
  });

  it('does not give an organization attached to a parent during the create its own profile', async () => {
    const organization = await createOrganization(`Root ${randomUUID()}`);
    const parent = await createOrganization(`New parent ${randomUUID()}`);
    jest.mocked(createAnthropicUserProfile).mockImplementationOnce(async () => {
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, organization.id));
      return 'uprof_standalone';
    });
    expect(
      await ensureAnthropicUserProfile({
        kind: 'organization',
        organizationId: organization.id,
        rootOrganizationId: organization.id,
      })
    ).toBeNull();
    expect(await organizationProfile(organization.id)).toBeNull();
  });

  it('does not reattach a profile when the organization is deleted during the create', async () => {
    const organization = await createOrganization(`Deleted ${randomUUID()}`);
    jest.mocked(createAnthropicUserProfile).mockImplementationOnce(async () => {
      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, organization.id));
      return 'uprof_late';
    });
    expect(
      await ensureAnthropicUserProfile({
        kind: 'organization',
        organizationId: organization.id,
        rootOrganizationId: organization.id,
      })
    ).toBeNull();
    expect(await organizationProfile(organization.id)).toBeNull();
  });

  it('creates nothing for a blocked user', async () => {
    const user = await insertTestUser({
      blocked_reason: 'abuse',
      blocked_at: new Date().toISOString(),
    });
    expect(await ensureAnthropicUserProfile({ kind: 'user', userId: user.id })).toBeNull();
    expect(createAnthropicUserProfile).not.toHaveBeenCalled();
  });

  it("gives a sub-organization its parent's profile and shares it with siblings", async () => {
    const parent = await createOrganization(`Parent ${randomUUID()}`);
    const child = await createOrganization(`Child ${randomUUID()}`);
    const sibling = await createOrganization(`Sibling ${randomUUID()}`);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, sibling.id));

    const profile = await ensureAnthropicUserProfile({
      kind: 'organization',
      organizationId: child.id,
      rootOrganizationId: parent.id,
    });
    expect(profile).toMatch(/^uprof_/);
    expect(createAnthropicUserProfile).toHaveBeenCalledTimes(1);
    expect(createAnthropicUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'organization', organizationId: parent.id })
    );
    expect(await organizationProfile(parent.id)).toBe(profile);
    expect(await organizationProfile(child.id)).toBe(profile);
    expect(await organizationProfile(sibling.id)).toBe(profile);
  });

  it('creates nothing for a deleted organization', async () => {
    const organization = await createOrganization(`Gone ${randomUUID()}`);
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));
    expect(
      await ensureAnthropicUserProfile({
        kind: 'organization',
        organizationId: organization.id,
        rootOrganizationId: organization.id,
      })
    ).toBeNull();
    expect(createAnthropicUserProfile).not.toHaveBeenCalled();
  });
});
