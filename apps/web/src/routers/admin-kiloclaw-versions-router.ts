import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_image_catalog,
  kiloclaw_instances,
  kiloclaw_version_pins,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq, desc, sql, or, ilike, inArray, and, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { TRPCError } from '@trpc/server';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';

/**
 * Resolve a user's active personal instance, throwing NOT_FOUND if none exists.
 * Used by admin pin operations that accept userId and need an instanceId.
 */
async function requireActivePersonalInstance(userId: string) {
  const [instance] = await db
    .select({ id: kiloclaw_instances.id })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .limit(1);
  if (!instance) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'User has no active personal KiloClaw instance',
    });
  }
  return instance;
}
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
  instanceId: z.uuid().optional(),
});

const SetPinSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.uuid().optional(),
  imageTag: z.string().min(1),
  reason: z.string().optional(),
});

const RemovePinSchema = z.object({
  instanceId: z.uuid(),
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
      // Disabling: route through the kiloclaw service so status='disabled' AND
      // rollout_percent=0 land atomically along with a KV pointer refresh. The
      // service is the only place that can keep KV pointers consistent without
      // races.
      if (input.status === 'disabled') {
        // Refuse to disable the row currently marked :latest. The service
        // enforces this too, but doing the check here gives a cleaner error.
        const [row] = await db
          .select({ is_latest: kiloclaw_image_catalog.is_latest })
          .from(kiloclaw_image_catalog)
          .where(eq(kiloclaw_image_catalog.image_tag, input.imageTag))
          .limit(1);
        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Version not found' });
        }
        if (row.is_latest) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Cannot disable the current :latest image. Promote a replacement first.',
          });
        }

        const client = new KiloClawInternalClient();
        try {
          await client.disableImageAndClearRollout(input.imageTag, ctx.user.id);
        } catch (err) {
          if (err instanceof KiloClawApiError && err.statusCode === 404) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Image not found: ${input.imageTag}`,
            });
          }
          if (err instanceof KiloClawApiError && err.statusCode === 400) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
          }
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to disable image',
            cause: err,
          });
        }

        const [updated] = await db
          .select()
          .from(kiloclaw_image_catalog)
          .where(eq(kiloclaw_image_catalog.image_tag, input.imageTag))
          .limit(1);
        if (!updated) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Version not found after disable',
          });
        }
        return updated;
      }

      // Re-enabling (status: 'available') is a plain catalog update — no KV impact.
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

  setRolloutPercent: adminProcedure
    .input(
      z.object({
        imageTag: z.string().min(1),
        percent: z.number().int().min(0).max(100),
      })
    )
    .mutation(async ({ input }) => {
      const client = new KiloClawInternalClient();
      try {
        return await client.setRolloutPercent(input.imageTag, input.percent);
      } catch (err) {
        if (err instanceof KiloClawApiError && err.statusCode === 404) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Image not found or not available: ${input.imageTag}`,
          });
        }
        if (err instanceof KiloClawApiError && err.statusCode === 400) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
        }
        throw err;
      }
    }),

  markLatest: adminProcedure
    .input(z.object({ imageTag: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const client = new KiloClawInternalClient();
      try {
        return await client.markImageAsLatest(input.imageTag);
      } catch (err) {
        if (err instanceof KiloClawApiError && err.statusCode === 404) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Image not found: ${input.imageTag}`,
          });
        }
        if (err instanceof KiloClawApiError && err.statusCode === 400) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
        }
        throw err;
      }
    }),

  listPins: adminProcedure.input(ListPinsSchema).query(async ({ input }) => {
    const { offset, limit } = input;
    const pinnedByUser = alias(kilocode_users, 'pinned_by_user');

    const [items, countResult] = await Promise.all([
      db
        .select({
          pin: kiloclaw_version_pins,
          instance_id: kiloclaw_instances.id,
          user_email: kilocode_users.google_user_email,
          openclaw_version: kiloclaw_image_catalog.openclaw_version,
          variant: kiloclaw_image_catalog.variant,
          pinned_by_email: pinnedByUser.google_user_email,
        })
        .from(kiloclaw_version_pins)
        .leftJoin(kiloclaw_instances, eq(kiloclaw_version_pins.instance_id, kiloclaw_instances.id))
        .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
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
        instance_id: row.instance_id,
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
    const resolvedInstanceId =
      input.instanceId ?? (await requireActivePersonalInstance(input.userId)).id;
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
      .where(eq(kiloclaw_version_pins.instance_id, resolvedInstanceId))
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
    const resolvedInstanceId =
      input.instanceId ?? (await requireActivePersonalInstance(input.userId)).id;
    let result;
    try {
      [result] = await db
        .insert(kiloclaw_version_pins)
        .values({
          instance_id: resolvedInstanceId,
          image_tag: input.imageTag,
          pinned_by: ctx.user.id,
          reason: input.reason ?? null,
        })
        .onConflictDoUpdate({
          target: kiloclaw_version_pins.instance_id,
          set: {
            image_tag: input.imageTag,
            pinned_by: ctx.user.id,
            reason: input.reason ?? null,
            updated_at: new Date().toISOString(),
          },
        })
        .returning();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('foreign key')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Image tag '${input.imageTag}' not found in catalog`,
        });
      }
      throw err;
    }

    if (!result) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create pin' });
    }

    return result;
  }),

  removePin: adminProcedure.input(RemovePinSchema).mutation(async ({ input }) => {
    const [deleted] = await db
      .delete(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, input.instanceId))
      .returning();

    if (!deleted) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No pin found for this user' });
    }

    return { success: true };
  }),

  getLatestTag: adminProcedure.query(async () => {
    // Catalog-driven: the :latest badge tracks the is_latest column directly,
    // not a KV pointer (which can be stale or out of sync with the catalog).
    const [row] = await db
      .select({ image_tag: kiloclaw_image_catalog.image_tag })
      .from(kiloclaw_image_catalog)
      .where(
        and(
          eq(kiloclaw_image_catalog.is_latest, true),
          eq(kiloclaw_image_catalog.status, 'available')
        )
      )
      .limit(1);
    return row?.image_tag ?? null;
  }),

  /**
   * Returns the variant's :latest and active candidate rows independent of
   * the paginated catalog list. The Versions admin page uses this for the
   * hero panel and for the StartRolloutButton's "clear existing candidate"
   * logic — both must reflect global state, not just whatever's on the
   * current page of `listVersions`.
   */
  getActiveRollout: adminProcedure
    .input(z.object({ variant: z.string().default('default') }))
    .query(async ({ input }) => {
      const rows = await db
        .select()
        .from(kiloclaw_image_catalog)
        .where(
          and(
            eq(kiloclaw_image_catalog.variant, input.variant),
            eq(kiloclaw_image_catalog.status, 'available')
          )
        );

      const latest = rows.find(r => r.is_latest) ?? null;
      const candidate = rows.find(r => !r.is_latest && r.rollout_percent > 0) ?? null;
      return { latest, candidate };
    }),

  syncCatalog: adminProcedure.mutation(async () => {
    const client = new KiloClawInternalClient();
    let kvVersions;
    try {
      kvVersions = await client.listVersions();
    } catch (err) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch versions from KiloClaw service',
        cause: err,
      });
    }

    // Early return if KV has no versions
    if (kvVersions.length === 0) {
      return { synced: 0, alreadyExisted: 0, invalid: 0, total: 0 };
    }

    // Fetch only existing tags that match KV versions (more memory-efficient)
    const kvTags = kvVersions.map(v => v.imageTag);
    const existingTags = new Set(
      (
        await db
          .select({ image_tag: kiloclaw_image_catalog.image_tag })
          .from(kiloclaw_image_catalog)
          .where(inArray(kiloclaw_image_catalog.image_tag, kvTags))
      ).map(row => row.image_tag)
    );

    // Filter out entries that already exist in Postgres
    const newEntries = kvVersions.filter(entry => !existingTags.has(entry.imageTag));

    // Validate entries before inserting — KV data may be malformed.
    // Uses the same rules as validateEntry() in catalog-registration.ts.
    const IMAGE_TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
    const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}$/;
    const VARIANT_RE = /^[a-z0-9-]{1,64}$/;
    const validEntries = newEntries.filter(entry => {
      if (!IMAGE_TAG_RE.test(entry.imageTag) || entry.imageTag.length > 128) return false;
      if (!VERSION_RE.test(entry.openclawVersion)) return false;
      if (!VARIANT_RE.test(entry.variant)) return false;
      const ts = new Date(entry.publishedAt).getTime();
      if (isNaN(ts)) return false;
      return true;
    });
    const invalidCount = newEntries.length - validEntries.length;

    // Bulk insert validated new entries. onConflictDoNothing guards against
    // concurrent syncs inserting the same tag between our check and insert.
    if (validEntries.length > 0) {
      await db
        .insert(kiloclaw_image_catalog)
        .values(
          validEntries.map(entry => ({
            openclaw_version: entry.openclawVersion,
            variant: entry.variant,
            image_tag: entry.imageTag,
            image_digest: entry.imageDigest,
            status: 'available' as const,
            published_at: entry.publishedAt,
          }))
        )
        .onConflictDoNothing();
    }

    return {
      synced: validEntries.length,
      alreadyExisted: existingTags.size,
      invalid: invalidCount,
      total: kvVersions.length,
    };
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
