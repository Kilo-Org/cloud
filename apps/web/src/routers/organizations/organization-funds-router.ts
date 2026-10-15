import { organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationBillingProcedure,
  organizationBillingMutationProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { processOrganizationExpirations } from '@kilocode/web-shared/lib/creditExpiration';
import { lockCreditOwners, transferCreditLots } from '@kilocode/web-shared/lib/creditAdjustments';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import { formatMicrodollars } from '@/lib/admin-utils';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import * as z from 'zod';

const ChildBalancesOutputSchema = z.object({
  parentBalanceMicrodollars: z.number(),
  hasExpiringCredits: z.boolean(),
  children: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      balanceMicrodollars: z.number(),
    })
  ),
});

const DistributeFundsInputSchema = OrganizationIdInputSchema.extend({
  allocations: z
    .array(
      z.object({
        childOrganizationId: z.uuid(),
        amountMicrodollars: z.number().int().positive(),
      })
    )
    .min(1)
    .refine(
      allocations =>
        new Set(allocations.map(allocation => allocation.childOrganizationId)).size ===
        allocations.length,
      { message: 'Each child organization can appear at most once' }
    ),
});

const DistributeFundsOutputSchema = z.object({
  totalMovedMicrodollars: z.number(),
  childCount: z.number(),
});

/**
 * Fetches the organization, processing any due credit expirations first so the
 * returned balance and `next_credit_expiration_at` flag are current. Mirrors the
 * lazy-expiry pattern used by `organizations.withMembers`.
 */
async function getOrganizationWithExpiryProcessed(organizationId: string) {
  let organization = await getOrganizationById(organizationId);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  if (
    organization.next_credit_expiration_at &&
    new Date() >= new Date(organization.next_credit_expiration_at)
  ) {
    const expiryResult = await processOrganizationExpirations(
      {
        id: organizationId,
        microdollars_used: organization.microdollars_used,
        next_credit_expiration_at: organization.next_credit_expiration_at,
        total_microdollars_acquired: organization.total_microdollars_acquired,
      },
      new Date()
    );
    if (expiryResult) {
      organization = (await getOrganizationById(organizationId)) ?? organization;
    }
  }
  return organization;
}

export const organizationFundsRouter = createTRPCRouter({
  // Per-child balances plus the parent balance and eligibility flag, used to
  // render the fund-distribution table. Restricted to owner/billing_manager.
  childBalances: organizationBillingProcedure
    .output(ChildBalancesOutputSchema)
    .query(async ({ input }) => {
      const parent = await getOrganizationWithExpiryProcessed(input.organizationId);

      const childRows = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          total_microdollars_acquired: organizations.total_microdollars_acquired,
          microdollars_used: organizations.microdollars_used,
          next_credit_expiration_at: organizations.next_credit_expiration_at,
        })
        .from(organizations)
        .where(
          and(
            eq(organizations.parent_organization_id, input.organizationId),
            isNull(organizations.deleted_at)
          )
        )
        .orderBy(asc(organizations.name));

      // Process any due expirations per child so displayed balances aren't
      // overstated, mirroring the parent path. The hierarchy is single-level,
      // so this is a small, bounded set of direct children.
      const now = new Date();
      const children: { id: string; name: string; balanceMicrodollars: number }[] = [];
      for (const child of childRows) {
        let totalAcquired = child.total_microdollars_acquired;
        if (child.next_credit_expiration_at && now >= new Date(child.next_credit_expiration_at)) {
          const expiryResult = await processOrganizationExpirations(
            {
              id: child.id,
              microdollars_used: child.microdollars_used,
              next_credit_expiration_at: child.next_credit_expiration_at,
              total_microdollars_acquired: child.total_microdollars_acquired,
            },
            now
          );
          if (expiryResult) {
            totalAcquired = expiryResult.total_microdollars_acquired;
          }
        }
        children.push({
          id: child.id,
          name: child.name,
          balanceMicrodollars: totalAcquired - child.microdollars_used,
        });
      }

      return {
        parentBalanceMicrodollars: parent.total_microdollars_acquired - parent.microdollars_used,
        hasExpiringCredits: parent.next_credit_expiration_at != null,
        children,
      };
    }),

  distribute: organizationBillingMutationProcedure
    .input(DistributeFundsInputSchema)
    .output(DistributeFundsOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, allocations } = input;

      const totalToMoveMicrodollars = allocations.reduce(
        (sum, allocation) => sum + allocation.amountMicrodollars,
        0
      );

      const childCount = await db.transaction(async tx => {
        await lockCreditOwners(tx, [
          { type: 'organization', id: organizationId },
          ...allocations.map(allocation => ({
            type: 'organization' as const,
            id: allocation.childOrganizationId,
          })),
        ]);
        const [parent] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, organizationId));
        if (!parent) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
        }

        const parentBalance = parent.total_microdollars_acquired - parent.microdollars_used;
        if (totalToMoveMicrodollars > parentBalance) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'The total amount to distribute exceeds the available balance.',
          });
        }

        // Validate every target is a direct, non-deleted child and lock the rows.
        const childIds = allocations.map(allocation => allocation.childOrganizationId);
        const childRows = await tx
          .select({
            id: organizations.id,
            name: organizations.name,
          })
          .from(organizations)
          .where(
            and(
              eq(organizations.parent_organization_id, organizationId),
              inArray(organizations.id, childIds),
              isNull(organizations.deleted_at)
            )
          );

        const childById = new Map(childRows.map(child => [child.id, child]));
        if (childById.size !== childIds.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'All recipients must be direct child organizations.',
          });
        }

        for (const allocation of allocations) {
          const child = childById.get(allocation.childOrganizationId);
          if (!child) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Recipient not found' });
          }
          await transferCreditLots(tx, {
            from: { type: 'organization', id: organizationId },
            to: { type: 'organization', id: child.id },
            actorId: user.id,
            amountMicrodollars: allocation.amountMicrodollars,
            incomingCategory: 'parent_to_child_transfer_in',
            outgoingCategory: 'parent_to_child_transfer_out',
            incomingDescription: `Transfer from parent organization ${parent.name}`,
            outgoingDescription: `Transfer to child organization ${child.name}`,
          });

          await createAuditLog({
            tx,
            action: 'organization.funds.distribute_to_children',
            actor_email: user.google_user_email,
            actor_id: user.id,
            actor_name: user.google_user_name,
            message: `Received ${formatMicrodollars(allocation.amountMicrodollars)} from parent organization ${parent.name}`,
            organization_id: child.id,
          });
        }

        await createAuditLog({
          tx,
          action: 'organization.funds.distribute_to_children',
          actor_email: user.google_user_email,
          actor_id: user.id,
          actor_name: user.google_user_name,
          message: `Distributed ${formatMicrodollars(totalToMoveMicrodollars)} to ${allocations.length} child organization${allocations.length === 1 ? '' : 's'}`,
          organization_id: organizationId,
        });

        return allocations.length;
      });

      return {
        totalMovedMicrodollars: totalToMoveMicrodollars,
        childCount,
      };
    }),
});
