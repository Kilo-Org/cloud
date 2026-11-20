import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  ai_gateway_config,
  organization_audit_logs,
  organization_default_policy_links,
  organization_group_memberships,
  organization_group_policy_links,
  organization_group_policy_settings,
  organization_groups,
  organization_memberships,
  organization_named_policies,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { NamedPolicyDocumentSchema } from './named-policy.schema';
import {
  createNamedOrganizationPolicy,
  deleteNamedOrganizationPolicy,
  getNamedPolicyMemberSnapshot,
  listNamedOrganizationPolicies,
  setNamedOrganizationPolicyLink,
  updateNamedOrganizationPolicy,
} from './named-policy.server';
import { getOrganizationPermissionPolicy } from './permission-policy.server';

const owner = 'named-policy-owner';
const member = 'named-policy-member';
const billingManager = 'named-policy-billing';
const defaultScope = { type: 'default' } as const;
const agentPermissions = {
  kind: 'agent_permissions',
  document: { tools: { websearch: 'deny' } },
} as const;
const clientConfiguration = {
  kind: 'client_configuration',
  document: { disable_auto_approve: true, disable_telemetry: false },
} as const;
const originalWriteSwitch = process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;

async function createOrganization(plan: 'enterprise' | 'teams' = 'enterprise') {
  const [{ id: organizationId }] = await db
    .insert(organizations)
    .values({ name: 'Policy test organization', plan })
    .returning({ id: organizations.id });
  await db.insert(organization_memberships).values([
    { organization_id: organizationId, kilo_user_id: owner, role: 'owner' },
    { organization_id: organizationId, kilo_user_id: member, role: 'member' },
    { organization_id: organizationId, kilo_user_id: billingManager, role: 'billing_manager' },
  ]);
  return { organizationId, actor: { id: owner, isBrowserSession: true } };
}

async function enableFor(...ids: string[]) {
  const config = { organization_features: { org_permission_policy: ids } };
  await db.insert(ai_gateway_config).values({ config }).onConflictDoUpdate({
    target: ai_gateway_config.id,
    set: { config },
  });
}

async function createGroup(organizationId: string, name: string) {
  const [group] = await db
    .insert(organization_groups)
    .values({ organization_id: organizationId, name })
    .returning();
  return { type: 'group', groupId: group.id } as const;
}

async function namedAudit(organizationId: string) {
  return await db
    .select()
    .from(organization_audit_logs)
    .where(
      and(
        eq(organization_audit_logs.organization_id, organizationId),
        eq(organization_audit_logs.action, 'organization.named_policy.change')
      )
    );
}

describe('named policy JSON', () => {
  it.each([
    { ...agentPermissions, document: { auto_approve: 'deny' } },
    { ...agentPermissions, document: { schema_version: 1 } },
    { ...agentPermissions, document: { type: 'agent_permissions', data: {} } },
    { ...agentPermissions, document: { by_os: { other: {} } } },
    { ...agentPermissions, document: { by_os: { linux: { by_os: {} } } } },
    { ...agentPermissions, document: { shell: { bash: { fallback: 'allow', rules: [] } } } },
    { ...clientConfiguration, document: { show_session_dollar_values: false } },
    { ...clientConfiguration, document: { disable_telemetry: null } },
    { ...clientConfiguration, document: { by_os: { windows: {} } } },
  ])('rejects invalid named policy JSON %#', input => {
    expect(NamedPolicyDocumentSchema.safeParse(input).success).toBe(false);
  });
});

