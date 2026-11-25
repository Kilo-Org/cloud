import {
  ai_gateway_config,
  organization_audit_logs,
  organization_group_memberships,
  organization_group_policy_settings,
  organization_named_policies,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import { createBearerCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';

const agentDoc = {
  tools: { browser_open: 'ask' },
  by_os: { windows: { tools: { browser_open: 'deny' } } },
};
const configDoc = { disable_telemetry: true, hide_session_dollar_values: true };
const modelPolicy = { type: 'model_access', data: { mode: 'none' } } as const;
const originalWriteSwitch = process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;

async function enableFor(...organizationIds: string[]) {
  const config = { organization_features: { org_permission_policy: organizationIds } };
  await db
    .insert(ai_gateway_config)
    .values({ config })
    .onConflictDoUpdate({ target: ai_gateway_config.id, set: { config } });
}

async function revision(organizationId: string) {
  const [settings] = await db
    .select({ revision: organization_group_policy_settings.policy_revision })
    .from(organization_group_policy_settings)
    .where(eq(organization_group_policy_settings.organization_id, organizationId));
  return settings?.revision ?? 0;
}

async function auditCount(organizationId: string) {
  const rows = await db
    .select({ id: organization_audit_logs.id })
    .from(organization_audit_logs)
    .where(eq(organization_audit_logs.organization_id, organizationId));
  return rows.length;
}

describe('organization groups named-permission administration', () => {
  let owner: User;
  let billingManager: User;
  let member: User;

  beforeAll(async () => {
    [owner, billingManager, member] = await Promise.all([
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
    const { id: organizationId } = await createTestOrganization('Named', owner.id, 0, {}, false);
    const caller = await createSessionCallerForUser(owner.id);
    const { result: firstGroup } = await caller.organizations.groups.create({
      organizationId,
      name: 'First',
      policies: [modelPolicy],
    });
    const { result: secondGroup } = await caller.organizations.groups.create({
      organizationId,
      name: 'Second',
      policies: [modelPolicy],
    });
    await addUserToOrganization(organizationId, billingManager.id, 'billing_manager');
    await addUserToOrganization(organizationId, member.id, 'member');
    await enableFor(organizationId);
    return {
      caller,
      organizationId,
      firstGroupId: firstGroup.id,
      secondGroupId: secondGroup.id,
      admin: caller.organizations.groups.adminPermissionPolicy,
    };
  }

  it('creates, links, reuses, edits, and unlinks named policies with revision and audit', async () => {
    const { caller, organizationId, firstGroupId, secondGroupId, admin } = await fixture();
    await expect(admin.list({ organizationId })).resolves.toMatchObject({
      managed: true,
      policies: [],
    });

    const baseRevision = await revision(organizationId);
    const agent = await admin.create({
      organizationId,
      kind: 'agent_permissions',
      name: 'Agent',
      document: agentDoc,
    });
    const config = await admin.create({
      organizationId,
      kind: 'client_configuration',
      name: 'Config',
      document: configDoc,
    });
    const unlinked = await admin.create({
      organizationId,
      kind: 'agent_permissions',
      name: 'Unused',
      document: { tools: { websearch: 'deny' } },
    });
    expect(agent.policyRevision).toBe(baseRevision + 1);
    expect(config.policyRevision).toBe(baseRevision + 2);

    await admin.setLink({
      organizationId,
      scope: { type: 'default' },
      kind: 'agent_permissions',
      policyId: agent.result.id,
    });
    await admin.setLink({
      organizationId,
      scope: { type: 'group', groupId: firstGroupId },
      kind: 'agent_permissions',
      policyId: agent.result.id,
    });
    await admin.setLink({
      organizationId,
      scope: { type: 'group', groupId: secondGroupId },
      kind: 'agent_permissions',
      policyId: agent.result.id,
    });
    await admin.setLink({
      organizationId,
      scope: { type: 'group', groupId: firstGroupId },
      kind: 'client_configuration',
      policyId: config.result.id,
    });

    const listed = await admin.list({ organizationId });
    expect(listed.policies.find(p => p.id === agent.result.id)?.attachments).toEqual(
      expect.arrayContaining([
        { type: 'default' },
        { type: 'group', groupId: firstGroupId },
        { type: 'group', groupId: secondGroupId },
      ])
    );
    expect(listed.policies.find(p => p.id === unlinked.result.id)?.attachments).toEqual([]);

    await db.insert(organization_group_memberships).values({
      organization_id: organizationId,
      group_id: firstGroupId,
      kilo_user_id: member.id,
    });
    const diagnostics = await admin.diagnostics({
      organizationId,
      userId: member.id,
      executionOs: 'windows',
    });
    expect(diagnostics.response.policy).toMatchObject({
      agent_permissions: {
        layers: [
          { schema_version: 1, tools: { browser_open: 'ask' } },
          { schema_version: 1, tools: { browser_open: 'deny' } },
        ],
      },
      client_configuration: { disable_telemetry: true, hide_session_dollar_values: true },
    });
    expect(diagnostics.response.policy.agent_permissions?.layers).not.toContainEqual(
      expect.objectContaining({ tools: { websearch: 'deny' } })
    );

    const updated = await admin.update({
      organizationId,
      policyId: agent.result.id,
      document: { tools: { browser_open: 'deny' } },
    });
    expect(updated.result.document).toEqual({ tools: { browser_open: 'deny' } });
    const afterEdit = await admin.diagnostics({ organizationId, userId: member.id });
    expect(afterEdit.response.policy.agent_permissions).toEqual({
      layers: [{ schema_version: 1, tools: { browser_open: 'deny' } }],
    });

    await expect(admin.delete({ organizationId, policyId: agent.result.id })).rejects.toMatchObject(
      { code: 'CONFLICT' }
    );
    await admin.setLink({
      organizationId,
      scope: { type: 'default' },
      kind: 'agent_permissions',
      policyId: null,
    });
    await admin.setLink({
      organizationId,
      scope: { type: 'group', groupId: firstGroupId },
      kind: 'agent_permissions',
      policyId: null,
    });
    await admin.setLink({
      organizationId,
      scope: { type: 'group', groupId: secondGroupId },
      kind: 'agent_permissions',
      policyId: null,
    });
    await expect(
      admin.delete({ organizationId, policyId: agent.result.id })
    ).resolves.toMatchObject({ result: agent.result.id });

    expect(await revision(organizationId)).toBeGreaterThan(2);
    expect(await auditCount(organizationId)).toBeGreaterThan(0);
    const settings = await caller.organizations.groups.getPolicySettings({ organizationId });
    expect(settings.defaultPolicies.every(policy => policy.type === 'model_access')).toBe(true);
  });

  it('rejects kind mismatches, duplicate names, and invalid documents without mutating state', async () => {
    const { organizationId, firstGroupId, admin } = await fixture();
    const agent = await admin.create({
      organizationId,
      kind: 'agent_permissions',
      name: 'Agent',
      document: agentDoc,
    });
    const beforeRevision = await revision(organizationId);
    const beforeAudit = await auditCount(organizationId);

    await expect(
      admin.create({ organizationId, kind: 'agent_permissions', name: ' agent ', document: {} })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      admin.create({
        organizationId,
        kind: 'agent_permissions',
        name: 'Bad',
        document: { by_os: { other: {} } },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      admin.create({
        organizationId,
        kind: 'client_configuration',
        name: 'Old',
        document: { show_session_dollar_values: true },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      admin.setLink({
        organizationId,
        scope: { type: 'group', groupId: firstGroupId },
        kind: 'client_configuration',
        policyId: agent.result.id,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      admin.update({
        organizationId,
        policyId: agent.result.id,
        document: { disable_telemetry: true },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await revision(organizationId)).toBe(beforeRevision);
    expect(await auditCount(organizationId)).toBe(beforeAudit);
  });

  it('enforces browser-session roles and Enterprise gating', async () => {
    const { organizationId, admin } = await fixture();
    await admin.create({
      organizationId,
      kind: 'agent_permissions',
      name: 'Agent',
      document: agentDoc,
    });

    const bearer = await createBearerCallerForUser(owner.id);
    await expect(
      bearer.organizations.groups.adminPermissionPolicy.list({ organizationId })
    ).rejects.toThrow();

    const billing = await createSessionCallerForUser(billingManager.id);
    await expect(
      billing.organizations.groups.adminPermissionPolicy.list({ organizationId })
    ).resolves.toMatchObject({ managed: true });
    await expect(
      billing.organizations.groups.adminPermissionPolicy.create({
        organizationId,
        kind: 'agent_permissions',
        name: 'B',
        document: {},
      })
    ).rejects.toThrow();

    const ordinary = await createSessionCallerForUser(member.id);
    await expect(
      ordinary.organizations.groups.adminPermissionPolicy.list({ organizationId })
    ).rejects.toThrow();

    const nonEnterprise = await createTestOrganization('Teams', owner.id, 0, {}, true);
    const ownerCaller = await createSessionCallerForUser(owner.id);
    await expect(
      ownerCaller.organizations.groups.adminPermissionPolicy.list({
        organizationId: nonEnterprise.id,
      })
    ).rejects.toThrow();
  });

  it('isolates tenants and keeps Model Access administration unchanged', async () => {
    const first = await fixture();
    const second = await fixture();
    await enableFor(first.organizationId, second.organizationId);
    const created = await first.admin.create({
      organizationId: first.organizationId,
      kind: 'agent_permissions',
      name: 'Agent',
      document: agentDoc,
    });

    await expect(
      second.admin.setLink({
        organizationId: second.organizationId,
        scope: { type: 'default' },
        kind: 'agent_permissions',
        policyId: created.result.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      second.admin.update({
        organizationId: second.organizationId,
        policyId: created.result.id,
        name: 'X',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await second.admin.list({ organizationId: second.organizationId })).policies).toEqual(
      []
    );

    const modelOnly = await first.caller.organizations.groups.setPolicy({
      organizationId: first.organizationId,
      groupId: first.firstGroupId,
      policy: modelPolicy,
    });
    expect(modelOnly.result).toEqual([modelPolicy]);
    expect(
      (await first.admin.list({ organizationId: first.organizationId })).policies
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(organization_named_policies)
        .where(eq(organization_named_policies.organization_id, first.organizationId))
    ).toHaveLength(1);
  });
});
