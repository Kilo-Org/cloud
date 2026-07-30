import { kilo_pass_org_agreements, organizations } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { organizationKiloPassService } from '@/lib/kilo-pass-org/service';
import { listKiloPassOrganizationInvoices } from '@/lib/kilo-pass-org/billing-history';
import {
  createOrganizationKiloPassCheckout,
  reconcileOrganizationKiloPassPayment,
  resumeOrganizationKiloPassCancellation,
  scheduleOrganizationKiloPassCancellation,
} from '@/lib/kilo-pass-org/stripe-adapter';
import { createTRPCRouter } from '@/lib/trpc/init';
import { client as stripe } from '@/lib/stripe-client';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import {
  billingHistoryResponseSchema,
  mapStripeInvoiceToBillingHistoryEntry,
} from '@/lib/subscriptions/subscription-center';
import {
  OrganizationIdInputSchema,
  organizationBillingProcedure,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';

const TierSchema = z.enum(['tier_19', 'tier_49', 'tier_199']);
const AllocationSchema = z.object({
  childOrganizationId: z.uuid(),
  passCount: z.number().int().nonnegative(),
});
const AllocationsSchema = z
  .array(AllocationSchema)
  .refine(
    allocations =>
      new Set(allocations.map(allocation => allocation.childOrganizationId)).size ===
      allocations.length,
    { message: 'Each child organization can appear at most once' }
  );
const BillingHistoryInputSchema = OrganizationIdInputSchema.extend({
  cursor: z.string().optional(),
});

const OrganizationKiloPassStateSchema = z.enum([
  'unavailable',
  'pending_payment',
  'requires_action',
  'activating',
  'active',
  'cancel_at_period_end',
  'ended',
  'blocked',
  'failed',
]);
const CommercialStateSchema = z.enum([
  'pending_payment',
  'active',
  'cancel_at_period_end',
  'ended',
]);
const ProcessingConditionSchema = z.enum([
  'ready',
  'manual',
  'blocked',
  'overallocated',
  'failed',
  'suspended_for_review',
]);
const TermsSchema = z.object({
  tier: TierSchema,
  tierName: z.string().min(1),
  pricePerPassUsd: z.number().nonnegative(),
  baseCreditsPerPassUsd: z.number().nonnegative(),
  bonusCreditsPerPassUsd: z.number().nonnegative(),
  unlockSpendPerPassUsd: z.number().nonnegative(),
  bonusMode: z.enum(['after_base', 'upfront']),
});

const TimestampSchema = z.iso.datetime();
const SummaryOutputSchema = z.object({
  state: OrganizationKiloPassStateSchema,
  commercialState: CommercialStateSchema.nullable(),
  processingCondition: ProcessingConditionSchema.nullable(),
  agreement: z
    .object({
      tier: TierSchema,
      paidSeatCount: z.number().int().nonnegative(),
      planVersion: z.number().int().nonnegative(),
      paidThrough: TimestampSchema.nullable(),
      terms: TermsSchema,
    })
    .nullable(),
});
const SetupOutputSchema = z.object({
  paidSeatCount: z.number().int().nonnegative(),
  cadence: z.enum(['monthly', 'yearly']),
  renewalAt: TimestampSchema,
  planVersion: z.number().int().nonnegative(),
  children: z.array(z.object({ id: z.uuid(), name: z.string().min(1) })),
  terms: z.array(TermsSchema),
});
const CurrentAllocationSchema = z.object({
  organizationId: z.uuid(),
  organizationName: z.string().min(1),
  passCount: z.number().int().nonnegative(),
  kind: z.enum(['parent', 'child']),
  hasProratedCredits: z.boolean(),
  baseCreditsMicrodollars: z.number().int().nonnegative(),
  qualifyingSpendMicrodollars: z.number().int().nonnegative(),
  unlockTargetMicrodollars: z.number().int().nonnegative(),
  bonusCreditsMicrodollars: z.number().int().nonnegative(),
  bonusState: z.enum(['locked', 'unlocked', 'upfront_granted', 'expired', 'missed']),
});
const UsageOutputSchema = z
  .object({
    tier: TierSchema,
    terms: TermsSchema,
    currentWindow: z.object({ startsAt: TimestampSchema, endsAt: TimestampSchema }),
    currentAllocations: z.array(CurrentAllocationSchema),
  })
  .nullable();
const DetailOutputSchema = z.object({
  state: OrganizationKiloPassStateSchema,
  commercialState: CommercialStateSchema,
  processingCondition: ProcessingConditionSchema,
  tier: TierSchema,
  cadence: z.enum(['monthly', 'yearly']),
  terms: TermsSchema,
  paidSeatCount: z.number().int().nonnegative(),
  nextPaidSeatCount: z.number().int().nonnegative(),
  planVersion: z.number().int().nonnegative(),
  paidThrough: TimestampSchema.nullable(),
  currentWindow: z.object({ startsAt: TimestampSchema, endsAt: TimestampSchema }).nullable(),
  nextWindowStartsAt: TimestampSchema.nullable(),
  latestRun: z
    .object({
      id: z.uuid(),
      state: z.enum(['pending', 'running', 'succeeded', 'blocked', 'failed']),
      window: z.object({ startsAt: TimestampSchema, endsAt: TimestampSchema }),
      failureCode: z.string().nullable(),
      attemptCount: z.number().int().nonnegative(),
    })
    .nullable(),
  pendingTermTransitions: z.array(
    z.object({ id: z.uuid(), effectiveAt: TimestampSchema, toVersionKey: z.string().min(1) })
  ),
  currentAllocations: z.array(CurrentAllocationSchema),
  nextAllocations: z.array(
    z.object({
      organizationId: z.uuid(),
      organizationName: z.string().min(1),
      passCount: z.number().int().nonnegative(),
      kind: z.enum(['parent', 'child']),
    })
  ),
});
const CheckoutOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checkout'), url: z.url() }),
  z.object({ kind: z.literal('payment_action'), clientSecret: z.string().min(1) }),
  z.object({ kind: z.literal('completed') }),
  z.object({ kind: z.literal('pending') }),
]);
const ActivationOutputSchema = z.object({
  state: OrganizationKiloPassStateSchema,
  commercialState: CommercialStateSchema.nullable(),
  processingCondition: ProcessingConditionSchema.nullable(),
  agreementId: z.uuid().nullable(),
  message: z.string().min(1).nullable(),
});
const UpdateAllocationOutputSchema = z.object({
  planVersion: z.number().int().nonnegative(),
  nextWindowStartsAt: TimestampSchema,
});
const CancelOutputSchema = z.object({
  state: z.literal('cancel_at_period_end'),
  effectiveAt: TimestampSchema,
});
const ResumeOutputSchema = z.object({ state: z.literal('active') });
const RetryRunOutputSchema = z.object({
  runId: z.uuid(),
  window: z.object({ startsAt: TimestampSchema, endsAt: TimestampSchema }),
});
const StatusOutputSchema = z.object({
  state: OrganizationKiloPassStateSchema,
  commercialState: CommercialStateSchema.nullable(),
  processingCondition: ProcessingConditionSchema.nullable(),
  retryAfterSeconds: z.number().int().positive().nullable(),
  updatedAt: TimestampSchema,
});

