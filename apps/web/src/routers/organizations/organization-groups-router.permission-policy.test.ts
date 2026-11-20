import {
  ai_gateway_config,
  organization_audit_logs,
  organization_group_memberships,
  organization_group_policy_settings,
  organization_groups,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { OrganizationPermissionPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { OrganizationPermissionPolicySchema } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { getOrganizationPermissionPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.server';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { createOrganizationGroup } from '@kilocode/web-shared/lib/organizations/organization-groups';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq, sql } from 'drizzle-orm';
import { rootRouter } from '@/routers/root-router';
import { createBearerCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';
import { collectCatalogLeaves, isDenylistedPath } from '@/scripts/mcp-catalog/catalog';

const createCaller = createCallerFactory(rootRouter);
const policy = {
  type: 'agent_permissions',
  data: { schema_version: 1, tools: { websearch: 'deny' } },
} satisfies OrganizationPermissionPolicy;
const denyAutoApprovePolicy = {
  type: 'agent_permissions',
  data: { schema_version: 1, auto_approve: 'deny' },
} satisfies OrganizationPermissionPolicy;
const retiredClientPolicy = {
  type: 'client_access',
  data: { schema_version: 1, mode: 'blocklist', clients: [] },
};
const modelPolicy = { type: 'model_access', data: { mode: 'none' } } as const;
const originalWriteSwitch = process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;

function largePolicy(index: number): OrganizationPermissionPolicy {
  const padding = 'x'.repeat(480);
  return {
    type: 'agent_permissions',
    data: {
      schema_version: 1,
      tools: {
        webfetch: {
          rules: Array.from({ length: 60 }, (_, rule) => ({
            pattern: `${padding}-${index}-${rule}`,
            action: 'allow' as const,
          })),
        },
      },
    },
  };
}

async function enableFor(...organizationIds: string[]) {
  const config = { organization_features: { org_permission_policy: organizationIds } };
  await db
    .insert(ai_gateway_config)
    .values({ config })
    .onConflictDoUpdate({ target: ai_gateway_config.id, set: { config } });
}

async function policyState(organizationId: string) {
  const [settings, groups, memberships, audit] = await Promise.all([
    db
      .select()
      .from(organization_group_policy_settings)
      .where(eq(organization_group_policy_settings.organization_id, organizationId)),
    db
      .select()
      .from(organization_groups)
      .where(eq(organization_groups.organization_id, organizationId))
      .orderBy(organization_groups.id),
    db
      .select()
      .from(organization_group_memberships)
      .where(eq(organization_group_memberships.organization_id, organizationId))
      .orderBy(
        organization_group_memberships.group_id,
        organization_group_memberships.kilo_user_id
      ),
    db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organizationId))
      .orderBy(organization_audit_logs.id),
  ]);
  return { settings, groups, memberships, audit };
}

describe('organization groups permission-policy administration', () => {
  let owner: User;
  let admin: User;
  let billingManager: User;
  let member: User;

  beforeAll(async () => {
    [owner, admin, billingManager, member] = await Promise.all([
      insertTestUser(),
      insertTestUser(),
      insertTestUser(),
      insertTestUser(),
    ]);
  });

  beforeEach(() => {
    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'true';
  });

  afterEach(async () => {
    if (originalWriteSwitch === undefined) delete process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;
    else process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = originalWriteSwitch;
    await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
  });

  async function fixture() {
    const { id: organizationId } = await createTestOrganization(
      'Permission policy',
      owner.id,
      0,
      {},
      false
    );
    const caller = await createSessionCallerForUser(owner.id);
    const groups = caller.organizations.groups;
    const { result: group } = await groups.create({
      organizationId,
      name: 'Engineering',
      policies: [modelPolicy],
    });
    return { groups, organizationId, groupId: group.id };
  }

  it('commits and audits default and group auto-approve writes without mutating state on invalid values', async () => {
    const { groups, organizationId, groupId } = await fixture();
    await addUserToOrganization(organizationId, admin.id, 'admin');
    await enableFor(organizationId);
    const adminCaller = await createSessionCallerForUser(admin.id);
    const adminPolicy = adminCaller.organizations.groups.adminPermissionPolicy;
    const { policyRevision: previousRevision } = await groups.getPolicySettings({ organizationId });
    const defaultPolicy = {
      ...denyAutoApprovePolicy,
      data: { ...denyAutoApprovePolicy.data, tools: policy.data.tools },
    };

    const defaultWrite = await groups.adminPermissionPolicy.set({
      organizationId,
      policy: defaultPolicy,
    });
    const groupWrite = await adminPolicy.set({
      organizationId,
      groupId,
      policy: denyAutoApprovePolicy,
    });
    expect(defaultWrite).toEqual({ result: [defaultPolicy], policyRevision: previousRevision + 1 });
    expect(groupWrite).toEqual({
      result: [denyAutoApprovePolicy],
      policyRevision: previousRevision + 2,
    });

    const committed = await policyState(organizationId);
    expect(committed.settings).toEqual([
      expect.objectContaining({
        policy_revision: groupWrite.policyRevision,
        default_policies: [expect.objectContaining({ type: 'model_access' }), defaultPolicy],
      }),
    ]);
    expect(committed.groups).toEqual([
      expect.objectContaining({ id: groupId, policies: [modelPolicy, denyAutoApprovePolicy] }),
    ]);
    await expect(
      groups.adminPermissionPolicy.diagnostics({ organizationId, userId: owner.id })
    ).resolves.toMatchObject({
      response: {
        managed: true,
        revision: groupWrite.policyRevision,
        policy: { agent_permissions: { layers: [defaultPolicy.data] } },
      },
      sources: { defaultPolicies: [defaultPolicy], groups: [] },
    });

    for (const value of ['allow', true, false, null]) {
      const invalidPolicy = {
        ...denyAutoApprovePolicy,
        data: { ...denyAutoApprovePolicy.data, auto_approve: value as never },
      };
      for (const target of [{ organizationId }, { organizationId, groupId }]) {
        await expect(
          groups.adminPermissionPolicy.set({ ...target, policy: invalidPolicy })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
    }
    expect(await policyState(organizationId)).toEqual(committed);

    const groupRemove = await adminPolicy.remove({
      organizationId,
      groupId,
      policyType: denyAutoApprovePolicy.type,
    });
    const defaultRemove = await groups.adminPermissionPolicy.remove({
      organizationId,
      policyType: defaultPolicy.type,
    });

    expect(groupRemove).toEqual({ result: [], policyRevision: previousRevision + 3 });
    expect(defaultRemove).toEqual({ result: [], policyRevision: previousRevision + 4 });
    const { settings, groups: persistedGroups, audit } = await policyState(organizationId);
    expect(settings).toEqual([
      expect.objectContaining({
        policy_revision: defaultRemove.policyRevision,
        default_policies: [expect.objectContaining({ type: 'model_access' })],
      }),
    ]);
    expect(persistedGroups).toEqual([expect.objectContaining({ policies: [modelPolicy] })]);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'organization.group.default_policy.set',
          actor_id: owner.id,
          message: `Set default agent_permissions group policy at revision ${defaultWrite.policyRevision}`,
        }),
        expect.objectContaining({
          action: 'organization.group.policy.set',
          actor_id: admin.id,
          message: `Set agent_permissions policy for group "Engineering" (${groupId}) at revision ${groupWrite.policyRevision}`,
        }),
        expect.objectContaining({
          action: 'organization.group.policy.remove',
          actor_id: admin.id,
          message: `Removed agent_permissions policy from group "Engineering" (${groupId}) at revision ${groupRemove.policyRevision}`,
        }),
        expect.objectContaining({
          action: 'organization.group.default_policy.remove',
          actor_id: owner.id,
          message: `Removed default agent_permissions group policy at revision ${defaultRemove.policyRevision}`,
        }),
      ])
    );
  });

  it('rejects new client-access writes and omits legacy entries without losing active policies', async () => {
    const { groups, organizationId, groupId } = await fixture();
    const adminPolicy = groups.adminPermissionPolicy;
    await enableFor(organizationId);
    await adminPolicy.set({ organizationId, policy });
    await groups.setMembers({ organizationId, groupId, userIds: [owner.id] });
    await db
      .update(organization_group_policy_settings)
      .set({
        default_policies: sql`default_policies || ${JSON.stringify([retiredClientPolicy])}::jsonb`,
      })
      .where(eq(organization_group_policy_settings.organization_id, organizationId));
    await db
      .update(organization_groups)
      .set({ policies: sql`${JSON.stringify([modelPolicy, retiredClientPolicy])}::jsonb` })
      .where(eq(organization_groups.id, groupId));
    const previous = await policyState(organizationId);

    for (const target of [{ organizationId }, { organizationId, groupId }]) {
      await expect(
        adminPolicy.set({ ...target, policy: retiredClientPolicy as never })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(
        adminPolicy.remove({ ...target, policyType: retiredClientPolicy.type as never })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(await policyState(organizationId)).toEqual(previous);
    await expect(adminPolicy.settings({ organizationId })).resolves.toMatchObject({
      policies: [policy],
    });
    await expect(adminPolicy.settings({ organizationId, groupId })).resolves.toMatchObject({
      policies: [],
    });
    await expect(
      adminPolicy.diagnostics({ organizationId, userId: owner.id })
    ).resolves.toMatchObject({
      response: { managed: true, policy: { agent_permissions: { layers: [policy.data] } } },
      sources: { defaultPolicies: [policy], groups: [] },
    });
    await expect(groups.get({ organizationId, groupId })).resolves.toMatchObject({
      group: { policies: [modelPolicy] },
    });

    await expect(adminPolicy.set({ organizationId, groupId, policy })).resolves.toMatchObject({
      result: [policy],
    });
    expect((await policyState(organizationId)).groups).toEqual([
      expect.objectContaining({ policies: [modelPolicy, policy] }),
    ]);
  });

  it('leaves the policy, revision and audit untouched when either rollout gate rejects a write', async () => {
    const { groups, organizationId, groupId } = await fixture();
    const previous = await policyState(organizationId);

    const disabled = {
      code: 'FORBIDDEN',
      message: 'Organization permission policy writes are disabled.',
    };
    await expect(
      groups.adminPermissionPolicy.set({ organizationId, policy })
    ).rejects.toMatchObject(disabled);
    await expect(
      createOrganizationGroup({
        organizationId,
        name: 'Internal group create',
        policies: [policy],
        permissionPolicyAdmin: true,
        actor: { id: owner.id, email: owner.google_user_email, name: owner.google_user_name },
      })
    ).rejects.toMatchObject(disabled);
    expect(await policyState(organizationId)).toEqual(previous);

    await enableFor(organizationId);
    await groups.adminPermissionPolicy.set({ organizationId, groupId, policy });
    const enabled = await policyState(organizationId);
    delete process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;

    await expect(
      groups.adminPermissionPolicy.remove({ organizationId, groupId, policyType: policy.type })
    ).rejects.toMatchObject(disabled);
    await expect(groups.delete({ organizationId, groupId })).rejects.toMatchObject(disabled);
    expect(await policyState(organizationId)).toEqual(enabled);
  });

  it('loads defaults or an unassigned group for the editor without admitting another tenant', async () => {
    const { groups, organizationId, groupId } = await fixture();
    const other = await fixture();
    await expect(groups.adminPermissionPolicy.settings({ organizationId })).resolves.toMatchObject({
      managed: false,
      writesEnabled: false,
      policies: [],
    });
    await enableFor(organizationId);
    await groups.adminPermissionPolicy.set({ organizationId, policy });
    const { policyRevision } = await groups.adminPermissionPolicy.set({
      organizationId,
      groupId,
      policy,
    });
    await expect(groups.adminPermissionPolicy.settings({ organizationId })).resolves.toEqual({
      managed: true,
      writesEnabled: true,
      policies: [policy],
      policyRevision,
    });
    await expect(
      groups.adminPermissionPolicy.settings({ organizationId, groupId })
    ).resolves.toEqual({
      managed: true,
      writesEnabled: true,
      policies: [policy],
      policyRevision,
    });
    await expect(
      groups.adminPermissionPolicy.settings({ organizationId, groupId: other.groupId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects non-Enterprise and non-management roles even with both rollout gates open', async () => {
    const { groups, organizationId } = await fixture();
    const { id: teamsOrgId } = await createTestOrganization(
      'Permission policy Teams',
      owner.id,
      0,
      {},
      true
    );
    await addUserToOrganization(organizationId, billingManager.id, 'billing_manager');
    await addUserToOrganization(organizationId, member.id, 'member');
    await enableFor(organizationId, teamsOrgId);
    const previous = await policyState(organizationId);

    await expect(
      groups.adminPermissionPolicy.set({ organizationId: teamsOrgId, policy })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Groups are available to Enterprise organizations.',
    });
    for (const user of [billingManager, member]) {
      const caller = await createSessionCallerForUser(user.id);
      await expect(
        caller.organizations.groups.adminPermissionPolicy.set({ organizationId, policy })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    expect(await policyState(organizationId)).toEqual(previous);
  });

  it('rejects personal and delegated bearers without blocking their model-only group work', async () => {
    const { groups, organizationId, groupId } = await fixture();
    await enableFor(organizationId);
    await groups.adminPermissionPolicy.set({ organizationId, groupId, policy });
    await groups.setMembers({ organizationId, groupId, userIds: [owner.id] });
    const previous = await policyState(organizationId);
    const personal = await createBearerCallerForUser(owner.id);
    const delegated = createCaller({
      user: owner,
      authViaToken: true,
      tokenSource: 'cloud-agent',
      credential: 'delegated_workload',
    });

    for (const caller of [personal, delegated]) {
      const agentGroups = caller.organizations.groups;
      const forbidden = { code: 'FORBIDDEN', message: expect.stringContaining('browser session') };
      await expect(
        agentGroups.adminPermissionPolicy.set({ organizationId, policy })
      ).rejects.toMatchObject(forbidden);
      await expect(
        agentGroups.adminPermissionPolicy.remove({
          organizationId,
          groupId,
          policyType: policy.type,
        })
      ).rejects.toMatchObject(forbidden);
      await expect(agentGroups.delete({ organizationId, groupId })).rejects.toMatchObject(
        forbidden
      );
      await expect(
        agentGroups.setMembers({ organizationId, groupId, userIds: [] })
      ).rejects.toMatchObject(forbidden);
      await expect(
        agentGroups.setMemberGroups({ organizationId, userId: owner.id, groupIds: [] })
      ).rejects.toMatchObject(forbidden);
      await expect(
        agentGroups.updateDetails({ organizationId, groupId, name: 'Rename', userIds: [] })
      ).rejects.toMatchObject(forbidden);
    }
    expect(await policyState(organizationId)).toEqual(previous);

    const agentGroups = personal.organizations.groups;
    const { result: ordinaryGroup } = await agentGroups.create({ organizationId, name: 'Other' });
    await expect(
      agentGroups.setMemberGroups({
        organizationId,
        userId: owner.id,
        groupIds: [groupId, ordinaryGroup.id],
      })
    ).resolves.toMatchObject({ result: [groupId, ordinaryGroup.id] });
    await expect(
      agentGroups.setMemberGroups({
        organizationId,
        userId: owner.id,
        groupIds: [ordinaryGroup.id],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      agentGroups.delete({ organizationId, groupId: ordinaryGroup.id })
    ).resolves.toMatchObject({ result: ordinaryGroup.id });
    await expect(
      groups.setMemberGroups({ organizationId, userId: owner.id, groupIds: [] })
    ).resolves.toMatchObject({ result: [] });
  });

  it('keeps legacy router inputs and outputs model-only while preserving mixed policy arrays', async () => {
    const { groups, organizationId, groupId } = await fixture();
    await enableFor(organizationId);
    await groups.adminPermissionPolicy.set({ organizationId, policy });
    await groups.adminPermissionPolicy.set({ organizationId, groupId, policy });
    const previous = await policyState(organizationId);
    const badRequest = { code: 'BAD_REQUEST' };

    await expect(
      groups.create({ organizationId, name: 'Invalid', policies: [policy as never] })
    ).rejects.toMatchObject(badRequest);
    await expect(
      groups.setPolicy({ organizationId, groupId, policy: policy as never })
    ).rejects.toMatchObject(badRequest);
    await expect(
      groups.setDefaultPolicy({ organizationId, policy: policy as never })
    ).rejects.toMatchObject(badRequest);
    await expect(
      groups.removePolicy({ organizationId, groupId, policyType: policy.type as never })
    ).rejects.toMatchObject(badRequest);
    await expect(
      groups.removeDefaultPolicy({ organizationId, policyType: policy.type as never })
    ).rejects.toMatchObject(badRequest);
    await expect(
      groups.getPolicyEditorData({ organizationId, policyType: policy.type as never })
    ).rejects.toMatchObject(badRequest);
    expect(await policyState(organizationId)).toEqual(previous);

    delete process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;
    await expect(groups.list({ organizationId })).resolves.toMatchObject({
      groups: [{ id: groupId, policies: [modelPolicy] }],
    });
    await expect(groups.get({ organizationId, groupId })).resolves.toMatchObject({
      group: { policies: [modelPolicy] },
    });
    await expect(
      groups.updateMetadata({ organizationId, groupId, name: 'Renamed' })
    ).resolves.toMatchObject({ result: { policies: [modelPolicy] } });
    await expect(
      groups.updateDetails({ organizationId, groupId, name: 'Renamed', userIds: [] })
    ).resolves.toMatchObject({ result: { policies: [modelPolicy] } });
    await expect(
      groups.setDefaultPolicy({ organizationId, policy: modelPolicy })
    ).resolves.toMatchObject({ result: [modelPolicy] });
    await expect(groups.getPolicySettings({ organizationId })).resolves.toMatchObject({
      defaultPolicies: [modelPolicy],
    });
    await expect(
      groups.setPolicy({ organizationId, groupId, policy: modelPolicy })
    ).resolves.toMatchObject({ result: [modelPolicy] });
    await expect(
      groups.removePolicy({ organizationId, groupId, policyType: modelPolicy.type })
    ).resolves.toMatchObject({ result: [] });
    await expect(
      groups.removeDefaultPolicy({ organizationId, policyType: modelPolicy.type })
    ).resolves.toMatchObject({ result: [] });

    const state = await policyState(organizationId);
    expect(state.settings).toMatchObject([{ default_policies: [policy] }]);
    expect(state.groups).toMatchObject([{ policies: [policy] }]);
  });

  it('limits source diagnostics to privileged sessions and a selected direct member of the same organization', async () => {
    const { groups, organizationId, groupId } = await fixture();
    await addUserToOrganization(organizationId, billingManager.id, 'billing_manager');
    await addUserToOrganization(organizationId, member.id, 'member');
    await enableFor(organizationId);
    await groups.adminPermissionPolicy.set({ organizationId, policy: denyAutoApprovePolicy });
    await groups.adminPermissionPolicy.set({ organizationId, groupId, policy });
    await groups.setMembers({ organizationId, groupId, userIds: [member.id] });
    const billing = await createSessionCallerForUser(billingManager.id);
    const ordinary = await createSessionCallerForUser(member.id);
    const bearer = await createBearerCallerForUser(owner.id);
    const input = { organizationId, userId: member.id };

    await expect(
      billing.organizations.groups.adminPermissionPolicy.diagnostics(input)
    ).resolves.toMatchObject({
      response: {
        organization_id: organizationId,
        managed: true,
        policy: { agent_permissions: { layers: [denyAutoApprovePolicy.data, policy.data] } },
      },
      sources: {
        defaultPolicies: [denyAutoApprovePolicy],
        groups: [{ groupId, policies: [policy] }],
      },
    });
    await expect(
      groups.adminPermissionPolicy.diagnostics({ organizationId, userId: admin.id })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      ordinary.organizations.groups.adminPermissionPolicy.diagnostics(input)
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      bearer.organizations.groups.adminPermissionPolicy.diagnostics(input)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('normalizes member group assignments to canonical lowercase UUIDs', async () => {
    const { groups, organizationId, groupId } = await fixture();

    await expect(
      groups.setMemberGroups({
        organizationId,
        userId: owner.id,
        groupIds: [groupId.toUpperCase()],
      })
    ).resolves.toMatchObject({ result: [groupId] });
  });

  it('deduplicates identical stored layers so a valid configuration is still served', async () => {
    const { organizationId } = await fixture();
    await enableFor(organizationId);
    const large = largePolicy(1);
    expect(OrganizationPermissionPolicySchema.safeParse(large).success).toBe(true);
    const created = await db
      .insert(organization_groups)
      .values(
        Array.from({ length: 9 }, (_, index) => ({
          organization_id: organizationId,
          name: `Large ${index}`,
          policies: [large],
        }))
      )
      .returning({ id: organization_groups.id });
    await db.insert(organization_group_memberships).values(
      created.map(group => ({
        organization_id: organizationId,
        group_id: group.id,
        kilo_user_id: owner.id,
        assigned_by_kilo_user_id: owner.id,
      }))
    );

    const { response } = await getOrganizationPermissionPolicy(organizationId, owner.id);
    if (!response.managed) throw new Error('Expected a managed policy response');
    expect(response.policy.agent_permissions?.layers).toEqual([large.data]);
  });

  it('rejects a permission-policy write that would make the member payload unservable', async () => {
    const { groups, organizationId } = await fixture();
    await enableFor(organizationId);
    const { result: target } = await groups.create({ organizationId, name: 'Target' });
    await db.insert(organization_groups).values(
      Array.from({ length: 8 }, (_, index) => ({
        organization_id: organizationId,
        name: `Budget ${index}`,
        policies: [largePolicy(index)],
      }))
    );
    const previous = await policyState(organizationId);

    await expect(
      groups.adminPermissionPolicy.set({
        organizationId,
        groupId: target.id,
        policy: largePolicy(9),
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('maximum size'),
    });
    expect(await policyState(organizationId)).toEqual(previous);
  });

  it('keeps dedicated permission-policy operations out of the agent-facing MCP catalog', () => {
    const paths = collectCatalogLeaves(rootRouter).map(({ path }) => path);
    const prefix = 'organizations.groups.adminPermissionPolicy';
    for (const path of [`${prefix}.set`, `${prefix}.remove`, `${prefix}.diagnostics`]) {
      expect(paths).toContain(path);
      expect(isDenylistedPath(path)).toBe(true);
    }
    expect(isDenylistedPath('organizations.groups.setPolicy')).toBe(false);
  });
});
