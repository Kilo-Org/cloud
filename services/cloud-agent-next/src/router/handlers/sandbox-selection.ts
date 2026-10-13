import { z } from 'zod';
import {
  getSandboxAllocationRequest,
  sandboxSelectionCapabilitiesSchema,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import { getPgDb } from '../../db/pg.js';
import { getSandboxSelectionCapabilities } from '../../sandbox-selection.js';
import { resolveSavedSandboxAllocation } from '../../session/sandbox-allocation-resolution.js';
import { protectedProcedure } from '../auth.js';
import { assertOrganizationMembership } from './organization-membership.js';

export const getSandboxSelectionOptions = protectedProcedure
  .input(
    z
      .object({
        kilocodeOrganizationId: z.string().uuid().optional(),
        devcontainer: z.boolean().optional(),
        repositoryType: z.enum(['github', 'gitlab', 'bitbucket', 'git']).optional(),
        repositoryFullName: z.string().min(1).max(500).optional(),
      })
      .strict()
  )
  .output(sandboxSelectionCapabilitiesSchema)
  .query(async ({ input, ctx }) => {
    if (input.kilocodeOrganizationId) {
      await assertOrganizationMembership(
        getPgDb(ctx.env),
        ctx.userId,
        input.kilocodeOrganizationId
      );
    }
    const owner = { userId: ctx.userId, orgId: input.kilocodeOrganizationId };
    const capabilities = getSandboxSelectionCapabilities(
      ctx.env,
      owner,
      input.repositoryType ? { repositoryType: input.repositoryType } : undefined
    );
    if (!capabilities.enabled || !input.repositoryType) return capabilities;

    const { repositoryType, repositoryFullName } = input;
    const saved = await resolveSavedSandboxAllocation({
      db: getPgDb(ctx.env),
      env: ctx.env,
      owner,
      repositoryType,
      ...(repositoryFullName && (repositoryType === 'github' || repositoryType === 'gitlab')
        ? { target: { platform: repositoryType, fullName: repositoryFullName } }
        : {}),
    });
    const effectiveDestination: SandboxSelectionCapabilities['effectiveDestination'] = saved
      ? getSandboxAllocationRequest(saved)
      : capabilities.defaultDestination;
    return { ...capabilities, effectiveDestination };
  });
