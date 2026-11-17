import { z } from 'zod';
import {
  getSandboxAllocationRequest,
  sandboxSelectionCapabilitiesSchema,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import { getPgDb } from '../../db/pg.js';
import {
  getSandboxSelectionCapabilities,
  resolveVercelSelectionReadiness,
} from '../../sandbox-selection.js';
import { resolveSavedSandboxAllocation } from '../../session/sandbox-allocation-resolution.js';
import { protectedProcedure } from '../auth.js';
import { assertOrganizationMembership } from './organization-membership.js';
import { readEnvironmentAllocationForSession } from '@kilocode/cloud-agent-profile';
import { relayChatForBrowserPrepare } from '../../session/browser-relay-capability.js';

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
    const readiness = await resolveVercelSelectionReadiness(ctx.env, owner);
    const capabilities = await getSandboxSelectionCapabilities(ctx.env, owner, {
      ...(input.repositoryType ? { repositoryType: input.repositoryType } : {}),
      ...readiness,
    });
    const environment =
      input.repositoryType === 'github' && input.repositoryFullName
        ? await readEnvironmentAllocationForSession(getPgDb(ctx.env), {
            owner: owner.orgId
              ? { type: 'organization', id: owner.orgId }
              : { type: 'user', id: owner.userId },
            repository: { platform: 'github', repoFullName: input.repositoryFullName },
          })
        : { status: 'unknown' };
    if (!capabilities.enabled || !input.repositoryType)
      return {
        ...capabilities,
        relayChatForBrowserPrepare: relayChatForBrowserPrepare(
          ctx.env,
          owner,
          capabilities,
          environment
        ),
      };

    const { repositoryType, repositoryFullName } = input;
    const saved = await resolveSavedSandboxAllocation({
      db: getPgDb(ctx.env),
      env: ctx.env,
      owner,
      repositoryType,
      // The picker does not know the environment yet (chunk 8).
      environment: null,
      readiness,
      ...(repositoryFullName && (repositoryType === 'github' || repositoryType === 'gitlab')
        ? { target: { platform: repositoryType, fullName: repositoryFullName } }
        : {}),
    });
    const effectiveDestination: SandboxSelectionCapabilities['effectiveDestination'] = saved
      ? getSandboxAllocationRequest(saved)
      : capabilities.defaultDestination;
    const result = { ...capabilities, effectiveDestination };
    return {
      ...result,
      relayChatForBrowserPrepare: relayChatForBrowserPrepare(ctx.env, owner, result, environment),
    };
  });
