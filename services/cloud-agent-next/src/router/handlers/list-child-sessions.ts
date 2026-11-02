import { TRPCError } from '@trpc/server';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { z } from 'zod';
import { listCloudAgentChildSessions } from '../../cloud-agent-child-management.js';
import { sessionIdSchema } from '../../types.js';
import { cloudAgentAuthorityProcedure } from '../auth.js';
import { MessageIdSchema } from '../schemas.js';

export const listChildSessionsInput = z
  .object({
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.uuid().optional(),
    organizationId: z.string().min(1).optional(),
  })
  .strict();

export const listChildSessionsOutput = z
  .object({
    sessions: z.array(
      z
        .object({
          cloudAgentSessionId: sessionIdSchema,
          initialMessageId: MessageIdSchema.optional(),
          worktreeId: cloudAgentWorktreeIdSchema.optional(),
        })
        .strict()
    ),
    nextCursor: z.uuid().optional(),
  })
  .strict();

export const listChildSessions = cloudAgentAuthorityProcedure
  .input(listChildSessionsInput)
  .output(listChildSessionsOutput)
  .query(async ({ input, ctx }) => {
    if (!ctx.cloudAgentAuthority) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Cloud Agent authority required',
      });
    }
    return listCloudAgentChildSessions({
      env: ctx.env,
      authority: ctx.cloudAgentAuthority,
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  });
