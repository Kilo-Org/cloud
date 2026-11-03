import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  createRequestLoggingOptIn,
  deleteRequestLoggingOptIn,
  getRequestLoggingOptIns,
  type RequestLoggingOptIn,
} from '@kilocode/web-shared/lib/ai-gateway/request-logging-opt-ins';
import {
  organizationActionTarget,
  recordAdminAction,
  userActionTarget,
} from '@/lib/admin/admin-action-audit';

const CreateOptInSchema = z.object({
  target_type: z.enum(['account', 'organization']),
  target_id: z.string().trim().min(1).max(255),
  reason: z.string().trim().min(1).max(1000),
  errors_only: z.boolean().default(false),
  expires_at: z
    .string()
    .datetime()
    .refine(value => Date.parse(value) > Date.now(), 'End date must be in the future.')
    .optional(),
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
      errors_only: input.errors_only,
      expires_at: input.expires_at,
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
        message: 'The limit of 10 active request logging opt-ins has been reached.',
      });
    }
    await recordAdminAction(ctx, {
      action: 'request_logging_opt_in.create',
      target:
        entry.target_type === 'account'
          ? userActionTarget(entry.target_id)
          : organizationActionTarget(entry.target_id),
      message: 'Enabled API request logging opt-in',
      metadata: {
        opt_in_id: entry.id,
        errors_only: entry.errors_only,
        expires_at: entry.expires_at ?? null,
      },
    });
    return entry;
  }),

  delete: adminProcedure.input(DeleteOptInSchema).mutation(async ({ input, ctx }) => {
    const entry = await deleteRequestLoggingOptIn(input.id);
    if (!entry) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Request logging opt-in not found.' });
    }
    await recordAdminAction(ctx, {
      action: 'request_logging_opt_in.delete',
      target:
        entry.target_type === 'account'
          ? userActionTarget(entry.target_id)
          : organizationActionTarget(entry.target_id),
      message: 'Deleted API request logging opt-in',
      metadata: {
        opt_in_id: entry.id,
        errors_only: entry.errors_only,
        expires_at: entry.expires_at ?? null,
      },
    });
    return { id: input.id };
  }),
});
