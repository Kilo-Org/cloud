import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  ai_gateway_config,
  kilocode_users,
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
import {
  deleteOrganizationGroup,
  setOrganizationGroupMembers,
  setOrganizationMemberGroups,
  updateOrganizationGroupDetails,
  withOrganizationGroupPolicyMutation,
} from '@kilocode/web-shared/lib/organizations/organization-groups';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq, inArray, sql } from 'drizzle-orm';

const browserSessionRequired = {
  code: 'FORBIDDEN',
  message: 'Use a browser session to change organization permission policy.',
};
const writesDisabled = {
  code: 'FORBIDDEN',
  message: 'Organization permission policy writes are disabled.',
};
const originalWriteSwitch = process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;

async function seedFixture() {
  return await db.transaction(async tx => {
    const organizationId = `a${crypto.randomUUID().slice(1)}`;
    await tx.insert(organizations).values({
      id: organizationId,
      name: 'Named policy group guard',
      plan: 'enterprise',
    });
    const [admin, member] = await tx
      .insert(kilocode_users)
      .values([defineTestUser(), defineTestUser()])
      .returning();
    const actor = { id: admin.id, email: admin.google_user_email, name: admin.google_user_name };
    await tx.insert(organization_memberships).values([
      { organization_id: organizationId, kilo_user_id: actor.id, role: 'admin' },
      { organization_id: organizationId, kilo_user_id: member.id, role: 'member' },
    ]);
    const [linked, otherLinked, unlinked] = await tx
      .insert(organization_groups)
      .values([
        {
          organization_id: organizationId,
          name: 'Restricted',
          policies: [{ type: 'model_access', data: { mode: 'none' } }],
        },
        { organization_id: organizationId, name: 'Also restricted' },
        { organization_id: organizationId, name: 'Unlinked' },
      ])
      .returning();
    await tx.insert(organization_group_memberships).values({
      organization_id: organizationId,
      group_id: linked.id,
      kilo_user_id: member.id,
    });
    const [agentPolicy, clientPolicy] = await tx
      .insert(organization_named_policies)
      .values([
        {
          organization_id: organizationId,
          kind: 'agent_permissions',
          name: 'Private agent tool policy',
          schema_version: 1,
          document: { tools: { private_tool_rule: 'deny' } },
        },
        {
          organization_id: organizationId,
          kind: 'client_configuration',
          name: 'Private client configuration',
          schema_version: 1,
          document: { disable_auto_approve: true },
        },
      ])
      .returning();
    await tx.insert(organization_group_policy_links).values(
      [linked, otherLinked].flatMap(group =>
        [agentPolicy, clientPolicy].map(policy => ({
          organization_id: organizationId,
          group_id: group.id,
          kind: policy.kind,
          policy_id: policy.id,
        }))
      )
    );
    await tx.insert(organization_default_policy_links).values({
      organization_id: organizationId,
      kind: clientPolicy.kind,
      policy_id: clientPolicy.id,
    });
    await tx
      .insert(organization_group_policy_settings)
      .values({ organization_id: organizationId, policy_revision: 7 });

    return {
      organizationId,
      actor,
      member,
      linked,
      otherLinked,
      unlinked,
      agentPolicy,
      clientPolicy,
    };
  });
}

async function setOrgFeature(...organizationIds: string[]) {
  const config = { organization_features: { org_permission_policy: organizationIds } };
  await db
    .insert(ai_gateway_config)
    .values({ config })
    .onConflictDoUpdate({ target: ai_gateway_config.id, set: { config } });
}

async function readState(organizationId: string) {
  const [settings, groups, memberships, groupLinks, defaultLinks, policies, audits] =
    await Promise.all([
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
        .from(organization_group_policy_links)
        .where(eq(organization_group_policy_links.organization_id, organizationId))
        .orderBy(organization_group_policy_links.group_id, organization_group_policy_links.kind),
      db
        .select()
        .from(organization_default_policy_links)
        .where(eq(organization_default_policy_links.organization_id, organizationId))
        .orderBy(organization_default_policy_links.kind),
      db
        .select()
        .from(organization_named_policies)
        .where(eq(organization_named_policies.organization_id, organizationId))
        .orderBy(organization_named_policies.id),
      db
        .select({
          action: organization_audit_logs.action,
          actorId: organization_audit_logs.actor_id,
          message: organization_audit_logs.message,
        })
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId))
        .orderBy(organization_audit_logs.id),
    ]);
  return { settings, groups, memberships, groupLinks, defaultLinks, policies, audits };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;
type GroupWriter = {
  name: string;
  action: string;
  run: (fixture: Fixture, permissionPolicyAdmin: boolean) => Promise<{ policyRevision: number }>;
  expectedMemberships: (fixture: Fixture) => { group_id: string; kilo_user_id: string }[];
};