/** Billing access applies only to the parent agreement owner, never a child org. */
const organizationParentBillingProcedure = organizationBillingProcedure.use(
  async ({ input, next }) => {
    const [organization] = await db
      .select({ parentOrganizationId: organizations.parent_organization_id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId));

    if (!organization) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
    if (organization.parentOrganizationId !== null) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Kilo Pass for Organizations can only be managed from the parent organization',
      });
    }
    return next();
  }
);

function rethrowServiceError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof Error && error.message === 'STALE_PLAN_VERSION') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Pass assignments were changed elsewhere. Refresh and try again.',
    });
  }
  throw error;
}

export const organizationKiloPassRouter = createTRPCRouter({
  usage: organizationMemberProcedure.output(UsageOutputSchema).query(async ({ input }) => {
    return organizationKiloPassService.getUsage(input);
  }),

  summary: organizationParentBillingProcedure
    .output(SummaryOutputSchema)
    .query(async ({ input }) =>
      organizationKiloPassService.getSummary({ organizationId: input.organizationId })
    ),

  setup: organizationParentBillingProcedure
    .output(SetupOutputSchema)
    .query(async ({ input }) =>
      organizationKiloPassService.getSetup({ organizationId: input.organizationId })
    ),

  detail: organizationParentBillingProcedure
    .output(DetailOutputSchema)
    .query(async ({ input }) =>
      organizationKiloPassService.getDetail({ organizationId: input.organizationId })
    ),

  createCheckout: organizationParentBillingProcedure
    .input(
      OrganizationIdInputSchema.extend({
        tier: TierSchema,
        allocations: AllocationsSchema,
      }).strict()
    )
    .output(CheckoutOutputSchema)
    .mutation(async ({ input, ctx }) =>
      organizationKiloPassService.createCheckout(
        { ...input, actorUserId: ctx.user.id },
        createOrganizationKiloPassCheckout
      )
    ),

  activation: organizationParentBillingProcedure
    .input(
      OrganizationIdInputSchema.extend({ checkoutSessionId: z.string().min(1).max(512) }).strict()
    )
    .output(ActivationOutputSchema)
    .query(async ({ input }) => organizationKiloPassService.getActivation(input)),

  reconcilePayment: organizationParentBillingProcedure
    .output(z.object({ activated: z.boolean() }))
    .mutation(async ({ input }) => ({
      activated: await reconcileOrganizationKiloPassPayment(input.organizationId),
    })),

  billingHistory: organizationParentBillingProcedure
    .input(BillingHistoryInputSchema)
    .output(billingHistoryResponseSchema)
    .query(async ({ input }) => {
      const agreements = await db
        .select({
          itemId: kilo_pass_org_agreements.provider_seat_add_on_item_id,
        })
        .from(kilo_pass_org_agreements)
        .where(eq(kilo_pass_org_agreements.parent_organization_id, input.organizationId))
        .orderBy(desc(kilo_pass_org_agreements.created_at));
      const itemIds = new Set(
        agreements
          .map(agreement => agreement.itemId)
          .filter(
            (itemId): itemId is string =>
              typeof itemId === 'string' && !itemId.startsWith('pending:')
          )
      );
      if (!itemIds.size) {
        return { entries: [], hasMore: false, cursor: null };
      }

      const customerId = await getOrCreateStripeCustomerIdForOrganization(input.organizationId);
      const history = await listKiloPassOrganizationInvoices({
        customerId,
        itemIds,
        cursor: input.cursor,
        listInvoices: params => stripe.invoices.list(params),
      });
      return {
        entries: history.invoices.map(mapStripeInvoiceToBillingHistoryEntry),
        hasMore: history.hasMore,
        cursor: history.cursor,
      };
    }),

  updateAllocation: organizationParentBillingProcedure
    .input(
      OrganizationIdInputSchema.extend({
        expectedPlanVersion: z.number().int().nonnegative(),
        allocations: AllocationsSchema,
      }).strict()
    )
    .output(UpdateAllocationOutputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await organizationKiloPassService.updateAllocation({
          ...input,
          actorUserId: ctx.user.id,
        });
      } catch (error) {
        return rethrowServiceError(error);
      }
    }),

  cancel: organizationParentBillingProcedure
    .output(CancelOutputSchema)
    .mutation(async ({ input, ctx }) =>
      organizationKiloPassService.cancel(
        {
          organizationId: input.organizationId,
          actorUserId: ctx.user.id,
        },
        scheduleOrganizationKiloPassCancellation
      )
    ),

  resume: organizationParentBillingProcedure
    .output(ResumeOutputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        return await organizationKiloPassService.resume(
          {
            organizationId: input.organizationId,
            actorUserId: ctx.user.id,
          },
          resumeOrganizationKiloPassCancellation
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'SCHEDULE_REWRITE_UNSAFE') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'This subscription schedule cannot be safely resumed automatically.',
          });
        }
        throw error;
      }
    }),

  retryRun: organizationParentBillingProcedure
    .input(OrganizationIdInputSchema.extend({ runId: z.uuid() }).strict())
    .output(RetryRunOutputSchema)
    .mutation(async ({ input, ctx }) =>
      organizationKiloPassService.retryRun({ ...input, actorUserId: ctx.user.id })
    ),

  status: organizationParentBillingProcedure
    .output(StatusOutputSchema)
    .query(async ({ input }) =>
      organizationKiloPassService.getStatus({ organizationId: input.organizationId })
    ),
});
