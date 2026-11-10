import { z } from 'zod';
import { withLogTags } from '../../logger.js';
import { resolveWorkspacePreviewTarget } from '../../preview/workspace-target.js';
import { getSandboxControlStub } from '../../sandbox-control/stub.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { ListPreviewServicesOutputSchema } from '../../shared/preview-services.js';
import { previewTargetSchema } from '../../shared/preview-target.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';

const previewServicesInputSchema = z.intersection(
  previewTargetSchema,
  z.object({ organizationId: z.uuid().optional() })
);

export const listPreviewServices = protectedProcedure
  .input(previewServicesInputSchema)
  .output(ListPreviewServicesOutputSchema)
  .query(({ input, ctx }) =>
    withLogTags({ source: 'listPreviewServices' }, async () => {
      if (input.cloudAgentSessionId !== undefined) {
        await requireCurrentSessionAccess({
          env: ctx.env,
          kiloUserId: ctx.userId,
          cloudAgentSessionId: input.cloudAgentSessionId,
        });
        return withDORetry(
          () => getSandboxSessionStub(ctx.env, ctx.userId, input.cloudAgentSessionId),
          session => session.listPreviewServices(),
          'listPreviewServices'
        );
      }

      const organizationId = input.organizationId ?? null;
      const target = await resolveWorkspacePreviewTarget({
        env: ctx.env,
        kiloUserId: ctx.userId,
        worktreeId: input.worktreeId,
        expectedOrganizationId: organizationId,
      });
      if (target.status === 'ok') {
        return withDORetry(
          () => getSandboxControlStub(ctx.env, target.coordinates.logicalSandboxId),
          sandbox =>
            sandbox.previewServices({
              ownerId: ctx.userId,
              organizationId,
              scopeId: input.worktreeId,
            }),
          'previewServices'
        );
      }
      if (target.status === 'not_ready') return { services: [], status: 'not_ready' as const };
      if (target.status === 'not_running') return { services: [], status: 'not_running' as const };
      return { services: [], status: 'unsupported' as const };
    })
  );
