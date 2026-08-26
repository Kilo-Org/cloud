import {
  createVerifiedDomainClaim,
  listVerifiedDomainClaims,
  refreshVerifiedDomainClaim,
  removeVerifiedDomainClaim,
} from '@/lib/organizations/verified-domain-service';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationAdminProcedure,
} from '@/routers/organizations/utils';
import * as z from 'zod';

const ClaimInputSchema = OrganizationIdInputSchema.extend({ claimId: z.uuid() });

export const organizationVerifiedDomainsRouter = createTRPCRouter({
  list: organizationAdminProcedure.query(({ input }) =>
    listVerifiedDomainClaims(input.organizationId)
  ),
  create: organizationAdminProcedure
    .input(OrganizationIdInputSchema.extend({ domain: z.string().max(512) }))
    .mutation(({ ctx, input }) =>
      createVerifiedDomainClaim(input.organizationId, input.domain, ctx.user)
    ),
  refresh: organizationAdminProcedure
    .input(ClaimInputSchema)
    .mutation(({ ctx, input }) =>
      refreshVerifiedDomainClaim(input.organizationId, input.claimId, ctx.user)
    ),
  remove: organizationAdminProcedure.input(ClaimInputSchema).mutation(async ({ ctx, input }) => {
    await removeVerifiedDomainClaim(input.organizationId, input.claimId, ctx.user);
    return { success: true };
  }),
});
