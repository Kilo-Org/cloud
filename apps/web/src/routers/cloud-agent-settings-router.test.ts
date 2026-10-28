import { describe, test, expect, beforeAll, afterEach, jest } from '@jest/globals';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_environment_profile_repo_bindings,
  agent_environment_profiles,
  cloud_agent_sandbox_allocation_settings,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  getSandboxAllocation,
  getSandboxAllocationRequest,
  getSandboxAllocationProvider,
  SELECTABLE_SANDBOX_ALLOCATIONS,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { GetSandboxSelectionOptionsInput } from '@/lib/cloud-agent-next/cloud-agent-client';
import type { ProfileOwner } from '@kilocode/cloud-agent-profile';
import type * as TestUtils from '@/routers/test-utils';

const mockGetSandboxSelectionOptions = jest.fn<
  (input: GetSandboxSelectionOptionsInput) => Promise<SandboxSelectionCapabilities>
>(async input => ({
  enabled: true,
  options: SELECTABLE_SANDBOX_ALLOCATIONS.map(allocation => {
    const repositoryUnavailableReason =
      input.repositoryType &&
      input.repositoryType !== 'github' &&
      getSandboxAllocationProvider(allocation) === 'vercel'
        ? 'Vercel sandboxes support GitHub repositories only'
        : undefined;
    return {
      allocation: getSandboxAllocationRequest(allocation),
      ...(repositoryUnavailableReason ? { repositoryUnavailableReason } : {}),
    };
  }),
}));

const mockCreateCloudAgentNextClient = jest.fn((_authToken: string) => ({
  getSandboxSelectionOptions: mockGetSandboxSelectionOptions,
}));

jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: jest.fn(async () => ({ token: 'cloud-agent-token' })),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  createCloudAgentNextClientForModel: jest.fn(),
  rethrowAsPaymentRequired: jest.fn(),
}));

async function insertProfile(owner: ProfileOwner, name: string): Promise<string> {
  const [row] = await db
    .insert(agent_environment_profiles)
    .values({
      ...(owner.type === 'user'
        ? { owned_by_user_id: owner.id }
        : { owned_by_organization_id: owner.id }),
      name,
    })
    .returning({ id: agent_environment_profiles.id });
  return row.id;
}