const groupWriters: GroupWriter[] = [
  {
    name: 'setting group members',
    action: 'organization.group.members.set',
    run: ({ organizationId, actor, linked }, permissionPolicyAdmin) =>
      setOrganizationGroupMembers({
        organizationId,
        actor,
        groupId: linked.id,
        userIds: [actor.id],
        permissionPolicyAdmin,
      }),
    expectedMemberships: ({ linked, actor }) => [{ group_id: linked.id, kilo_user_id: actor.id }],
  },
  {
    name: 'updating group details and members',
    action: 'organization.group.update',
    run: ({ organizationId, actor, linked, member }, permissionPolicyAdmin) =>
      updateOrganizationGroupDetails({
        organizationId,
        actor,
        groupId: linked.id,
        name: 'Renamed restricted group',
        description: 'Changed with membership',
        userIds: [member.id, actor.id],
        permissionPolicyAdmin,
      }),
    expectedMemberships: ({ linked, actor, member }) =>
      [actor.id, member.id].map(userId => ({ group_id: linked.id, kilo_user_id: userId })),
  },
  {
    name: 'moving a member between two groups sharing the same policy IDs',
    action: 'organization.group.member_groups.set',
    run: ({ organizationId, actor, otherLinked, member }, permissionPolicyAdmin) =>
      setOrganizationMemberGroups({
        organizationId,
        actor,
        userId: member.id,
        groupIds: [otherLinked.id],
        permissionPolicyAdmin,
      }),
    expectedMemberships: ({ otherLinked, member }) => [
      { group_id: otherLinked.id, kilo_user_id: member.id },
    ],
  },
  {
    name: 'deleting an empty linked group',
    action: 'organization.group.delete',
    run: ({ organizationId, actor, otherLinked }, permissionPolicyAdmin) =>
      deleteOrganizationGroup({
        organizationId,
        actor,
        groupId: otherLinked.id,
        permissionPolicyAdmin,
      }),
    expectedMemberships: ({ linked, member }) => [{ group_id: linked.id, kilo_user_id: member.id }],
  },
];

