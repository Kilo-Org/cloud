import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { kiloclaw_image_catalog, kiloclaw_version_pins, kilocode_users } from '@kilocode/db/schema';
import { eq, desc, sql, or, ilike } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

const ListVersionsSchema = z.object({
  offset: z.number().min(0).default(0),
  limit: z.number().min(1).max(100).default(25),
  status: z.enum(['available', 'disabled']).optional(),
});

const UpdateVersionStatusSchema = z.object({
  imageTag: z.string().min(1),
  status: z.enum(['available', 'disabled']),
});

const ListPinsSchema = z.object({
  offset: z.number().min(0).default(0),
  limit: z.number().min(1).max(100).default(25),
});

const GetUserPinSchema = z.object({
  userId: z.string().min(1),
});

const SetPinSchema = z.object({
  userId: z.string().min(1),
  imageTag: z.string().min(1),
  reason: z.string().optional(),
});

const RemovePinSchema = z.object({
  userId: z.string().min(1),
});

export const adminKiloclawVersionsRouter = createTRPCRouter({
  listVersions: adminProcedure.input(ListVersionsSchema).query(async ({ input }) => {
    const { offset, limit, status } = input;

    const whereCondition = status ? eq(kiloclaw_image_catalog.status, status) : undefined;

    const [items, countResult] = await Promise.all([
      db
        .select()
        .from(kiloclaw_image_catalog)
        .where(whereCondition)
        .orderBy(desc(kiloclaw_image_catalog.published_at))
        .offset(offset)
        .limit(limit),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(kiloclaw_image_catalog)
        .where(whereCondition),
    ]);

    const totalCount = countResult[0]?.count ?? 0;

    return {
      items,
      pagination: {
        offset,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    };
  }),

  updateVersionStatus: adminProcedure
    .input(UpdateVersionStatusSchema)
    .mutation(async ({ input, ctx }) => {
      const [updated] = await db
        .update(kiloclaw_image_catalog)
        .set({
          status: input.status,
          updated_by: ctx.user.id,
          updated_at: new Date().toISOString(),
        })
        .where(eq(kiloclaw_image_catalog.image_tag, input.imageTag))
        .returning();

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Version not found' });
      }

      return updated;
    }),

  listPins: adminProcedure.input(ListPinsSchema).query(async ({ input }) => {
    const { offset, limit } = input;
    const pinnedByUser = alias(kilocode_users, 'pinned_by_user');

    const [items, countResult] = await Promise.all([
      db
        .select({
          pin: kiloclaw_version_pins,
          user_email: kilocode_users.google_user_email,
          openclaw_version: kiloclaw_image_catalog.openclaw_version,
          variant: kiloclaw_image_catalog.variant,
          pinned_by_email: pinnedByUser.google_user_email,
        })
        .from(kiloclaw_version_pins)
        .leftJoin(kilocode_users, eq(kiloclaw_version_pins.user_id, kilocode_users.id))
        .leftJoin(
          kiloclaw_image_catalog,
          eq(kiloclaw_version_pins.image_tag, kiloclaw_image_catalog.image_tag)
        )
        .leftJoin(pinnedByUser, eq(kiloclaw_version_pins.pinned_by, pinnedByUser.id))
        .orderBy(desc(kiloclaw_version_pins.created_at))
        .offset(offset)
        .limit(limit),
      db.select({ count: sql<number>`COUNT(*)::int` }).from(kiloclaw_version_pins),
    ]);

    const totalCount = countResult[0]?.count ?? 0;

    return {
      items: items.map(row => ({
        ...row.pin,
        user_email: row.user_email,
        openclaw_version: row.openclaw_version,
        variant: row.variant,
        pinned_by_email: row.pinned_by_email,
      })),
      pagination: {
        offset,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    };
  }),

  getUserPin: adminProcedure.input(GetUserPinSchema).query(async ({ input }) => {
    const pinnedByUser = alias(kilocode_users, 'pinned_by_user');
    const [result] = await db
      .select({
        pin: kiloclaw_version_pins,
        openclaw_version: kiloclaw_image_catalog.openclaw_version,
        variant: kiloclaw_image_catalog.variant,
        pinned_by_email: pinnedByUser.google_user_email,
      })
      .from(kiloclaw_version_pins)
      .leftJoin(
        kiloclaw_image_catalog,
        eq(kiloclaw_version_pins.image_tag, kiloclaw_image_catalog.image_tag)
      )
      .leftJoin(pinnedByUser, eq(kiloclaw_version_pins.pinned_by, pinnedByUser.id))
      .where(eq(kiloclaw_version_pins.user_id, input.userId))
      .limit(1);

    if (!result) return null;

    return {
      ...result.pin,
      openclaw_version: result.openclaw_version,
      variant: result.variant,
      pinned_by_email: result.pinned_by_email,
    };
  }),

  setPin: adminProcedure.input(SetPinSchema).mutation(async ({ input, ctx }) => {
    const [result] = await db
      .insert(kiloclaw_version_pins)
      .values({
        user_id: input.userId,
        image_tag: input.imageTag,
        pinned_by: ctx.user.id,
        reason: input.reason ?? null,
      })
      .onConflictDoUpdate({
        target: kiloclaw_version_pins.user_id,
        set: {
          image_tag: input.imageTag,
          pinned_by: ctx.user.id,
          reason: input.reason ?? null,
          updated_at: new Date().toISOString(),
        },
      })
      .returning();

    if (!result) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create pin' });
    }

    return result;
  }),

  removePin: adminProcedure.input(RemovePinSchema).mutation(async ({ input }) => {
    const [deleted] = await db
      .delete(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.user_id, input.userId))
      .returning();

    if (!deleted) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No pin found for this user' });
    }

    return { success: true };
  }),

  searchUsers: adminProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      const escaped = input.query.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const result = await db
        .select({
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
          name: kilocode_users.google_user_name,
        })
        .from(kilocode_users)
        .where(
          or(
            ilike(kilocode_users.google_user_email, `%${escaped}%`),
            ilike(kilocode_users.google_user_name, `%${escaped}%`),
            eq(kilocode_users.id, input.query)
          )
        )
        .limit(20);

      return result;
    }),
});
