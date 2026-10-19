import { customRouterModelId } from '@kilocode/auto-routing-contracts';
import {
  ORGANIZATION_BILLING_ROLES,
  ORGANIZATION_PARENT_ACCESS_ROLES,
} from '@kilocode/app-shared/organizations';
import {
  auto_routing_custom_routers,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { db } from '@kilocode/web-shared/lib/drizzle';
import type { PoolNotificationOwner } from './auto-routing-pool-notifications';

// A parent-organization member is a child's billing contact only when the role both inherits
// into the child and carries billing authority there.
const INHERITED_BILLING_ROLES = ORGANIZATION_BILLING_ROLES.filter(role =>
  ORGANIZATION_PARENT_ACCESS_ROLES.includes(role)
);

export async function discoverPoolNotificationOwners(
  database: typeof db
): Promise<PoolNotificationOwner[]> {
  return database.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const personalPools = await tx
      .select({
        id: auto_routing_custom_routers.id,
        slug: auto_routing_custom_routers.slug,
        email: kilocode_users.google_user_email,
      })
      .from(auto_routing_custom_routers)
      .innerJoin(
        kilocode_users,
        eq(kilocode_users.id, auto_routing_custom_routers.owned_by_user_id)
      )
      .where(eq(auto_routing_custom_routers.legacy_pool, true));
    const organizationPools = await tx
      .select({
        id: auto_routing_custom_routers.id,
        slug: auto_routing_custom_routers.slug,
        organizationId: organizations.id,
        organizationName: organizations.name,
      })
      .from(auto_routing_custom_routers)
      .innerJoin(
        organizations,
        eq(organizations.id, auto_routing_custom_routers.owned_by_organization_id)
      )
      .where(
        and(eq(auto_routing_custom_routers.legacy_pool, true), isNull(organizations.deleted_at))
      );
    const organizationIds = [...new Set(organizationPools.map(router => router.organizationId))];
    const billingContacts =
      organizationIds.length === 0
        ? []
        : await tx
            .select({
              organizationId: organization_memberships.organization_id,
              email: kilocode_users.google_user_email,
            })
            .from(organization_memberships)
            .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
            .where(
              and(
                inArray(organization_memberships.organization_id, organizationIds),
                inArray(organization_memberships.role, ORGANIZATION_BILLING_ROLES),
                eq(kilocode_users.is_bot, false)
              )
            );
    const inheritedBillingContacts =
      organizationIds.length === 0
        ? []
        : await tx
            .select({
              organizationId: organizations.id,
              email: kilocode_users.google_user_email,
            })
            .from(organizations)
            .innerJoin(
              organization_memberships,
              eq(organization_memberships.organization_id, organizations.parent_organization_id)
            )
            .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
            .where(
              and(
                inArray(organizations.id, organizationIds),
                inArray(organization_memberships.role, INHERITED_BILLING_ROLES),
                eq(kilocode_users.is_bot, false)
              )
            );
    const allBillingContacts = [...billingContacts, ...inheritedBillingContacts];
    return [
      ...personalPools.map(router => ({
        routers: [
          {
            id: router.id,
            modelId: customRouterModelId('user', router.slug),
            organization: null,
          },
        ],
        emails: [router.email],
      })),
      ...organizationPools.map(router => ({
        routers: [
          {
            id: router.id,
            modelId: customRouterModelId('org', router.slug),
            organization: { id: router.organizationId, name: router.organizationName },
          },
        ],
        emails: [
          ...new Set(
            allBillingContacts
              .filter(contact => contact.organizationId === router.organizationId)
              .map(contact => contact.email)
          ),
        ],
      })),
    ] satisfies PoolNotificationOwner[];
  });
}