describe('named organization policy storage', () => {
  beforeEach(() => {
    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'true';
  });

  afterEach(async () => {
    if (originalWriteSwitch === undefined) delete process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;
    else process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = originalWriteSwitch;
    await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
  });

  it('commits lifecycle and audit, reuses linked policies, keeps unlinked records inert and preserves embedded reads', async () => {
    const access = await createOrganization();
    const { organizationId } = access;
    const [firstGroup, secondGroup] = await Promise.all([
      createGroup(organizationId, 'First'),
      createGroup(organizationId, 'Second'),
    ]);
    await enableFor(organizationId);
    const input = { organizationId, kiloUserId: member };
    const legacy = await getOrganizationPermissionPolicy(organizationId, member);
    const agent = await createNamedOrganizationPolicy(access, {
      ...agentPermissions,
      name: '  Agent permissions  ',
      document: {
        ...agentPermissions.document,
        by_os: { windows: { tools: { browser_open: 'deny' } } },
      },
    });
    expect(agent).toMatchObject({
      result: { name: 'Agent permissions', schema_version: 1 },
      policyRevision: 1,
    });
    await expect(getNamedPolicyMemberSnapshot(input)).resolves.toEqual({
      managed: true,
      policyRevision: 1,
      policy: {},
    });
    const config = await createNamedOrganizationPolicy(access, {
      ...clientConfiguration,
      name: 'Configuration',
    });
    const neutral = await createNamedOrganizationPolicy(access, {
      ...clientConfiguration,
      name: 'Neutral',
      document: { disable_auto_approve: false },
    });
    await setNamedOrganizationPolicyLink(access, {
      scope: defaultScope,
      kind: 'agent_permissions',
      policyId: agent.result.id,
    });
    await setNamedOrganizationPolicyLink(access, {
      scope: firstGroup,
      kind: 'agent_permissions',
      policyId: agent.result.id,
    });
    await setNamedOrganizationPolicyLink(access, {
      scope: firstGroup,
      kind: 'client_configuration',
      policyId: config.result.id,
    });
    await setNamedOrganizationPolicyLink(access, {
      scope: secondGroup,
      kind: 'client_configuration',
      policyId: config.result.id,
    });
    await setNamedOrganizationPolicyLink(access, {
      scope: defaultScope,
      kind: 'client_configuration',
      policyId: neutral.result.id,
    });

    await expect(getNamedPolicyMemberSnapshot(input)).resolves.toMatchObject({
      policy: {
        agent_permissions: { layers: [{ schema_version: 1, tools: { websearch: 'deny' } }] },
      },
    });
    await db.insert(organization_group_memberships).values({
      organization_id: organizationId,
      group_id: firstGroup.groupId,
      kilo_user_id: member,
    });
    const result = await getNamedPolicyMemberSnapshot({ ...input, executionOs: 'windows' });
    expect(result.policy).toEqual({
      agent_permissions: {
        layers: [
          { schema_version: 1, tools: { websearch: 'deny' } },
          { schema_version: 1, tools: { browser_open: 'deny' } },
        ],
      },
      client_configuration: { disable_auto_approve: true },
    });
    expect(await getOrganizationPermissionPolicy(organizationId, member)).toMatchObject({
      response: { policy: legacy.response.policy, revision: result.policyRevision },
      sources: legacy.sources,
    });
    const view = await listNamedOrganizationPolicies({
      ...access,
      actor: { ...access.actor, id: billingManager },
    });
    expect(view.policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: agent.result.id, attachments: [defaultScope, firstGroup] }),
        expect.objectContaining({
          id: config.result.id,
          attachments: expect.arrayContaining([firstGroup, secondGroup]),
        }),
      ])
    );
    await expect(deleteNamedOrganizationPolicy(access, agent.result.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const renamed = await updateNamedOrganizationPolicy(access, agent.result.id, {
      name: 'Agent baseline',
    });
    expect(renamed).toMatchObject({
      result: { id: agent.result.id, name: 'Agent baseline', kind: 'agent_permissions' },
      policyRevision: result.policyRevision + 1,
    });
    expect(await namedAudit(organizationId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_id: owner,
          message: `Created agent_permissions policy ${agent.result.id} at revision 1`,
        }),
        expect.objectContaining({
          actor_id: owner,
          message: `Updated agent_permissions policy ${agent.result.id} at revision ${renamed.policyRevision}`,
        }),
      ])
    );
    await setNamedOrganizationPolicyLink(access, {
      scope: defaultScope,
      kind: 'client_configuration',
      policyId: null,
    });
    await expect(deleteNamedOrganizationPolicy(access, neutral.result.id)).resolves.toMatchObject({
      result: neutral.result.id,
    });
    await expect(
      getNamedPolicyMemberSnapshot({ ...input, kiloUserId: 'outsider' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects unauthorized, disabled, invalid and duplicate writes without revision or audit changes', async () => {
    const access = await createOrganization();
    const ineligible = await createOrganization('teams');
    const { organizationId } = access;
    const input = { ...agentPermissions, name: 'Baseline' };
    await expect(createNamedOrganizationPolicy(access, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await enableFor(organizationId, ineligible.organizationId);
    await expect(createNamedOrganizationPolicy(ineligible, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      createNamedOrganizationPolicy(
        { ...access, actor: { id: owner, isBrowserSession: false } },
        input
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const id of [member, billingManager, 'outsider']) {
      await expect(
        createNamedOrganizationPolicy({ ...access, actor: { id, isBrowserSession: true } }, input)
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(
      listNamedOrganizationPolicies({ ...access, actor: { id: member, isBrowserSession: true } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'false';
    await expect(createNamedOrganizationPolicy(access, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'true';
    const { result: policy } = await createNamedOrganizationPolicy(access, input);
    await expect(
      createNamedOrganizationPolicy(access, { ...clientConfiguration, name: ' baseline ' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const attempt = { kind: 'client_configuration', name: 'Baseline 2' };
    await expect(updateNamedOrganizationPolicy(access, policy.id, attempt)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      createNamedOrganizationPolicy(access, {
        ...input,
        name: 'Invalid',
        document: { auto_approve: 'deny' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const before = await listNamedOrganizationPolicies(access);
    expect(before).toMatchObject({
      policyRevision: 1,
      policies: [expect.objectContaining({ id: policy.id, name: 'Baseline' })],
    });
    expect(await namedAudit(organizationId)).toHaveLength(1);
    await enableFor();
    await expect(
      getNamedPolicyMemberSnapshot({ organizationId, kiloUserId: owner })
    ).resolves.toEqual({ managed: false, policyRevision: 1, policy: {} });
  });

  it('enforces scope cardinality, tenant and kind constraints, and required FK deletion semantics in PostgreSQL', async () => {
    const access = await createOrganization();
    const foreign = await createOrganization();
    const { organizationId } = access;
    const group = await createGroup(organizationId, 'Group');
    const foreignGroup = await createGroup(foreign.organizationId, 'Foreign group');
    await enableFor(organizationId, foreign.organizationId);
    const localPolicy = await createNamedOrganizationPolicy(access, {
      ...agentPermissions,
      name: 'Local',
    });
    const foreignPolicy = await createNamedOrganizationPolicy(foreign, {
      ...agentPermissions,
      name: 'Foreign',
    });
    const values = {
      organization_id: organizationId,
      kind: 'agent_permissions',
      policy_id: localPolicy.result.id,
    } as const;
    await expect(
      setNamedOrganizationPolicyLink(access, {
        scope: foreignGroup,
        kind: values.kind,
        policyId: values.policy_id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      setNamedOrganizationPolicyLink(access, {
        scope: group,
        kind: values.kind,
        policyId: foreignPolicy.result.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      setNamedOrganizationPolicyLink(access, {
        scope: defaultScope,
        kind: 'client_configuration',
        policyId: values.policy_id,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      db
        .insert(organization_default_policy_links)
        .values({ ...values, kind: 'client_configuration' })
    ).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(
      db
        .insert(organization_default_policy_links)
        .values({ ...values, policy_id: foreignPolicy.result.id })
    ).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(
      db
        .insert(organization_group_policy_links)
        .values({ ...values, group_id: foreignGroup.groupId })
    ).rejects.toMatchObject({ cause: { code: '23503' } });
    const groupValues = { ...values, group_id: group.groupId };
    await db.insert(organization_default_policy_links).values(values);
    await db.insert(organization_group_policy_links).values(groupValues);
    await expect(db.insert(organization_default_policy_links).values(values)).rejects.toMatchObject(
      { cause: { code: '23505' } }
    );
    await expect(
      db.insert(organization_group_policy_links).values(groupValues)
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(
      db
        .delete(organization_named_policies)
        .where(eq(organization_named_policies.id, values.policy_id))
    ).rejects.toMatchObject({ cause: { code: '23503' } });
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await expect(
      db
        .select()
        .from(organization_group_policy_links)
        .where(eq(organization_group_policy_links.organization_id, organizationId))
    ).resolves.toEqual([]);
    await expect(
      db
        .select()
        .from(organization_named_policies)
        .where(
          inArray(organization_named_policies.organization_id, [
            organizationId,
            foreign.organizationId,
          ])
        )
    ).resolves.toEqual([expect.objectContaining({ id: foreignPolicy.result.id })]);
  });

  it('rejects a shared content edit beyond the OS-specific budget and rolls back document, revision and audit', async () => {
    const access = await createOrganization();
    const { organizationId } = access;
    await enableFor(organizationId);
    function largeDocument(index: number) {
      return {
        by_os: {
          windows: {
            tools: {
              websearch: {
                rules: Array.from({ length: 61 }, (_, rule) => ({
                  pattern: `${'x'.repeat(480)}-${index}-${rule}`,
                  action: 'deny',
                })),
              },
            },
          },
        },
      };
    }
    const { result: shared } = await createNamedOrganizationPolicy(access, {
      ...agentPermissions,
      name: 'Shared',
    });
    for (let index = 0; index < 8; index++) {
      const scope = await createGroup(organizationId, `Group ${index}`);
      const { result: policy } = await createNamedOrganizationPolicy(access, {
        ...agentPermissions,
        name: `Large ${index}`,
        document: largeDocument(index),
      });
      await setNamedOrganizationPolicyLink(access, {
        scope,
        kind: 'agent_permissions',
        policyId: policy.id,
      });
    }
    const reuse = await createGroup(organizationId, 'Reuses the default');
    await setNamedOrganizationPolicyLink(access, {
      scope: reuse,
      kind: 'agent_permissions',
      policyId: shared.id,
    });
    await setNamedOrganizationPolicyLink(access, {
      scope: defaultScope,
      kind: 'agent_permissions',
      policyId: shared.id,
    });
    const before = await listNamedOrganizationPolicies(access);
    const audit = await namedAudit(organizationId);
    await expect(
      updateNamedOrganizationPolicy(access, shared.id, { document: largeDocument(8) })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('size limit'),
    });
    expect(await listNamedOrganizationPolicies(access)).toEqual(before);
    expect(await namedAudit(organizationId)).toEqual(audit);
  });

  it('does not mix revision or memberships with a concurrent link change', async () => {
    const access = await createOrganization();
    const { organizationId } = access;
    await enableFor(organizationId);
    const scope = await createGroup(organizationId, 'Concurrent group');
    const { result: policy } = await createNamedOrganizationPolicy(access, {
      ...agentPermissions,
      name: 'Linked policy',
    });
    const { policyRevision } = await setNamedOrganizationPolicyLink(access, {
      scope,
      kind: 'agent_permissions',
      policyId: policy.id,
    });
    await db
      .insert(organization_group_memberships)
      .values({ organization_id: organizationId, group_id: scope.groupId, kilo_user_id: member });
    const hold = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const writer = db.transaction(async tx => {
      await tx.execute(sql`LOCK TABLE ${organization_group_policy_links} IN ACCESS EXCLUSIVE MODE`);
      await tx
        .delete(organization_group_policy_links)
        .where(eq(organization_group_policy_links.group_id, scope.groupId));
      await tx
        .delete(organization_group_memberships)
        .where(eq(organization_group_memberships.group_id, scope.groupId));
      await tx
        .update(organization_group_policy_settings)
        .set({ policy_revision: policyRevision + 1 })
        .where(eq(organization_group_policy_settings.organization_id, organizationId));
      const result = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      hold.resolve(result.rows[0].pid);
      await release.promise;
    });
    const holderPid = await Promise.race([
      hold.promise,
      writer.then(() => {
        throw new Error('Writer finished before holding lock.');
      }),
    ]);
    const input = { organizationId, kiloUserId: member };
    const reading = getNamedPolicyMemberSnapshot(input);
    try {
      let blocked = false;
      for (let i = 0; i < 2000 && !blocked; i++) {
        const waiting = await db.execute(sql`
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND ${holderPid} = ANY(pg_blocking_pids(pid))
        `);
        blocked = waiting.rows.length > 0;
      }
      expect(blocked).toBe(true);
    } finally {
      release.resolve();
      await writer;
      await reading;
    }
    await expect(reading).resolves.toEqual({
      managed: true,
      policyRevision,
      policy: {
        agent_permissions: { layers: [{ schema_version: 1, ...agentPermissions.document }] },
      },
    });
    await expect(getNamedPolicyMemberSnapshot(input)).resolves.toEqual({
      managed: true,
      policyRevision: policyRevision + 1,
      policy: {},
    });
  }, 20_000);
});
