jest.mock('@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api', () => ({
  retrieveAnthropicUserProfile: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/operator', () => ({
  isClaudeOperatorConfigured: jest.fn(() => true),
}));

import { beforeEach, describe, expect, it } from '@jest/globals';
import { APIError } from '@anthropic-ai/sdk';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organizations, type User } from '@kilocode/db/schema';
import { retrieveAnthropicUserProfile } from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { eq } from 'drizzle-orm';

const profile = { id: 'uprof_123', type: 'user_profile', access_type: 'passthrough' };

let admin: User;

beforeEach(async () => {
  await cleanupDbForTest();
  jest.mocked(retrieveAnthropicUserProfile).mockReset();
  jest.mocked(isClaudeOperatorConfigured).mockReset().mockReturnValue(true);
  admin = await insertTestUser({
    google_user_email: `anthropic-status-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
});

describe('pullAnthropicUserProfileStatus', () => {
  it('returns the raw profile of a user', async () => {
    jest.mocked(retrieveAnthropicUserProfile).mockResolvedValue(profile as never);
    const target = await insertTestUser();
    await db
      .update(kilocode_users)
      .set({ anthropic_user_profile_id: 'uprof_123' })
      .where(eq(kilocode_users.id, target.id));
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.pullAnthropicUserProfileStatus({ userId: target.id })
    ).resolves.toEqual({ profile });
    expect(retrieveAnthropicUserProfile).toHaveBeenCalledWith('uprof_123');
  });

  it('returns the raw profile of an organization', async () => {
    jest.mocked(retrieveAnthropicUserProfile).mockResolvedValue(profile as never);
    const organization = await createTestOrganization('Profiled organization', admin.id, 0);
    await db
      .update(organizations)
      .set({ anthropic_user_profile_id: 'uprof_123' })
      .where(eq(organizations.id, organization.id));
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.organizations.admin.pullAnthropicUserProfileStatus({
        organizationId: organization.id,
      })
    ).resolves.toEqual({ profile });
  });

  it('includes the profile ID in the organization details', async () => {
    const organization = await createTestOrganization('Profiled organization', admin.id, 0);
    await db
      .update(organizations)
      .set({ anthropic_user_profile_id: 'uprof_123' })
      .where(eq(organizations.id, organization.id));
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.organizations.admin.getDetails({ organizationId: organization.id })
    ).resolves.toMatchObject({ anthropic_user_profile_id: 'uprof_123' });
  });

  it('fails when the user has no profile, without calling Anthropic', async () => {
    const target = await insertTestUser();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.pullAnthropicUserProfileStatus({ userId: target.id })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(retrieveAnthropicUserProfile).not.toHaveBeenCalled();
  });

  it('fails when the user does not exist', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.pullAnthropicUserProfileStatus({ userId: 'missing-user' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails when the organization does not exist', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.organizations.admin.pullAnthropicUserProfileStatus({
        organizationId: '9d278969-5453-4ae3-a51f-a8d2274a7b56',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fails when the operator is not configured', async () => {
    jest.mocked(isClaudeOperatorConfigured).mockReturnValue(false);
    const target = await insertTestUser();
    await db
      .update(kilocode_users)
      .set({ anthropic_user_profile_id: 'uprof_123' })
      .where(eq(kilocode_users.id, target.id));
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.users.pullAnthropicUserProfileStatus({ userId: target.id })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(retrieveAnthropicUserProfile).not.toHaveBeenCalled();
  });

  it('maps Anthropic errors', async () => {
    const target = await insertTestUser();
    await db
      .update(kilocode_users)
      .set({ anthropic_user_profile_id: 'uprof_123' })
      .where(eq(kilocode_users.id, target.id));
    const caller = await createCallerForUser(admin.id);

    jest
      .mocked(retrieveAnthropicUserProfile)
      .mockRejectedValue(
        APIError.generate(404, { error: { message: 'gone' } }, 'gone', new Headers())
      );
    await expect(
      caller.admin.users.pullAnthropicUserProfileStatus({ userId: target.id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    jest.mocked(retrieveAnthropicUserProfile).mockRejectedValue(new Error('upstream down'));
    await expect(
      caller.admin.users.pullAnthropicUserProfileStatus({ userId: target.id })
    ).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
      message: expect.stringContaining('upstream down'),
    });
  });

  it('rejects non-admin users', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.admin.users.pullAnthropicUserProfileStatus({ userId: user.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
