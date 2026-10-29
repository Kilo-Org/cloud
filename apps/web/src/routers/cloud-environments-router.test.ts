import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import type * as TestUtils from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  addUserToOrganization,
  markOrganizationAsDeleted,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  cloud_agent_environment_vars,
  cloud_agent_environments,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { MASKED_SECRET_VALUE, loadEnvironmentForSession } from '@kilocode/cloud-agent-profile';
import { canonicalGitLabCloneUrl } from '@kilocode/worker-utils/git-url';
import {
  getSandboxAllocationProvider,
  getSandboxAllocationRequest,
  SELECTABLE_SANDBOX_ALLOCATIONS,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { GetSandboxSelectionOptionsInput } from '@/lib/cloud-agent-next/cloud-agent-client';

// The Worker offers every allocation; Vercel only for GitHub repositories.
function offerAll(input: GetSandboxSelectionOptionsInput): SandboxSelectionCapabilities {
  return {
    enabled: true,
    options: SELECTABLE_SANDBOX_ALLOCATIONS.map(allocation => ({
      allocation: getSandboxAllocationRequest(allocation),
      ...(input.repositoryType &&
      input.repositoryType !== 'github' &&
      getSandboxAllocationProvider(allocation) === 'vercel'
        ? { repositoryUnavailableReason: 'Vercel sandboxes support GitHub repositories only' }
        : {}),
    })),
  };
}

const mockGetSandboxSelectionOptions = jest.fn(async (input: GetSandboxSelectionOptionsInput) =>
  offerAll(input)
);

const mockIsFeatureFlagEnabled = jest.fn(async (_flag: string, _distinctId?: string) => false);

jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isFeatureFlagEnabled: (flag: string, distinctId?: string) =>
    mockIsFeatureFlagEnabled(flag, distinctId),
}));

jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: jest.fn(async () => ({ token: 'cloud-agent-token' })),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({
    getSandboxSelectionOptions: mockGetSandboxSelectionOptions,
  })),
}));

const GITHUB_REPO = 'acme/widgets';
const BITBUCKET_WORKSPACE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BITBUCKET_REPOSITORY_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function storedValue(environmentId: string, key: string): Promise<string | undefined> {
  const [row] = await db
    .select({ value: cloud_agent_environment_vars.value })
    .from(cloud_agent_environment_vars)
    .where(
      and(
        eq(cloud_agent_environment_vars.environment_id, environmentId),
        eq(cloud_agent_environment_vars.key, key)
      )
    );
  return row?.value;
}

