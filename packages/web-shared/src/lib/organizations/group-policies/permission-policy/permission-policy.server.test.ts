import {
  ai_gateway_config,
  organization_group_memberships,
  organization_group_policy_settings,
  organization_groups,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type {
  AgentPermissionSet,
  AgentPermissionsPolicy,
  OrganizationPermissionPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { getOrganizationPermissionPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.server';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';

const revision = 7;

async function fixture(defaultPolicies: OrganizationPermissionPolicy[]) {
  const { id: userId } = await insertTestUser();
  const { id: organizationId } = await createTestOrganization('Permission resolver', userId, 0);
  await db.insert(organization_group_policy_settings).values({
    organization_id: organizationId,
    policy_revision: revision,
    default_policies: defaultPolicies,
  });
  return { organizationId, userId };
}

async function setAllowlist(organizationIds: string[]) {
  const config = { organization_features: { org_permission_policy: organizationIds } };
  await db
    .insert(ai_gateway_config)
    .values({ id: 1, config })
    .onConflictDoUpdate({ target: ai_gateway_config.id, set: { config } });
}

afterEach(async () => {
  await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
});

function withWindowsAddition(
  allOs: AgentPermissionSet,
  windows: AgentPermissionSet
): AgentPermissionsPolicy {
  return { type: 'agent_permissions', data: { schema_version: 1, ...allOs, by_os: { windows } } };
}

test('sorts generic and matching layers separately and deduplicates across both sets', async () => {
  const genericAsk = { tools: { browser_open: 'ask' } } as const;
  const genericDeny = { tools: { browser_open: 'deny' } } as const;
  const windowsBash = { tools: { bash: 'ask' } } as const;
  const windowsEdit = { tools: { edit: 'deny' } } as const;
  const { organizationId, userId } = await fixture([withWindowsAddition(genericDeny, windowsEdit)]);
  await setAllowlist([organizationId]);

  const groups = await db
    .insert(organization_groups)
    .values(
      [
        withWindowsAddition(genericAsk, genericAsk),
        withWindowsAddition(genericDeny, windowsBash),
        withWindowsAddition(genericAsk, windowsBash),
      ].map((policy, index) => ({
        organization_id: organizationId,
        name: `Permission source ${index}`,
        policies: [policy],
      }))
    )
    .returning({ groupId: organization_groups.id });
  await db.insert(organization_group_memberships).values(
    groups.map(({ groupId }) => ({
      organization_id: organizationId,
      group_id: groupId,
      kilo_user_id: userId,
    }))
  );

  const { response } = await getOrganizationPermissionPolicy(organizationId, userId, 'windows');

  expect(response).toMatchObject({ managed: true, revision });
  expect(response.policy).toEqual({
    agent_permissions: {
      layers: [genericAsk, genericDeny, windowsBash, windowsEdit].map(layer => ({
        schema_version: 1,
        ...layer,
      })),
    },
  });
});

test('resolves explicitly visible session dollars only for an enabled Enterprise direct member', async () => {
  const visiblePolicy = {
    type: 'client_configuration',
    data: { schema_version: 1, show_session_dollar_values: true },
  } satisfies OrganizationPermissionPolicy;
  const { organizationId, userId } = await fixture([visiblePolicy]);
  await setAllowlist([]);

  const disabled = await getOrganizationPermissionPolicy(organizationId, userId, 'windows');
  expect(disabled.response).toMatchObject({ managed: false, revision });
  expect(disabled.response.policy).toEqual({});
  expect(disabled.sources).toEqual({ defaultPolicies: [], groups: [] });

  await setAllowlist([organizationId]);
  const { response } = await getOrganizationPermissionPolicy(organizationId, userId, 'windows');
  expect(response).toMatchObject({ managed: true, revision });
  expect(response.policy).toEqual({ client_configuration: { show_session_dollar_values: true } });

  await db.update(organizations).set({ plan: 'teams' }).where(eq(organizations.id, organizationId));
  await expect(getOrganizationPermissionPolicy(organizationId, userId, 'windows')).resolves.toEqual(
    disabled
  );

  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, organizationId));
  await expect(
    getOrganizationPermissionPolicy(organizationId, userId, 'windows')
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
