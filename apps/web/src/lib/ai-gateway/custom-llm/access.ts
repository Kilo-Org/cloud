import { organization_group_memberships } from '@kilocode/db/schema';
import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { readDb } from '@/lib/drizzle';
import { and, eq, inArray } from 'drizzle-orm';

export function hasCustomLlmAccess(
  definition: CustomLlmDefinition,
  organizationId: string,
  groupIds: readonly string[]
) {
  return (
    definition.organization_ids.includes(organizationId) ||
    definition.group_ids?.some(groupId => groupIds.includes(groupId)) === true
  );
}

export async function userHasCustomLlmAccess(
  definition: CustomLlmDefinition,
  organizationId: string,
  kiloUserId: string
) {
  if (hasCustomLlmAccess(definition, organizationId, [])) {
    return true;
  }
  if (!definition.group_ids?.length) {
    return false;
  }

  const [membership] = await readDb
    .select({ groupId: organization_group_memberships.group_id })
    .from(organization_group_memberships)
    .where(
      and(
        eq(organization_group_memberships.organization_id, organizationId),
        eq(organization_group_memberships.kilo_user_id, kiloUserId),
        inArray(organization_group_memberships.group_id, definition.group_ids)
      )
    )
    .limit(1);

  return Boolean(membership);
}
