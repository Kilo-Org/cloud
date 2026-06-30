import { beforeAll, describe, expect, it } from '@jest/globals';
import type { Organization, User } from '@kilocode/db/schema';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

let organization: Organization;
let owner: User;
let billingManager: User;
let member: User;
let admin: User;

beforeAll(async () => {
  owner = await insertTestUser();
  billingManager = await insertTestUser();
  member = await insertTestUser();
  admin = await insertTestUser({ is_admin: true });
  organization = await createOrganization(`Onboarding router ${crypto.randomUUID()}`, owner.id);
  await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
  await addUserToOrganization(organization.id, member.id, 'member');
});

describe('getOnboardingChecklist procedure', () => {
  it.each([
    ['owner', () => owner],
    ['billing manager', () => billingManager],
    ['Kilo admin', () => admin],
  ] as const)('allows an %s to read semantic checklist state', async (_label, getUser) => {
    const caller = await createCallerForUser(getUser().id);

    const result = await caller.organizations.getOnboardingChecklist({
      organizationId: organization.id,
    });

    expect(result).toEqual({
      steps: [
        { key: 'source-control', done: false },
        { key: 'code-reviewer', done: false },
        { key: 'invite-team', done: true },
      ],
      completedCount: 1,
      totalCount: 3,
      connectedPlatform: null,
    });
  });

  it('rejects an ordinary organization member', async () => {
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.organizations.getOnboardingChecklist({ organizationId: organization.id })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('validates the organization ID', async () => {
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.organizations.getOnboardingChecklist({ organizationId: 'not-a-uuid' })
    ).rejects.toBeDefined();
  });
});