describe('cloud-agent-settings router', () => {
  let createCallerForUser: typeof TestUtils.createCallerForUser;
  let ownerUser: User;
  let memberUser: User;
  let otherUser: User;
  let organization: Organization;

  beforeAll(async () => {
    ({ createCallerForUser } = await import('@/routers/test-utils'));
    ownerUser = await insertTestUser({ google_user_email: 'settings-owner@example.com' });
    memberUser = await insertTestUser({ google_user_email: 'settings-member@example.com' });
    otherUser = await insertTestUser({ google_user_email: 'settings-other@example.com' });
    organization = await createTestOrganization('Cloud settings org', ownerUser.id, 100000);
    await addUserToOrganization(organization.id, memberUser.id, 'member');
  });

  afterEach(async () => {
    const userIds = [ownerUser.id, memberUser.id, otherUser.id];
    await db
      .delete(cloud_agent_sandbox_allocation_settings)
      .where(
        or(
          inArray(cloud_agent_sandbox_allocation_settings.owned_by_user_id, userIds),
          eq(cloud_agent_sandbox_allocation_settings.owned_by_organization_id, organization.id)
        )
      );
    await db
      .delete(agent_environment_profile_repo_bindings)
      .where(
        or(
          inArray(agent_environment_profile_repo_bindings.owned_by_user_id, userIds),
          eq(agent_environment_profile_repo_bindings.owned_by_organization_id, organization.id)
        )
      );
    await db
      .delete(agent_environment_profiles)
      .where(
        or(
          inArray(agent_environment_profiles.owned_by_user_id, userIds),
          eq(agent_environment_profiles.owned_by_organization_id, organization.id)
        )
      );
    mockGetSandboxSelectionOptions.mockClear();
  });

  describe('personal context', () => {
    test('sets and reads the context default and repository overrides', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const profileId = await insertProfile({ type: 'user', id: ownerUser.id }, 'Personal');

      await caller.cloudAgentSettings.setContextAllocation({ allocation: 'cloudflare-single' });
      await caller.cloudAgentSettings.setRepositorySettings({
        repoFullName: 'Acme/Web',
        platform: 'github',
        profileId,
        allocation: 'vercel-small',
      });

      const result = await caller.cloudAgentSettings.get({});
      expect(result.canManage).toBe(true);
      expect(result.contextAllocation).toBe('cloudflare-single');
      expect(result.repositories).toEqual([
        {
          repositoryFullName: 'acme/web',
          repositoryPlatform: 'github',
          profileId,
          profileName: 'Personal',
          allocation: 'vercel-small',
        },
      ]);
    });

    test('does not leak another user settings', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      await ownerCaller.cloudAgentSettings.setContextAllocation({
        allocation: 'cloudflare-single',
      });

      const otherCaller = await createCallerForUser(otherUser.id);
      const result = await otherCaller.cloudAgentSettings.get({});
      expect(result.contextAllocation).toBeNull();
      expect(result.repositories).toEqual([]);
    });

    test('rejects an allocation the owner is not offered', async () => {
      mockGetSandboxSelectionOptions.mockResolvedValueOnce({
        enabled: false,
        options: [],
      });
      const caller = await createCallerForUser(ownerUser.id);
      await expect(
        caller.cloudAgentSettings.setContextAllocation({ allocation: 'cloudflare-single' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test('rejects a repository-incompatible allocation', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      await expect(
        caller.cloudAgentSettings.setRepositorySettings({
          repoFullName: 'acme/gitlab-repo',
          platform: 'gitlab',
          allocation: 'vercel-small',
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Vercel sandboxes support GitHub repositories only',
      });
    });
  });

  describe('clear semantics', () => {
    test('clears context and repository halves independently', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const profileId = await insertProfile({ type: 'user', id: ownerUser.id }, 'Personal');

      await caller.cloudAgentSettings.setContextAllocation({ allocation: 'cloudflare-single' });
      await caller.cloudAgentSettings.setContextAllocation({ allocation: null });
      expect((await caller.cloudAgentSettings.get({})).contextAllocation).toBeNull();

      await caller.cloudAgentSettings.setRepositorySettings({
        repoFullName: 'acme/web',
        platform: 'github',
        profileId,
        allocation: 'cloudflare-shared',
      });

      await caller.cloudAgentSettings.setRepositorySettings({
        repoFullName: 'acme/web',
        platform: 'github',
        profileId,
        allocation: null,
      });
      let row = (await caller.cloudAgentSettings.get({})).repositories[0];
      expect(row.profileId).toBe(profileId);
      expect(row.allocation).toBeNull();

      await caller.cloudAgentSettings.setRepositorySettings({
        repoFullName: 'acme/web',
        platform: 'github',
        profileId: null,
        allocation: 'cloudflare-shared',
      });
      row = (await caller.cloudAgentSettings.get({})).repositories[0];
      expect(row.profileId).toBeNull();
      expect(row.allocation).toBe('cloudflare-shared');
    });

    test('removing both empty fields deletes the whole row atomically', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const profileId = await insertProfile({ type: 'user', id: ownerUser.id }, 'Personal');

      await caller.cloudAgentSettings.setRepositorySettings({
        repoFullName: 'acme/web',
        platform: 'github',
        profileId,
        allocation: 'cloudflare-shared',
      });

      await caller.cloudAgentSettings.setRepositorySettings({
        repoFullName: 'acme/web',
        platform: 'github',
        profileId: null,
        allocation: null,
      });

      expect((await caller.cloudAgentSettings.get({})).repositories).toEqual([]);
      const bindings = await db
        .select()
        .from(agent_environment_profile_repo_bindings)
        .where(eq(agent_environment_profile_repo_bindings.repo_full_name, 'acme/web'));
      expect(bindings).toHaveLength(0);
    });

    test('rolls back the allocation write when the profile is not owned', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const foreignProfileId = await insertProfile({ type: 'user', id: otherUser.id }, 'Foreign');

      await expect(
        caller.cloudAgentSettings.setRepositorySettings({
          repoFullName: 'acme/web',
          platform: 'github',
          profileId: foreignProfileId,
          allocation: 'cloudflare-shared',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const rows = await db
        .select()
        .from(cloud_agent_sandbox_allocation_settings)
        .where(eq(cloud_agent_sandbox_allocation_settings.owned_by_user_id, ownerUser.id));
      expect(rows).toHaveLength(0);
    });

    test('keeps an unchanged stale allocation while changing the bound profile', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const profileId = await insertProfile({ type: 'user', id: ownerUser.id }, 'Personal');
      // A saved Vercel choice on a GitLab repository is stale: it is no longer
      // offered, but editing the profile must not require re-validating it.
      await db.insert(cloud_agent_sandbox_allocation_settings).values({
        owned_by_user_id: ownerUser.id,
        repository_full_name: 'acme/legacy',
        repository_platform: 'gitlab',
        allocation: 'vercel-small',
      });

      await caller.cloudAgentSettings.setRepositorySettings({
        repoFullName: 'acme/legacy',
        platform: 'gitlab',
        profileId,
        allocation: 'vercel-small',
      });

      const row = (await caller.cloudAgentSettings.get({})).repositories.find(
        candidate => candidate.repositoryFullName === 'acme/legacy'
      );
      expect(row).toMatchObject({
        profileId,
        profileName: 'Personal',
        allocation: 'vercel-small',
      });
    });
  });

  describe('organization context', () => {
    test('members read but cannot mutate; owners can mutate', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);

      const memberView = await memberCaller.cloudAgentSettings.get({
        organizationId: organization.id,
      });
      expect(memberView.canManage).toBe(false);
      expect(
        (await memberCaller.cloudAgentSettings.canManage({ organizationId: organization.id }))
          .canManage
      ).toBe(false);

      const ownerView = await ownerCaller.cloudAgentSettings.get({
        organizationId: organization.id,
      });
      expect(ownerView.canManage).toBe(true);
      expect(
        (await ownerCaller.cloudAgentSettings.canManage({ organizationId: organization.id }))
          .canManage
      ).toBe(true);
      expect((await ownerCaller.cloudAgentSettings.canManage({})).canManage).toBe(true);

      await expect(
        memberCaller.cloudAgentSettings.setContextAllocation({
          organizationId: organization.id,
          allocation: 'cloudflare-single',
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await expect(
        memberCaller.cloudAgentSettings.setRepositorySettings({
          organizationId: organization.id,
          repoFullName: 'acme/web',
          platform: 'github',
          allocation: 'cloudflare-single',
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await expect(
        memberCaller.cloudAgentSettings.removeRepositorySettings({
          organizationId: organization.id,
          repoFullName: 'acme/web',
          platform: 'github',
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await ownerCaller.cloudAgentSettings.setContextAllocation({
        organizationId: organization.id,
        allocation: 'cloudflare-single',
      });
      expect(
        (await ownerCaller.cloudAgentSettings.get({ organizationId: organization.id }))
          .contextAllocation
      ).toBe('cloudflare-single');
    });

    test('personal and organization settings stay separate', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      await caller.cloudAgentSettings.setContextAllocation({ allocation: 'cloudflare-single' });
      await caller.cloudAgentSettings.setContextAllocation({
        organizationId: organization.id,
        allocation: 'cloudflare-shared',
      });

      expect((await caller.cloudAgentSettings.get({})).contextAllocation).toBe('cloudflare-single');
      expect(
        (await caller.cloudAgentSettings.get({ organizationId: organization.id })).contextAllocation
      ).toBe('cloudflare-shared');
    });

    test('rejects binding a profile owned by a different scope', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const personalProfileId = await insertProfile({ type: 'user', id: ownerUser.id }, 'Personal');

      await expect(
        caller.cloudAgentSettings.setRepositorySettings({
          organizationId: organization.id,
          repoFullName: 'acme/web',
          platform: 'github',
          profileId: personalProfileId,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('repository union and unavailable indicators', () => {
    test('unions profile bindings with allocation-only rows', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const profileId = await insertProfile({ type: 'user', id: ownerUser.id }, 'Bound');

      await caller.cloudAgentSettings.setRepositorySettings({
        repoFullName: 'acme/bound',
        platform: 'github',
        profileId,
      });
      await caller.cloudAgentSettings.setRepositorySettings({
        repoFullName: 'acme/allocation-only',
        platform: 'gitlab',
        allocation: 'cloudflare-single',
      });

      const rows = (await caller.cloudAgentSettings.get({})).repositories;
      expect(rows.map(row => row.repositoryFullName)).toEqual([
        'acme/allocation-only',
        'acme/bound',
      ]);
      expect(rows[0]).toMatchObject({
        profileId: null,
        allocation: 'cloudflare-single',
      });
      expect(rows[1]).toMatchObject({ profileId, profileName: 'Bound', allocation: null });
    });

    test('marks a saved repository-incompatible allocation unavailable', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      await db.insert(cloud_agent_sandbox_allocation_settings).values({
        owned_by_user_id: ownerUser.id,
        repository_full_name: 'acme/legacy',
        repository_platform: 'gitlab',
        allocation: 'vercel-small',
      });

      const row = (await caller.cloudAgentSettings.get({})).repositories[0];
      expect(row.allocationRepositoryUnavailableReason).toBe(
        'Vercel sandboxes support GitHub repositories only'
      );
    });

    test('attributes an owner-only billing reason to the owner, not the repository', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      await db.insert(cloud_agent_sandbox_allocation_settings).values({
        owned_by_user_id: ownerUser.id,
        repository_full_name: 'acme/legacy',
        repository_platform: 'github',
        allocation: 'cloudflare-containers-standard-3',
      });
      const ownerUnavailableCapabilities: SandboxSelectionCapabilities = {
        enabled: true,
        options: SELECTABLE_SANDBOX_ALLOCATIONS.map(allocation => ({
          allocation: getSandboxAllocationRequest(allocation),
          ...(allocation === 'cloudflare-containers-standard-3'
            ? { unavailableReason: 'Cloudflare containers are not enabled for this account' }
            : {}),
        })),
      };
      mockGetSandboxSelectionOptions
        .mockResolvedValueOnce(ownerUnavailableCapabilities)
        .mockResolvedValueOnce(ownerUnavailableCapabilities)
        .mockResolvedValueOnce(ownerUnavailableCapabilities);

      const row = (await caller.cloudAgentSettings.get({})).repositories[0];
      expect(row.allocationUnavailableReason).toBe(
        'Cloudflare containers are not enabled for this account'
      );
      expect(row.allocationRepositoryUnavailableReason).toBeUndefined();
    });

    test('exposes GitLab-filtered capabilities without the GitHub-only Vercel allocation', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.cloudAgentSettings.get({});
      const gitlabVercel = result.capabilitiesByPlatform.gitlab.options.find(
        option => getSandboxAllocation(option.allocation) === 'vercel-small'
      );
      expect(gitlabVercel?.repositoryUnavailableReason).toBe(
        'Vercel sandboxes support GitHub repositories only'
      );
      expect(gitlabVercel?.unavailableReason).toBeUndefined();
      const githubVercel = result.capabilitiesByPlatform.github.options.find(
        option => getSandboxAllocation(option.allocation) === 'vercel-small'
      );
      expect(githubVercel?.repositoryUnavailableReason).toBeUndefined();
    });

    test('reports an unavailable saved context default', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      await db.insert(cloud_agent_sandbox_allocation_settings).values({
        owned_by_user_id: ownerUser.id,
        allocation: 'cloudflare-containers-standard-3',
      });
      mockGetSandboxSelectionOptions.mockResolvedValueOnce({
        enabled: true,
        options: SELECTABLE_SANDBOX_ALLOCATIONS.map(allocation => ({
          allocation: getSandboxAllocationRequest(allocation),
          ...(allocation === 'cloudflare-containers-standard-3'
            ? { unavailableReason: 'Cloudflare containers are not enabled for this account' }
            : {}),
        })),
      });

      const result = await caller.cloudAgentSettings.get({});
      expect(result.contextAllocation).toBe('cloudflare-containers-standard-3');
      expect(result.contextUnavailableReason).toBe(
        'Cloudflare containers are not enabled for this account'
      );
    });
  });

  describe('direct persistence service', () => {
    test('persists the context default and repository overrides in one snapshot', async () => {
      const {
        getSandboxAllocationSettings,
        setContextSandboxAllocation,
        setRepoSandboxAllocation,
        clearRepoSandboxAllocation,
      } = await import('@kilocode/cloud-agent-profile');
      const owner: ProfileOwner = { type: 'user', id: ownerUser.id };

      await setContextSandboxAllocation(db, owner, 'cloudflare-single');
      await setRepoSandboxAllocation(db, owner, 'Acme/Web', 'github', 'vercel-small');

      let settings = await getSandboxAllocationSettings(db, owner);
      expect(settings.contextAllocation).toBe('cloudflare-single');
      expect(settings.repositories).toEqual([
        {
          repositoryFullName: 'acme/web',
          repositoryPlatform: 'github',
          allocation: 'vercel-small',
        },
      ]);

      await clearRepoSandboxAllocation(db, owner, 'acme/web', 'github');
      settings = await getSandboxAllocationSettings(db, owner);
      expect(settings.contextAllocation).toBe('cloudflare-single');
      expect(settings.repositories).toEqual([]);
    });

    test('updates the context default in place instead of inserting a second row', async () => {
      const { setContextSandboxAllocation, getSandboxAllocationSettings } =
        await import('@kilocode/cloud-agent-profile');
      const owner: ProfileOwner = { type: 'user', id: ownerUser.id };
      await setContextSandboxAllocation(db, owner, 'cloudflare-single');
      await setContextSandboxAllocation(db, owner, 'cloudflare-shared');

      const rows = await db
        .select()
        .from(cloud_agent_sandbox_allocation_settings)
        .where(
          and(
            eq(cloud_agent_sandbox_allocation_settings.owned_by_user_id, ownerUser.id),
            isNull(cloud_agent_sandbox_allocation_settings.repository_full_name)
          )
        );
      expect(rows).toHaveLength(1);
      expect((await getSandboxAllocationSettings(db, owner)).contextAllocation).toBe(
        'cloudflare-shared'
      );
    });

    test('binds a profile and allocation together and removes both on empty input', async () => {
      const { setRepositorySettings, removeRepositorySettings, getSandboxAllocationSettings } =
        await import('@kilocode/cloud-agent-profile');
      const owner: ProfileOwner = { type: 'user', id: ownerUser.id };
      const profileId = await insertProfile(owner, 'Combined');

      await setRepositorySettings(db, owner, 'acme/web', 'github', {
        profileId,
        allocation: 'cloudflare-shared',
      });
      const binding = await db
        .select()
        .from(agent_environment_profile_repo_bindings)
        .where(eq(agent_environment_profile_repo_bindings.owned_by_user_id, ownerUser.id));
      expect(binding).toHaveLength(1);
      expect((await getSandboxAllocationSettings(db, owner)).repositories).toHaveLength(1);

      await setRepositorySettings(db, owner, 'acme/web', 'github', {
        profileId: null,
        allocation: null,
      });
      expect(
        await db
          .select()
          .from(agent_environment_profile_repo_bindings)
          .where(eq(agent_environment_profile_repo_bindings.owned_by_user_id, ownerUser.id))
      ).toHaveLength(0);
      expect((await getSandboxAllocationSettings(db, owner)).repositories).toHaveLength(0);

      await setRepositorySettings(db, owner, 'acme/web', 'github', {
        profileId,
        allocation: null,
      });
      expect((await getSandboxAllocationSettings(db, owner)).repositories).toHaveLength(0);
      expect(
        await db
          .select()
          .from(agent_environment_profile_repo_bindings)
          .where(eq(agent_environment_profile_repo_bindings.owned_by_user_id, ownerUser.id))
      ).toHaveLength(1);
      await removeRepositorySettings(db, owner, 'acme/web', 'github');
      expect(
        await db
          .select()
          .from(agent_environment_profile_repo_bindings)
          .where(eq(agent_environment_profile_repo_bindings.owned_by_user_id, ownerUser.id))
      ).toHaveLength(0);
    });
  });
});
