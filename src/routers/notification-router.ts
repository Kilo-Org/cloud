import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { generateUserNotifications } from '@/lib/notifications';
import type { KiloNotification } from '@/lib/notifications';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { successResult } from '@/lib/maybe-result';
import * as z from 'zod';

/** Returns true when a notification should be visible on the web app. */
function isWebVisible(n: KiloNotification): boolean {
  // No showIn filter → show everywhere (including web).
  // Explicit showIn array → must include 'web'.
  return !n.showIn || n.showIn.includes('web');
}

export const notificationRouter = createTRPCRouter({
  getNotifications: baseProcedure.query(async ({ ctx }) => {
    const notifications = await generateUserNotifications(ctx.user);
    const webNotifications = notifications.filter(isWebVisible);
    const readIds = (ctx.user.read_notification_ids ?? []) as string[];

    return successResult({
      notifications: webNotifications.map(n => ({
        ...n,
        read: readIds.includes(n.id),
      })),
    });
  }),

  markNotificationRead: baseProcedure
    .input(z.object({ notificationId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const currentIds = (ctx.user.read_notification_ids ?? []) as string[];
      if (currentIds.includes(input.notificationId)) {
        return successResult();
      }

      await db
        .update(kilocode_users)
        .set({
          read_notification_ids: [...currentIds, input.notificationId],
        })
        .where(eq(kilocode_users.id, ctx.user.id));

      return successResult();
    }),

  markAllNotificationsRead: baseProcedure.mutation(async ({ ctx }) => {
    const notifications = await generateUserNotifications(ctx.user);
    const webNotifications = notifications.filter(isWebVisible);
    const allIds = webNotifications.map(n => n.id);

    await db
      .update(kilocode_users)
      .set({ read_notification_ids: allIds })
      .where(eq(kilocode_users.id, ctx.user.id));

    return successResult();
  }),
});
