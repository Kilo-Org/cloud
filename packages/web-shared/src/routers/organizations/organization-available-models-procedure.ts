import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import {
  OrganizationIdInputSchema,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';

// Its own module so the gateway's organization model routes can mount this
// procedure without the rest of the settings router.
export const listAvailableModelsProcedure = organizationMemberProcedure
  .input(OrganizationIdInputSchema)
  .output(z.custom<OpenRouterModelsResponse>())
  .query(async ({ input, ctx }) => {
    const { organizationId } = input;

    const result = await getAvailableModelsForOrganization(organizationId, {
      type: 'member',
      kiloUserId: ctx.user.id,
      // `ensureOrganizationAccess` also admits Kilo admins and parent-organization
      // owners, who hold no membership row and belong to no group; they resolve
      // against organization-level policy instead of being rejected.
      allowNonMember: true,
    });
    if (!result) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }
    return result;
  });
