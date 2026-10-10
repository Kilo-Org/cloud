import { afterEach, describe, expect, test } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
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
import { MASKED_SECRET_VALUE } from '@kilocode/cloud-agent-profile';

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
  afterEach(cleanupDbForTest);

  test('a member can list but cannot create, while owner and admin can create', async () => {
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
      repository: { platform: 'github', fullName: GITHUB_REPO },
    });
    expect(adminCreated.id).toBeDefined();

    const nonMemberCaller = await createCallerForUser(nonMember.id);
    await expect(
      nonMemberCaller.cloudEnvironments.list({
        organizationId: organization.id,
        repository: { platform: 'github', fullName: GITHUB_REPO },
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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

  test('rejects a duplicate name with CONFLICT on create and on rename', async () => {
    const owner = await insertTestUser();
    const caller = await createCallerForUser(owner.id);
    const repository = { platform: 'github' as const, fullName: GITHUB_REPO };

    await caller.cloudEnvironments.create({ name: 'first', repository });
    await expect(
      caller.cloudEnvironments.create({ name: 'first', repository })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'An environment with this name already exists for this repository.',
    });

    const { id: secondId } = await caller.cloudEnvironments.create({ name: 'second', repository });
    await expect(
      caller.cloudEnvironments.update({ environmentId: secondId, name: 'first' })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'An environment with this name already exists for this repository.',
    });
    const second = await caller.cloudEnvironments.get({ environmentId: secondId });
    expect(second.name).toBe('second');
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
});
