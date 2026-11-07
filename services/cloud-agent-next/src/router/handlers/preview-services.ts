import { z } from 'zod';
import { withLogTags } from '../../logger.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { ListPreviewServicesOutputSchema } from '../../shared/preview-services.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';

export const listPreviewServices = protectedProcedure
  .input(z.object({ cloudAgentSessionId: sessionIdSchema }).strict())
  .output(ListPreviewServicesOutputSchema)
  .query(({ input, ctx }) =>
    withLogTags({ source: 'listPreviewServices' }, async () => {
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
    })
  );
