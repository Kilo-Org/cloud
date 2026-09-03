import { z } from 'zod';
import { sandboxSelectionCapabilitiesSchema } from '@kilocode/worker-utils/sandbox-allocation';
import { getPgDb } from '../../db/pg.js';
import { getSandboxSelectionCapabilities } from '../../sandbox-selection.js';
import { protectedProcedure } from '../auth.js';
import { assertOrganizationMembership } from './organization-membership.js';

export const getSandboxSelectionOptions = protectedProcedure
  .input(
    z
      .object({ kilocodeOrganizationId: z.string().uuid(), devcontainer: z.boolean().optional() })
      .strict()
  )
  .output(sandboxSelectionCapabilitiesSchema)
  .query(async ({ input, ctx }) => {
    await assertOrganizationMembership(getPgDb(ctx.env), ctx.userId, input.kilocodeOrganizationId);
    return getSandboxSelectionCapabilities(
      ctx.env,
      { userId: ctx.userId, orgId: input.kilocodeOrganizationId },
      input.devcontainer
    );
  });
