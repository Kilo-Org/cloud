import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import * as z from 'zod';
import {
  ensureInternalBotUser,
  InternalBotUnusableError,
  listInternalBotUsers,
} from '@/lib/bot-users/bot-user-service';
import { INTERNAL_BOT_SLUG_PATTERN } from '@/lib/bot-users/types';
import { recordAdminAction, userActionTarget } from '@/lib/admin/admin-action-audit';

export const CreateInternalBotUserInputSchema = z.object({
  slug: z
    .string()
    .regex(
      INTERNAL_BOT_SLUG_PATTERN,
      'Slug must start with a lowercase letter or digit and use only a-z, 0-9 and hyphens (max 41)'
    ),
  displayName: z.string().trim().min(1).max(100),
  organizationId: z.string().uuid(),
});

export const adminInternalBotUsersRouter = createTRPCRouter({
  list: adminProcedure.query(() => listInternalBotUsers()),

  create: adminProcedure
    .input(CreateInternalBotUserInputSchema)
    .mutation(async ({ input, ctx }) => {
      const [organization] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.id, input.organizationId), isNull(organizations.deleted_at)))
        .limit(1);
      if (!organization) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      try {
        const { user, created } = await ensureInternalBotUser(input);
        if (created) {
          await recordAdminAction(ctx, {
            action: 'internal_bot_user.create',
            target: userActionTarget(user.id),
            message: 'Created internal bot user',
            metadata: { slug: input.slug, organizationId: input.organizationId },
          });
        }
        return { id: user.id, created };
      } catch (error) {
        if (error instanceof InternalBotUnusableError) {
          throw new TRPCError({ code: 'CONFLICT', message: error.message });
        }
        throw error;
      }
    }),
});
