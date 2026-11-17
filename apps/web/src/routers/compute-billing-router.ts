import { z } from 'zod';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { queryAccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import { cloudAgentSessionIdSchema } from '@kilocode/session-ingest-contracts';
import { TRPCError } from '@trpc/server';
import { cloud_billing_sku } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { SANDBOX_USAGE_SKUS } from '@kilocode/worker-utils/cloud-agent-compute';
import { CLOUDFLARE_CONTAINERS_INSTANCES } from '@kilocode/worker-utils/sandbox-allocation';
import { isCodeReviewComputeBillingEnabled } from '@/lib/code-reviews/compute-billing';
import { readPersonalContainersBillingMode } from '@/lib/cloud-agent/compute-billing-mode';
import {
  COMPUTE_CHARGE_MAX_PAGE,
  readComputeCharges,
  readComputeRates,
  readSessionComputeCharges,
} from '@/lib/cloud-agent/compute-billing';

export const computeChargesInputSchema = z
  .object({
    organizationId: z.uuid().optional(),
    view: z.enum(['self', 'all']).default('self'),
    startDate: z.iso.datetime(),
    endDate: z.iso.datetime(),
    groupBy: z.enum(['day', 'session']).default('day'),
    page: z.number().int().min(0).max(COMPUTE_CHARGE_MAX_PAGE).default(0),
  })
  .refine(input => {
    const duration = Date.parse(input.endDate) - Date.parse(input.startDate);
    return duration > 0 && duration <= 366 * 86_400_000;
  }, 'Choose a date range of at most one year.');

export const computeBillingRouter = createTRPCRouter({
  codeReviewRate: baseProcedure
    .input(z.object({ organizationId: z.uuid().optional() }))
    .query(async ({ ctx, input }) => {
      if (input.organizationId) await ensureOrganizationAccess(ctx, input.organizationId);
      const enabled = await isCodeReviewComputeBillingEnabled(
        input.organizationId
          ? { type: 'org', id: input.organizationId }
          : { type: 'user', id: ctx.user.id }
      );
      if (!enabled) return { enabled: false, hourlyUsd: null };
      const [rate] = await db
        .select({ rate: cloud_billing_sku.rate_cents_per_unit })
        .from(cloud_billing_sku)
        .where(
          and(
            eq(cloud_billing_sku.id, SANDBOX_USAGE_SKUS.SandboxContainersCodeReview),
            eq(cloud_billing_sku.unit, 'second'),
            eq(cloud_billing_sku.accepts_new_usage, true)
          )
        )
        .limit(1);
      return { enabled: true, hourlyUsd: rate ? Number(rate.rate) * 36 : null };
    }),
  rates: baseProcedure.query(() => readComputeRates(db)),
  personalBillingMode: baseProcedure
    .input(z.object({ instance: z.enum(CLOUDFLARE_CONTAINERS_INSTANCES) }))
    .query(async ({ ctx, input }) => ({
      billingMode: await readPersonalContainersBillingMode(ctx.user.id, input.instance),
    })),
  sessionCharges: baseProcedure
    .input(
      z.object({
        cloudAgentSessionId: z.string().pipe(cloudAgentSessionIdSchema),
        organizationId: z.uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const session = await queryAccessibleCloudAgentSession(db, {
        kiloUserId: ctx.user.id,
        cloudAgentSessionId: input.cloudAgentSessionId,
        expectedOrganizationId: input.organizationId ?? null,
      });
      const charges = session
        ? await readSessionComputeCharges(db, {
            kiloSessionId: session.kiloSessionId,
            userId: ctx.user.id,
            organizationId: session.organizationId,
          })
        : null;
      if (charges === null) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Session not found or access denied' });
      }
      return charges;
    }),
  charges: baseProcedure.input(computeChargesInputSchema).query(async ({ ctx, input }) => {
    if (input.organizationId === undefined) {
      return readComputeCharges(db, { ...input, scope: { type: 'personal', userId: ctx.user.id } });
    }
    await ensureOrganizationAccess(
      ctx,
      input.organizationId,
      input.view === 'all' ? ORGANIZATION_BILLING_ROLES : undefined
    );
    return readComputeCharges(db, {
      ...input,
      scope: {
        type: 'organization',
        organizationId: input.organizationId,
        ...(input.view === 'self' ? { memberId: ctx.user.id } : {}),
      },
    });
  }),
});
