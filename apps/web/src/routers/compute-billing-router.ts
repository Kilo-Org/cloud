import { z } from 'zod';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { readComputeCharges, readComputeRates } from '@/lib/cloud-agent/compute-billing';

export const computeChargesInputSchema = z
  .object({
    organizationId: z.uuid().optional(),
    view: z.enum(['self', 'all']).default('self'),
    startDate: z.iso.datetime(),
    endDate: z.iso.datetime(),
    groupBy: z.enum(['day', 'session']).default('day'),
    page: z.number().int().min(0).max(1000).default(0),
  })
  .refine(input => {
    const duration = Date.parse(input.endDate) - Date.parse(input.startDate);
    return duration > 0 && duration <= 366 * 86_400_000;
  }, 'Choose a date range of at most one year.');

export const computeBillingRouter = createTRPCRouter({
  rates: baseProcedure.query(() => readComputeRates(db)),
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
