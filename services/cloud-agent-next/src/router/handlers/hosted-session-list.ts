import {
  sessionIdSchema,
  validateCloudAgentRootSessionsCursor,
} from '@kilocode/session-ingest-contracts';
import { z } from 'zod';
import { protectedProcedure } from '../auth.js';

export const listHostedSessionsInput = z
  .object({
    limit: z.number().int().min(1).max(100).default(100),
    cursor: z
      .string()
      .min(1)
      .max(256)
      .refine(validateCloudAgentRootSessionsCursor, 'Invalid hosted sessions cursor')
      .optional(),
  })
  .strict();

const hostedSessionSummarySchema = z
  .object({
    kiloSessionId: sessionIdSchema,
    cloudAgentSessionId: z.string().min(1),
    userId: z.string().min(1),
    organizationId: z.string().nullable(),
    title: z.string().max(512).nullable(),
    gitUrl: z.string().max(2048).nullable(),
    gitBranch: z.string().max(512).nullable(),
    profileId: z.string().nullable(),
    createdOnPlatform: z.string().min(1),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  })
  .strict();

export const listHostedSessionsOutput = z
  .object({
    items: z.array(hostedSessionSummarySchema),
    nextCursor: z.string().min(1).max(256).refine(validateCloudAgentRootSessionsCursor).nullable(),
  })
  .strict();

export const listHostedSessions = protectedProcedure
  .input(listHostedSessionsInput)
  .output(listHostedSessionsOutput)
  .query(async ({ input, ctx }) => {
    const page = await ctx.env.SESSION_INGEST.listCloudAgentRootSessions({
      kiloUserId: ctx.userId,
      limit: input.limit,
      cursor: input.cursor,
    });
    return {
      items: page.items.map(item => ({ ...item, userId: ctx.userId })),
      nextCursor: page.nextCursor,
    };
  });
