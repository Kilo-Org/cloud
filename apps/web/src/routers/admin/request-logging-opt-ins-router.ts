import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  createRequestLoggingOptIn,
  deleteRequestLoggingOptIn,
  getRequestLoggingOptIns,
  type RequestLoggingOptIn,
} from '@/lib/ai-gateway/request-logging-opt-ins';

const CreateOptInSchema = z.object({
  target_type: z.enum(['account', 'organization']),
  target_id: z.string().trim().min(1).max(255),
  reason: z.string().trim().min(1).max(1000),
});

const DeleteOptInSchema = z.object({ id: z.string().uuid() });

export const adminRequestLoggingOptInsRouter = createTRPCRouter({
  list: adminProcedure.query(() => getRequestLoggingOptIns()),

  create: adminProcedure.input(CreateOptInSchema).mutation(async ({ input, ctx }) => {
    const entry: RequestLoggingOptIn = {
      id: crypto.randomUUID(),
      target_type: input.target_type,
      target_id: input.target_id.trim(),
      reason: input.reason.trim(),
      added_by_email: ctx.user.google_user_email,
      added_at: new Date().toISOString(),
    };
    const result = await createRequestLoggingOptIn(entry);
    if (result === 'duplicate') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Request logging is already enabled for this ID.',
      });
    }
    if (result === 'full') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'The request logging opt-in limit has been reached.',
      });
    }
    return entry;
  }),

  delete: adminProcedure.input(DeleteOptInSchema).mutation(async ({ input }) => {
    if (!(await deleteRequestLoggingOptIn(input.id))) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Request logging opt-in not found.' });
    }
    return { id: input.id };
  }),
});
