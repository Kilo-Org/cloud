import { credit_transactions, organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationBillingProcedure,
  organizationBillingMutationProcedure,
} from '@/routers/organizations/utils';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { processOrganizationExpirations } from '@/lib/creditExpiration';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { formatMicrodollars } from '@/lib/admin-utils';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as z from 'zod';

const ChildBalancesOutputSchema = z.object({
  /** Spendable balance of the parent organization, in microdollars. */
  parentBalanceMicrodollars: z.number(),
  /**
   * True when the parent still has active expiring credits. Distribution is
   * disabled entirely in that case, because partially moving an expiring credit
   * bucket cannot be done without changing the lazy-expiry engine.
   */
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

  // Moves funds from the parent organization to one or more direct children as
  // non-expiring credit transactions. The whole action is rejected while the
  // parent has expiring credits.
  distribute: organizationBillingMutationProcedure
    .input(DistributeFundsInputSchema)
    .output(DistributeFundsOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, allocations } = input;

      // Process any due expirations before locking so the eligibility check and
      // balance comparison below are accurate.
      await getOrganizationWithExpiryProcessed(organizationId);

      const totalToMoveMicrodollars = allocations.reduce(
        (sum, allocation) => sum + allocation.amountMicrodollars,
        0
      );

      const childCount = await db.transaction(async tx => {
        const [parent] = await tx
          .select({
            name: organizations.name,
            total_microdollars_acquired: organizations.total_microdollars_acquired,
            microdollars_used: organizations.microdollars_used,
            next_credit_expiration_at: organizations.next_credit_expiration_at,
          })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .for('update');

        if (!parent) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
        }

        // Expiring credits make the source pool ambiguous, so the action is
        // disabled entirely while any exist. Re-checked under the row lock to
        // guard against a credit being granted between page load and submit.
        if (parent.next_credit_expiration_at != null) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Funds cannot be distributed while this organization has expiring credits.',
          });
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
            microdollars_used: organizations.microdollars_used,
          })
          .from(organizations)
          .where(
            and(
              eq(organizations.parent_organization_id, organizationId),
              inArray(organizations.id, childIds),
              isNull(organizations.deleted_at)
            )
          )
          .for('update');

        const childById = new Map(childRows.map(child => [child.id, child]));
        if (childById.size !== childIds.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'All recipients must be direct child organizations.',
          });
        }

        for (const allocation of allocations) {
          const child = childById.get(allocation.childOrganizationId);
          if (!child) continue; // Unreachable given the size check above.

          // Credit the child. Transfers are non-expiring in v1, so there is no
          // expiry date or expiration baseline. `is_free` is true because a
          // transfer is a balance movement, not a purchase: marking it as paid
          // would fabricate `hasOrganizationEverPaid` for a child that never
          // paid (and could move free credits in as paid-looking ones).
          await tx.insert(credit_transactions).values({
            kilo_user_id: user.id,
            created_by_kilo_user_id: user.id,
            is_free: true,
            amount_microdollars: allocation.amountMicrodollars,
            description: `Transfer from parent organization ${parent.name}`,
            credit_category: 'parent_to_child_transfer_in',
            expiry_date: null,
            organization_id: child.id,
            original_baseline_microdollars_used: child.microdollars_used,
            expiration_baseline_microdollars_used: null,
          });

          await tx
            .update(organizations)
            .set({
              total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${allocation.amountMicrodollars}`,
              microdollars_balance: sql`${organizations.microdollars_balance} + ${allocation.amountMicrodollars}`,
            })
            .where(eq(organizations.id, child.id));

          // Matching deduction recorded on the parent for a symmetric ledger.
          // Also `is_free: true` so the movement never fabricates a paid signal
          // on the parent either (a parent funded only by free credits must not
          // look like it paid just because it distributed funds).
          await tx.insert(credit_transactions).values({
            kilo_user_id: user.id,
            created_by_kilo_user_id: user.id,
            is_free: true,
            amount_microdollars: -allocation.amountMicrodollars,
            description: `Transfer to child organization ${child.name}`,
            credit_category: 'parent_to_child_transfer_out',
            expiry_date: null,
            organization_id: organizationId,
            original_baseline_microdollars_used: parent.microdollars_used,
            expiration_baseline_microdollars_used: null,
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

        // Single rollup deduction on the parent for the full distributed total.
        await tx
          .update(organizations)
          .set({
            total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} - ${totalToMoveMicrodollars}`,
            microdollars_balance: sql`${organizations.microdollars_balance} - ${totalToMoveMicrodollars}`,
          })
          .where(eq(organizations.id, organizationId));

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