describe('cloudEnvironmentsRouter', () => {
  let createCallerForUser: typeof TestUtils.createCallerForUser;

  // The router graph loads after the mocks above, so it uses them.
  beforeAll(async () => {
    ({ createCallerForUser } = await import('@/routers/test-utils'));
  });

  afterEach(async () => {
    mockGetSandboxSelectionOptions.mockImplementation(async input => offerAll(input));
    await cleanupDbForTest();
  });

  // The router graph loads after the mocks above, so it uses them.
  beforeAll(async () => {
    ({ createCallerForUser } = await import('@/routers/test-utils'));
  });

  afterEach(async () => {
    mockGetSandboxSelectionOptions.mockImplementation(async input => offerAll(input));
    mockIsFeatureFlagEnabled.mockReset();
    mockIsFeatureFlagEnabled.mockResolvedValue(false);
    await cleanupDbForTest();
  });

  test('a member can list but cannot create, while owner and admin can create, update, and delete', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const admin = await insertTestUser();
    const nonMember = await insertTestUser();
    const organization = await createTestOrganization('Environment permissions org', owner.id, 0);
    await addUserToOrganization(organization.id, member.id, 'member');
    await addUserToOrganization(organization.id, admin.id, 'admin');

    const ownerCaller = await createCallerForUser(owner.id);
    const { id } = await ownerCaller.cloudEnvironments.create({
      organizationId: organization.id,
      name: 'shared',
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });
    expect(id).toBeDefined();

    const memberCaller = await createCallerForUser(member.id);
    const list = await memberCaller.cloudEnvironments.list({
      organizationId: organization.id,
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });
    expect(list.map(environment => environment.id)).toEqual([id]);
    await expect(
      memberCaller.cloudEnvironments.create({
        organizationId: organization.id,
        name: 'member-created',
        repository: { platform: 'github', fullName: GITHUB_REPO },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const adminCaller = await createCallerForUser(admin.id);
    const adminCreated = await adminCaller.cloudEnvironments.create({
      organizationId: organization.id,
      name: 'admin-created',
      repository: { platform: 'github', fullName: 'acme/gadgets' },
    });
    expect(adminCreated.id).toBeDefined();

    for (const [caller, environmentId] of [
      [ownerCaller, id],
      [adminCaller, adminCreated.id],
    ] as const) {
      expect(
        await caller.cloudAgentSettings.canManage({ organizationId: organization.id })
      ).toEqual({ canManage: true });
      await caller.cloudEnvironments.update({
        organizationId: organization.id,
        environmentId,
        commands: ['echo updated'],
      });
      expect(
        await caller.cloudEnvironments.get({ organizationId: organization.id, environmentId })
      ).toMatchObject({ commands: ['echo updated'] });
      await caller.cloudEnvironments.delete({ organizationId: organization.id, environmentId });
      await expect(
        caller.cloudEnvironments.get({ organizationId: organization.id, environmentId })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    const nonMemberCaller = await createCallerForUser(nonMember.id);
    await expect(
      nonMemberCaller.cloudEnvironments.list({
        organizationId: organization.id,
        repository: { platform: 'github', fullName: GITHUB_REPO },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('billing managers cannot create, update, or delete organization environments', async () => {
    const owner = await insertTestUser();
    const billingManager = await insertTestUser();
    const organization = await createTestOrganization(
      'Environment billing permissions',
      owner.id,
      0
    );
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    const ownerCaller = await createCallerForUser(owner.id);
    const caller = await createCallerForUser(billingManager.id);
    const { id } = await ownerCaller.cloudEnvironments.create({
      organizationId: organization.id,
      name: 'protected',
      repository: { platform: 'github', fullName: GITHUB_REPO },
      commands: ['echo original'],
    });

    expect(await caller.cloudAgentSettings.canManage({ organizationId: organization.id })).toEqual({
      canManage: false,
    });
    await expect(
      caller.cloudEnvironments.create({
        organizationId: organization.id,
        name: 'unauthorized',
        repository: { platform: 'github', fullName: 'acme/other' },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller.cloudEnvironments.update({
        organizationId: organization.id,
        environmentId: id,
        commands: ['echo changed'],
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller.cloudEnvironments.delete({ organizationId: organization.id, environmentId: id })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(
      await ownerCaller.cloudEnvironments.get({
        organizationId: organization.id,
        environmentId: id,
      })
    ).toMatchObject({ commands: ['echo original'] });
    expect(
      await ownerCaller.cloudEnvironments.listAll({ organizationId: organization.id })
    ).toHaveLength(1);
  });

  test('listAll returns every repository for the owner and honours organization scope', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const nonMember = await insertTestUser();
    const organization = await createTestOrganization('Environment listAll org', owner.id, 0);
    await addUserToOrganization(organization.id, member.id, 'member');

    const ownerCaller = await createCallerForUser(owner.id);
    const { id: first } = await ownerCaller.cloudEnvironments.create({
      name: 'one',
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });
    const { id: second } = await ownerCaller.cloudEnvironments.create({
      name: 'two',
      repository: { platform: 'github', fullName: 'acme/gadgets' },
    });
    const { id: shared } = await ownerCaller.cloudEnvironments.create({
      organizationId: organization.id,
      name: 'shared',
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });

    const personal = await ownerCaller.cloudEnvironments.listAll({});
    expect(personal.map(environment => environment.id).sort()).toEqual([first, second].sort());
    expect(personal.map(environment => environment.repoFullName).sort()).toEqual(
      ['acme/gadgets', GITHUB_REPO].sort()
    );

    const memberCaller = await createCallerForUser(member.id);
    const orgList = await memberCaller.cloudEnvironments.listAll({
      organizationId: organization.id,
    });
    expect(orgList.map(environment => environment.id)).toEqual([shared]);

    const nonMemberCaller = await createCallerForUser(nonMember.id);
    await expect(
      nonMemberCaller.cloudEnvironments.listAll({ organizationId: organization.id })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('a member cannot update or delete, and a foreign id is not found', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const outsider = await insertTestUser();
    const organization = await createTestOrganization('Environment edit org', owner.id, 0);
    await addUserToOrganization(organization.id, member.id, 'member');

    const ownerCaller = await createCallerForUser(owner.id);
    const { id: orgEnvironmentId } = await ownerCaller.cloudEnvironments.create({
      organizationId: organization.id,
      name: 'org-env',
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });

    const memberCaller = await createCallerForUser(member.id);
    await expect(
      memberCaller.cloudEnvironments.update({
        organizationId: organization.id,
        environmentId: orgEnvironmentId,
        name: 'member-edit',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      memberCaller.cloudEnvironments.delete({
        organizationId: organization.id,
        environmentId: orgEnvironmentId,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      memberCaller.cloudEnvironments.update({ environmentId: orgEnvironmentId, name: 'bypass' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await ownerCaller.cloudEnvironments.get({
        organizationId: organization.id,
        environmentId: orgEnvironmentId,
      })
    ).toMatchObject({ name: 'org-env' });

    const { id: personalId } = await ownerCaller.cloudEnvironments.create({
      name: 'personal',
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });
    const outsiderCaller = await createCallerForUser(outsider.id);
    await expect(
      outsiderCaller.cloudEnvironments.update({ environmentId: personalId, name: 'hijack' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      outsiderCaller.cloudEnvironments.delete({ environmentId: personalId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const environment = await ownerCaller.cloudEnvironments.get({ environmentId: personalId });
    expect(environment.name).toBe('personal');
  });

  test('rejects a second environment for the repository with CONFLICT, but allows a rename', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);

    const { id } = await caller.cloudEnvironments.create({
      name: 'first',
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });
    await expect(
      caller.cloudEnvironments.create({
        name: 'second',
        repository: { platform: 'github', fullName: 'Acme/Widgets' },
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This repository already has an environment.',
    });

    await caller.cloudEnvironments.create({
      name: 'gitlab',
      repository: { platform: 'gitlab', projectPath: 'group/project' },
    });
    await expect(
      caller.cloudEnvironments.create({
        name: 'gitlab again',
        repository: { platform: 'gitlab', projectPath: 'group/project' },
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await caller.cloudEnvironments.update({ environmentId: id, name: 'renamed' });
    const environment = await caller.cloudEnvironments.get({ environmentId: id });
    expect(environment.name).toBe('renamed');
  });

  test('saves, keeps, and clears the sandbox size, and rejects an unknown key', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);
    const repository = { platform: 'github' as const, fullName: GITHUB_REPO };

    const { id } = await caller.cloudEnvironments.create({
      name: 'sized',
      repository,
      sandboxAllocation: 'cloudflare-single',
    });
    expect((await caller.cloudEnvironments.get({ environmentId: id })).sandboxAllocation).toBe(
      'cloudflare-single'
    );

    await caller.cloudEnvironments.update({ environmentId: id, name: 'still sized' });
    const [summary] = await caller.cloudEnvironments.list({ repository });
    expect(summary).toMatchObject({ sandboxAllocation: 'cloudflare-single' });

    const { configurationRevision } = await caller.cloudEnvironments.update({
      environmentId: id,
      sandboxAllocation: null,
    });
    expect(configurationRevision).toBe(1);
    expect(
      (await caller.cloudEnvironments.get({ environmentId: id })).sandboxAllocation
    ).toBeNull();

    await expect(
      caller.cloudEnvironments.update({
        environmentId: id,
        sandboxAllocation: 'not-a-sandbox' as 'cloudflare-single',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('rejects a newly chosen sandbox the owner is not offered for the repository', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.cloudEnvironments.create({
        name: 'gitlab vercel',
        repository: { platform: 'gitlab', projectPath: 'group/project' },
        sandboxAllocation: 'vercel-small',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Vercel sandboxes support GitHub repositories only',
    });

    const { id } = await caller.cloudEnvironments.create({
      name: 'github',
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });
    mockGetSandboxSelectionOptions.mockResolvedValue({ enabled: false, options: [] });
    await expect(
      caller.cloudEnvironments.update({ environmentId: id, sandboxAllocation: 'cloudflare-single' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Sandbox selection is not enabled for this owner',
    });
    expect(
      (await caller.cloudEnvironments.get({ environmentId: id })).sandboxAllocation
    ).toBeNull();
  });

  test('keeps an unchanged saved sandbox that is no longer offered', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);
    const { id } = await caller.cloudEnvironments.create({
      name: 'stale',
      repository: { platform: 'github', fullName: GITHUB_REPO },
      sandboxAllocation: 'cloudflare-single',
    });

    mockGetSandboxSelectionOptions.mockResolvedValue({ enabled: false, options: [] });
    mockGetSandboxSelectionOptions.mockClear();
    await caller.cloudEnvironments.update({
      environmentId: id,
      commands: ['pnpm install'],
      sandboxAllocation: 'cloudflare-single',
    });
    await caller.cloudEnvironments.update({ environmentId: id, sandboxAllocation: null });

    expect(mockGetSandboxSelectionOptions).not.toHaveBeenCalled();
    const environment = await caller.cloudEnvironments.get({ environmentId: id });
    expect(environment.commands).toEqual(['pnpm install']);
    expect(environment.sandboxAllocation).toBeNull();
  });

  test('get returns plain variables and secret key names but never secret values', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);
    const plaintext = 'plain-value';
    const secret = 'super-secret-value';
    const { id } = await caller.cloudEnvironments.create({
      name: 'personal',
      repository: { platform: 'github', fullName: GITHUB_REPO },
      plainVars: { PLAIN: plaintext },
      secrets: { API_KEY: secret },
      commands: ['npm ci'],
    });

    const environment = await caller.cloudEnvironments.get({ environmentId: id });

    expect(environment.secretKeys).toEqual(['API_KEY']);
    expect(environment.plainVars).toEqual([
      expect.objectContaining({ key: 'PLAIN', value: plaintext }),
    ]);
    expect(environment.commands).toEqual(['npm ci']);
    expect(JSON.stringify(environment)).not.toContain(secret);
    expect(await storedValue(id, 'API_KEY')).not.toContain(secret);
  });

  test('a GitLab create stores the canonical clone URL and list filters by it', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);
    const { id } = await caller.cloudEnvironments.create({
      name: 'gitlab',
      repository: { platform: 'gitlab', projectPath: 'group/project' },
    });

    const [row] = await db
      .select({ cloneUrl: cloud_agent_environments.gitlab_clone_url })
      .from(cloud_agent_environments)
      .where(eq(cloud_agent_environments.id, id));
    expect(row.cloneUrl).toBe('https://gitlab.com/group/project.git');

    const matching = await caller.cloudEnvironments.list({
      repository: { platform: 'gitlab', projectPath: 'group/project' },
    });
    const other = await caller.cloudEnvironments.list({
      repository: { platform: 'gitlab', projectPath: 'group/other' },
    });

    expect(matching.map(environment => environment.id)).toEqual([id]);
    expect(other).toEqual([]);
  });

  test('a self-hosted GitLab instance stores and lists by its own canonical clone URL', async () => {
    const selfHosted = await insertTestUser();
    const gitlabCom = await insertTestUser();
    await db.insert(platform_integrations).values({
      owned_by_user_id: selfHosted.id,
      platform: 'gitlab',
      integration_type: 'oauth',
      integration_status: 'active',
      metadata: { gitlab_instance_url: 'https://git.example:8443/gitlab' },
    });

    const selfHostedCaller = await createCallerForUser(selfHosted.id);
    const { id } = await selfHostedCaller.cloudEnvironments.create({
      name: 'self-hosted',
      repository: { platform: 'gitlab', projectPath: 'group/repo' },
    });

    const [row] = await db
      .select({ cloneUrl: cloud_agent_environments.gitlab_clone_url })
      .from(cloud_agent_environments)
      .where(eq(cloud_agent_environments.id, id));
    expect(row.cloneUrl).toBe('https://git.example:8443/gitlab/group/repo.git');

    const gitlabComCaller = await createCallerForUser(gitlabCom.id);
    const { id: comId } = await gitlabComCaller.cloudEnvironments.create({
      name: 'gitlab-com',
      repository: { platform: 'gitlab', projectPath: 'group/repo' },
    });
    const [comRow] = await db
      .select({ cloneUrl: cloud_agent_environments.gitlab_clone_url })
      .from(cloud_agent_environments)
      .where(eq(cloud_agent_environments.id, comId));
    expect(comRow.cloneUrl).toBe('https://gitlab.com/group/repo.git');

    const selfHostedList = await selfHostedCaller.cloudEnvironments.list({
      repository: { platform: 'gitlab', projectPath: 'group/repo' },
    });
    expect(selfHostedList.map(environment => environment.id)).toEqual([id]);

    // A session resolves the environment from its clone URL, canonicalized as
    // the Worker does it, so both sides must reach the same identity.
    const sessionCloneUrl = canonicalGitLabCloneUrl(
      'https://GIT.example:8443/gitlab/group/repo.git'
    );
    expect(sessionCloneUrl).not.toBeNull();
    const resolution = await loadEnvironmentForSession(db, {
      owner: { type: 'user', id: selfHosted.id },
      repository: { platform: 'gitlab', cloneUrl: sessionCloneUrl ?? '' },
    });
    expect(resolution.status).toBe('match');
    expect(
      resolution.status === 'match' ? resolution.environment.reference.environmentId : null
    ).toBe(id);

    const comList = await gitlabComCaller.cloudEnvironments.list({
      repository: { platform: 'gitlab', projectPath: 'group/repo' },
    });
    expect(comList.map(environment => environment.id)).toEqual([comId]);
  });

  test('a Bitbucket list filters by the workspace and repository UUID pair', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);
    const { id } = await caller.cloudEnvironments.create({
      name: 'bitbucket',
      repository: {
        platform: 'bitbucket',
        fullName: 'team/repo',
        workspaceUuid: BITBUCKET_WORKSPACE_UUID,
        repositoryUuid: BITBUCKET_REPOSITORY_UUID,
      },
    });

    const matching = await caller.cloudEnvironments.list({
      repository: {
        platform: 'bitbucket',
        workspaceUuid: BITBUCKET_WORKSPACE_UUID,
        repositoryUuid: BITBUCKET_REPOSITORY_UUID,
      },
    });
    const other = await caller.cloudEnvironments.list({
      repository: {
        platform: 'bitbucket',
        workspaceUuid: BITBUCKET_WORKSPACE_UUID,
        repositoryUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
    });

    expect(matching.map(environment => environment.id)).toEqual([id]);
    expect(other).toEqual([]);
  });

  test('update keeps untouched secrets, deletes explicitly removed ones, and rejects a placeholder', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);
    const { id } = await caller.cloudEnvironments.create({
      name: 'secrets',
      repository: { platform: 'github', fullName: GITHUB_REPO },
      secrets: { KEEP: 'keep-value', DROP: 'drop-value' },
    });

    await caller.cloudEnvironments.update({
      environmentId: id,
      secrets: [
        { key: 'DROP', delete: true },
        { key: 'ADDED', value: 'added-value' },
      ],
    });

    const environment = await caller.cloudEnvironments.get({ environmentId: id });
    expect(environment.secretKeys).toEqual(['ADDED', 'KEEP']);

    await expect(
      caller.cloudEnvironments.update({
        environmentId: id,
        secrets: [{ key: 'PLACEHOLDER', value: MASKED_SECRET_VALUE }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await storedValue(id, 'PLACEHOLDER')).toBeUndefined();
  });

  test('update returns the configuration revision, which only setup changes advance', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);
    const { id } = await caller.cloudEnvironments.create({
      name: 'revisions',
      repository: { platform: 'github', fullName: GITHUB_REPO },
      commands: ['pnpm install'],
    });
    expect((await caller.cloudEnvironments.get({ environmentId: id })).configurationRevision).toBe(
      1
    );

    const renamed = await caller.cloudEnvironments.update({ environmentId: id, name: 'renamed' });
    expect(renamed.configurationRevision).toBe(1);

    const edited = await caller.cloudEnvironments.update({
      environmentId: id,
      commands: ['pnpm install --frozen-lockfile'],
    });
    expect(edited.configurationRevision).toBe(2);
    expect((await caller.cloudEnvironments.get({ environmentId: id })).configurationRevision).toBe(
      2
    );
  });

  test('a member cannot build, cancel, or read build logs', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const organization = await createTestOrganization('Environment build org', owner.id, 0);
    await addUserToOrganization(organization.id, member.id, 'member');
    const ownerCaller = await createCallerForUser(owner.id);
    const { id } = await ownerCaller.cloudEnvironments.create({
      organizationId: organization.id,
      name: 'shared',
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });

    const memberCaller = await createCallerForUser(member.id);
    const buildId = '11111111-1111-4111-8111-111111111111';
    await expect(
      memberCaller.cloudEnvironments.build({
        organizationId: organization.id,
        environmentId: id,
        expectedRevision: 1,
        requestId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      memberCaller.cloudEnvironments.cancelBuild({
        organizationId: organization.id,
        environmentId: id,
        buildId,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      memberCaller.cloudEnvironments.buildLogs({
        organizationId: organization.id,
        environmentId: id,
        buildId,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('a soft-deleted organization is not found for list, get, and create', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization('Soft-deleted org', owner.id, 0);
    const caller = await createCallerForUser(owner.id);
    const { id } = await caller.cloudEnvironments.create({
      organizationId: organization.id,
      name: 'gone',
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });

    await markOrganizationAsDeleted(organization.id);

    await expect(
      caller.cloudEnvironments.list({
        organizationId: organization.id,
        repository: { platform: 'github', fullName: GITHUB_REPO },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.cloudEnvironments.get({ organizationId: organization.id, environmentId: id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // A create after the soft delete committed is rejected by the
    // in-transaction org recheck. The lock serialisation itself is proven by
    // the concurrent test in the service suite.
    await expect(
      caller.cloudEnvironments.create({
        organizationId: organization.id,
        name: 'after-delete',
        repository: { platform: 'github', fullName: GITHUB_REPO },
        secrets: { SECRET: 'never-written' },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const rows = await db
      .select({ id: cloud_agent_environments.id })
      .from(cloud_agent_environments)
      .where(eq(cloud_agent_environments.owned_by_organization_id, organization.id));
    expect(rows).toEqual([]);
  });
  describe('multi-repository (V2) environments', () => {
    const FLAG = 'cloud-agent-multi-repository-environments';
    const widgets = { platform: 'github' as const, fullName: GITHUB_REPO };
    const api = { platform: 'github' as const, fullName: 'acme/api' };

    test('multiRepositoryEnabled reports the flag of the owner, never of the viewer', async () => {
      const owner = await insertTestUser();
      const organization = await createTestOrganization('V2 query org', owner.id, 0);
      const caller = await createCallerForUser(owner.id);

      expect(await caller.cloudEnvironments.multiRepositoryEnabled({})).toBe(false);
      expect(mockIsFeatureFlagEnabled).toHaveBeenLastCalledWith(FLAG, owner.id);

      mockIsFeatureFlagEnabled.mockImplementation(async (_flag, id) => id === organization.id);
      expect(
        await caller.cloudEnvironments.multiRepositoryEnabled({ organizationId: organization.id })
      ).toBe(true);
      expect(await caller.cloudEnvironments.multiRepositoryEnabled({})).toBe(false);
    });

    test('multiRepositoryEnabled is not readable by a non-member of the organization', async () => {
      const owner = await insertTestUser();
      const outsider = await insertTestUser();
      const organization = await createTestOrganization('V2 query org 2', owner.id, 0);
      const caller = await createCallerForUser(outsider.id);

      await expect(
        caller.cloudEnvironments.multiRepositoryEnabled({ organizationId: organization.id })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    test('create requires the flag, checked for the user id of a personal owner', async () => {
      const owner = await insertTestUser();
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.cloudEnvironments.create({ name: 'multi', repositories: [widgets, api] })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockIsFeatureFlagEnabled).toHaveBeenCalledWith(FLAG, owner.id);
      expect(await db.select().from(cloud_agent_environments)).toEqual([]);
    });

    test('create checks the flag for the organization id of an organization owner', async () => {
      const owner = await insertTestUser();
      const organization = await createTestOrganization('V2 flag org', owner.id, 0);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.cloudEnvironments.create({
          organizationId: organization.id,
          name: 'multi',
          repositories: [widgets],
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockIsFeatureFlagEnabled).toHaveBeenCalledWith(FLAG, organization.id);
    });

    test('create rejects both repository and repositories, and neither', async () => {
      const owner = await insertTestUser();
      mockIsFeatureFlagEnabled.mockResolvedValue(true);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.cloudEnvironments.create({
          name: 'both',
          repository: widgets,
          repositories: [widgets],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(caller.cloudEnvironments.create({ name: 'neither' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    test('with the flag on, create stores repositories, builds the GitLab clone URL, and lists by containment', async () => {
      const owner = await insertTestUser();
      mockIsFeatureFlagEnabled.mockResolvedValue(true);
      const caller = await createCallerForUser(owner.id);

      const { id } = await caller.cloudEnvironments.create({
        name: 'multi',
        repositories: [widgets, { platform: 'gitlab', projectPath: 'Group/Tool' }],
      });

      expect(await caller.cloudEnvironments.get({ environmentId: id })).toMatchObject({
        repositories: [
          { platform: 'github', repoFullName: GITHUB_REPO },
          {
            platform: 'gitlab',
            repoFullName: 'group/tool',
            gitlabCloneUrl: 'https://gitlab.com/Group/Tool.git',
          },
        ],
      });
      const listed = await caller.cloudEnvironments.list({
        repository: { platform: 'gitlab', projectPath: 'Group/Tool' },
      });
      expect(listed.map(environment => environment.id)).toEqual([id]);
      // A V1 environment for the same repository does not collide with it.
      await expect(
        caller.cloudEnvironments.create({ name: 'single', repository: widgets })
      ).resolves.toMatchObject({ id: expect.any(String) });
    });

    test('a GitLab entry created by the router matches the identity a session computes', async () => {
      const owner = await insertTestUser();
      mockIsFeatureFlagEnabled.mockResolvedValue(true);
      const caller = await createCallerForUser(owner.id);
      const { id } = await caller.cloudEnvironments.create({
        name: 'multi',
        repositories: [widgets, { platform: 'gitlab', projectPath: 'Group/Tool' }],
      });

      const cloneUrl = canonicalGitLabCloneUrl('https://gitlab.com/Group/Tool.git');
      expect(cloneUrl).not.toBeNull();
      const resolution = await loadEnvironmentForSession(db, {
        owner: { type: 'user', id: owner.id },
        repository: { platform: 'gitlab', cloneUrl: cloneUrl ?? '' },
      });
      expect(resolution.status).toBe('match');
      expect(
        resolution.status === 'match' ? resolution.environment.reference.environmentId : null
      ).toBe(id);
    });

    test('a self-hosted GitLab entry created by the router matches the identity a session computes', async () => {
      const owner = await insertTestUser();
      await db.insert(platform_integrations).values({
        owned_by_user_id: owner.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        integration_status: 'active',
        metadata: { gitlab_instance_url: 'https://git.example:8443/gitlab' },
      });
      mockIsFeatureFlagEnabled.mockResolvedValue(true);
      const caller = await createCallerForUser(owner.id);
      const { id } = await caller.cloudEnvironments.create({
        name: 'multi',
        repositories: [widgets, { platform: 'gitlab', projectPath: 'group/repo' }],
      });

      const cloneUrl = canonicalGitLabCloneUrl('https://GIT.example:8443/gitlab/group/repo.git');
      expect(cloneUrl).not.toBeNull();
      const resolution = await loadEnvironmentForSession(db, {
        owner: { type: 'user', id: owner.id },
        repository: { platform: 'gitlab', cloneUrl: cloneUrl ?? '' },
      });
      expect(resolution.status).toBe('match');
      expect(
        resolution.status === 'match' ? resolution.environment.reference.environmentId : null
      ).toBe(id);
    });

    test('create rejects a duplicate leaf with a message that names both repositories', async () => {
      const owner = await insertTestUser();
      mockIsFeatureFlagEnabled.mockResolvedValue(true);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.cloudEnvironments.create({
          name: 'same-leaf',
          repositories: [widgets, { platform: 'github', fullName: 'other/Widgets' }],
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('acme/widgets and other/widgets'),
      });
    });

    test.each(['cloudflare-shared', 'vercel-small'] as const)(
      'create rejects the %s allocation and accepts an isolated one',
      async allocation => {
        const owner = await insertTestUser();
        mockIsFeatureFlagEnabled.mockResolvedValue(true);
        const caller = await createCallerForUser(owner.id);

        await expect(
          caller.cloudEnvironments.create({
            name: 'multi',
            repositories: [widgets],
            sandboxAllocation: allocation,
          })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(
          caller.cloudEnvironments.create({
            name: 'multi',
            repositories: [widgets],
            sandboxAllocation: 'cloudflare-containers-standard-3',
          })
        ).resolves.toMatchObject({ id: expect.any(String) });
      }
    );

    test('update replaces repositories behind the flag and advances the revision', async () => {
      const owner = await insertTestUser();
      mockIsFeatureFlagEnabled.mockResolvedValue(true);
      const caller = await createCallerForUser(owner.id);
      const { id } = await caller.cloudEnvironments.create({
        name: 'multi',
        repositories: [widgets],
      });

      mockIsFeatureFlagEnabled.mockResolvedValue(false);
      await expect(
        caller.cloudEnvironments.update({ environmentId: id, repositories: [widgets, api] })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // An edit that leaves the repositories alone does not need the flag.
      await expect(
        caller.cloudEnvironments.update({ environmentId: id, name: 'renamed' })
      ).resolves.toMatchObject({ configurationRevision: 1 });

      mockIsFeatureFlagEnabled.mockResolvedValue(true);
      await expect(
        caller.cloudEnvironments.update({ environmentId: id, repositories: [widgets, api] })
      ).resolves.toMatchObject({ configurationRevision: 2 });
      expect(
        (await caller.cloudEnvironments.get({ environmentId: id })).repositories?.map(
          repository => repository.repoFullName
        )
      ).toEqual([GITHUB_REPO, 'acme/api']);
    });

    test.each(['cloudflare-shared', 'vercel-small'] as const)(
      'update rejects the %s allocation on a V2 environment and accepts it on a V1 one',
      async allocation => {
        const owner = await insertTestUser();
        mockIsFeatureFlagEnabled.mockResolvedValue(true);
        const caller = await createCallerForUser(owner.id);
        const multi = await caller.cloudEnvironments.create({
          name: 'multi',
          repositories: [widgets, api],
        });
        const single = await caller.cloudEnvironments.create({
          name: 'single',
          repository: widgets,
        });

        await expect(
          caller.cloudEnvironments.update({
            environmentId: multi.id,
            sandboxAllocation: allocation,
          })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(
          caller.cloudEnvironments.update({
            environmentId: single.id,
            sandboxAllocation: allocation,
          })
        ).resolves.toMatchObject({ success: true });
        expect(
          (await caller.cloudEnvironments.get({ environmentId: single.id })).sandboxAllocation
        ).toBe(allocation);
        expect(
          (await caller.cloudEnvironments.get({ environmentId: multi.id })).sandboxAllocation
        ).toBeNull();
      }
    );

    test('update rejects repositories for a V1 environment', async () => {
      const owner = await insertTestUser();
      mockIsFeatureFlagEnabled.mockResolvedValue(true);
      const caller = await createCallerForUser(owner.id);
      const { id } = await caller.cloudEnvironments.create({
        name: 'single',
        repository: widgets,
      });

      await expect(
        caller.cloudEnvironments.update({ environmentId: id, repositories: [widgets, api] })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await caller.cloudEnvironments.get({ environmentId: id })).toMatchObject({
        repoFullName: GITHUB_REPO,
      });
    });
  });
});