describe('named organization policy group guard', () => {
  let fixture: Fixture;
  let originalConfig: typeof ai_gateway_config.$inferSelect.config | undefined;

  beforeEach(async () => {
    const [existing] = await db.select().from(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
    originalConfig = existing?.config;
    fixture = await seedFixture();
    await setOrgFeature(fixture.organizationId);
    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'true';
  });

  afterEach(async () => {
    if (originalWriteSwitch === undefined) delete process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;
    else process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = originalWriteSwitch;

    if (originalConfig === undefined) {
      await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
    } else {
      await db
        .update(ai_gateway_config)
        .set({ config: originalConfig })
        .where(eq(ai_gateway_config.id, 1));
    }
    if (fixture) {
      const { organizationId, actor, member } = fixture;
      await db.transaction(async tx => {
        await tx.delete(organizations).where(eq(organizations.id, organizationId));
        await tx
          .delete(organization_memberships)
          .where(eq(organization_memberships.organization_id, organizationId));
        await tx
          .delete(organization_audit_logs)
          .where(eq(organization_audit_logs.organization_id, organizationId));
        await tx.delete(kilocode_users).where(inArray(kilocode_users.id, [actor.id, member.id]));
      });
    }
  });

  it.each(groupWriters)('guards $name and audits only the committed change', async writer => {
    const { organizationId, actor, member, linked, otherLinked, agentPolicy, clientPolicy } =
      fixture;
    const before = await readState(organizationId);

    await expect(writer.run(fixture, false)).rejects.toMatchObject(browserSessionRequired);
    expect(await readState(organizationId)).toEqual(before);

    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'false';
    await expect(writer.run(fixture, true)).rejects.toMatchObject(writesDisabled);
    expect(await readState(organizationId)).toEqual(before);

    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'true';
    const { policyRevision } = await writer.run(fixture, true);
    const after = await readState(organizationId);
    expect(policyRevision).toBe(before.settings[0].policy_revision + 1);
    expect(after.settings[0].policy_revision).toBe(policyRevision);
    const memberships = after.memberships.map(({ group_id, kilo_user_id }) => ({
      group_id,
      kilo_user_id,
    }));
    expect(memberships).toHaveLength(writer.expectedMemberships(fixture).length);
    expect(memberships).toEqual(expect.arrayContaining(writer.expectedMemberships(fixture)));

    if (writer.action === 'organization.group.delete') {
      expect(after.groups).toEqual(before.groups.filter(group => group.id !== otherLinked.id));
      expect(after.groupLinks).toEqual(
        before.groupLinks.filter(link => link.group_id !== otherLinked.id)
      );
    } else {
      expect(after.groupLinks).toEqual(before.groupLinks);
    }
    if (writer.action === 'organization.group.update') {
      expect(after.groups.find(group => group.id === linked.id)).toMatchObject({
        name: 'Renamed restricted group',
        description: 'Changed with membership',
        policies: linked.policies,
      });
    }
    expect(after.defaultLinks).toEqual(before.defaultLinks);
    expect(after.policies).toEqual(before.policies);

    expect(after.audits).toHaveLength(1);
    const [audit] = after.audits;
    expect(audit).toMatchObject({ action: writer.action, actorId: actor.id });
    expect(audit.message.split('; named policies: ')).toEqual([
      expect.any(String),
      `agent_permissions ${agentPolicy.id}, client_configuration ${clientPolicy.id} (revision ${policyRevision})`,
    ]);
    for (const privateValue of [
      agentPolicy.name,
      clientPolicy.name,
      'private_tool_rule',
      'disable_auto_approve',
      member.google_user_email,
      member.id,
    ]) {
      expect(audit.message).not.toContain(privateValue);
    }
  });

  it('lets bearer group writers proceed when the organization feature is off', async () => {
    const { organizationId, otherLinked } = fixture;
    const before = await readState(organizationId);
    await setOrgFeature();

    for (const writer of groupWriters) await writer.run(fixture, false);

    const after = await readState(organizationId);
    expect(after.settings[0].policy_revision).toBe(
      before.settings[0].policy_revision + groupWriters.length
    );
    expect(after.groupLinks).toEqual(
      before.groupLinks.filter(link => link.group_id !== otherLinked.id)
    );
    expect(after.audits.map(audit => audit.action).sort()).toEqual(
      groupWriters.map(writer => writer.action).sort()
    );
    expect(after.audits.map(audit => audit.message).join('\n')).not.toContain('named policies:');
  });

  it('does not guard same-set replacements or an unchanged linked group when another group changes', async () => {
    const { organizationId, actor, linked, unlinked, member } = fixture;
    await db.insert(organization_group_memberships).values({
      organization_id: organizationId,
      group_id: linked.id,
      kilo_user_id: actor.id,
    });
    const before = await readState(organizationId);
    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'false';
    const group = { organizationId, actor, groupId: linked.id, permissionPolicyAdmin: false };

    await setOrganizationGroupMembers({ ...group, userIds: [actor.id, member.id, actor.id] });
    await updateOrganizationGroupDetails({
      ...group,
      name: 'Renamed without changing members',
      userIds: [member.id, actor.id],
    });
    await setOrganizationMemberGroups({
      organizationId,
      actor,
      userId: member.id,
      groupIds: [unlinked.id, linked.id.toUpperCase(), linked.id],
      permissionPolicyAdmin: false,
    });

    const after = await readState(organizationId);
    expect(after.groups.find(row => row.id === linked.id)?.name).toBe(
      'Renamed without changing members'
    );
    expect(after.memberships.map(({ group_id, kilo_user_id }) => [group_id, kilo_user_id])).toEqual(
      expect.arrayContaining([
        [linked.id, actor.id],
        [linked.id, member.id],
        [unlinked.id, member.id],
      ])
    );
    expect(after.memberships).toHaveLength(3);
    expect(after.groupLinks).toEqual(before.groupLinks);
    expect(after.settings[0].policy_revision).toBe(before.settings[0].policy_revision + 3);
    expect(after.audits).toHaveLength(3);
    expect(after.audits.map(audit => audit.message).join('\n')).not.toContain('named policies:');
  });

  it('rechecks a committed attachment after waiting on the same policy lock for an uppercase UUID', async () => {
    const { organizationId, actor, unlinked, member, agentPolicy } = fixture;
    const before = await readState(organizationId);
    const lockHeld = Promise.withResolvers<number>();
    const allowAttachment = Promise.withResolvers<void>();
    const link = {
      organization_id: organizationId,
      group_id: unlinked.id,
      kind: agentPolicy.kind,
      policy_id: agentPolicy.id,
    };
    const attachment = withOrganizationGroupPolicyMutation(
      organizationId,
      actor.id,
      async ({ tx }) => {
        const {
          rows: [backend],
        } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        lockHeld.resolve(backend.pid);
        await allowAttachment.promise;
        await tx.insert(organization_group_policy_links).values(link);
      }
    );
    void attachment.catch(lockHeld.reject);

    let writer: Promise<unknown> | undefined;
    try {
      const holderPid = await lockHeld.promise;
      let writerFinished = false;
      writer = setOrganizationGroupMembers({
        organizationId: organizationId.toUpperCase(),
        actor,
        groupId: unlinked.id,
        userIds: [member.id],
        permissionPolicyAdmin: false,
      })
        .then(
          result => ({ result }),
          (error: unknown) => ({ error })
        )
        .finally(() => {
          writerFinished = true;
        });

      let blocked = false;
      for (let i = 0; i < 1_000 && !blocked && !writerFinished; i += 1) {
        const waiting = await db.execute(sql`
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
            AND ${holderPid} = ANY(pg_blocking_pids(pid))
        `);
        blocked = waiting.rows.length > 0;
      }
      expect(blocked).toBe(true);

      allowAttachment.resolve();
      const { policyRevision } = await attachment;
      expect(await writer).toMatchObject({ error: browserSessionRequired });
      const after = await readState(organizationId);
      expect(after.groupLinks.filter(row => row.group_id === unlinked.id)).toEqual([link]);
      expect(after.memberships).toEqual(before.memberships);
      expect(after.audits).toEqual(before.audits);
      expect(after.settings[0].policy_revision).toBe(policyRevision);
      expect(policyRevision).toBe(before.settings[0].policy_revision + 1);
    } finally {
      allowAttachment.resolve();
      await Promise.allSettled([attachment, writer]);
    }
  }, 20_000);
});
