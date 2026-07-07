import 'server-only';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { user_model_preferences } from '@kilocode/db/schema';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

const lastSelectedInput = z.object({
  model: z.string().min(1),
  variant: z.string().min(1).optional(),
});

const modelIdInput = z.object({
  model: z.string().min(1),
});

const setFavoritesInput = z.object({
  models: z.array(z.string().min(1)).max(500),
});

const getInput = z
  .object({
    organizationId: z.string().min(1).optional(),
  })
  .optional();

async function getAllowedModelIdsForOrg(
  organizationId: string | undefined
): Promise<Set<string> | null> {
  if (!organizationId) {
    return null;
  }
  const response = await getAvailableModelsForOrganization(organizationId);
  if (!response) {
    return new Set();
  }
  return new Set(response.data.map(model => model.id));
}

function isAllowed(id: string, allowed: Set<string> | null): boolean {
  return allowed === null || allowed.has(id);
}

export const modelPreferencesRouter = createTRPCRouter({
  get: baseProcedure.input(getInput).query(async ({ ctx, input }) => {
    const organizationId = input?.organizationId;
    if (organizationId) {
      await ensureOrganizationAccess(ctx, organizationId);
    }

    const [allowed, row] = await Promise.all([
      getAllowedModelIdsForOrg(organizationId),
      db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, ctx.user.id),
      }),
    ]);

    const favorites = (row?.favorites ?? []).filter(id => isAllowed(id, allowed));
    const lastSelected =
      row?.last_selected && isAllowed(row.last_selected.model, allowed) ? row.last_selected : null;

    return { favorites, lastSelected };
  }),

  setLastSelected: baseProcedure.input(lastSelectedInput).mutation(async ({ ctx, input }) => {
    await db
      .insert(user_model_preferences)
      .values({
        user_id: ctx.user.id,
        last_selected: { model: input.model, variant: input.variant },
      })
      .onConflictDoUpdate({
        target: user_model_preferences.user_id,
        set: {
          last_selected: { model: input.model, variant: input.variant },
          updated_at: sql`now()`,
        },
      });
    return { success: true };
  }),

  clearLastSelected: baseProcedure.mutation(async ({ ctx }) => {
    await db
      .insert(user_model_preferences)
      .values({ user_id: ctx.user.id, last_selected: null })
      .onConflictDoUpdate({
        target: user_model_preferences.user_id,
        set: { last_selected: null, updated_at: sql`now()` },
      });
    return { success: true };
  }),

  addFavorite: baseProcedure.input(modelIdInput).mutation(async ({ ctx, input }) => {
    const appended = JSON.stringify([input.model]);
    await db
      .insert(user_model_preferences)
      .values({ user_id: ctx.user.id, favorites: [input.model] })
      .onConflictDoUpdate({
        target: user_model_preferences.user_id,
        set: {
          favorites: sql`CASE WHEN ${user_model_preferences.favorites} @> ${appended}::jsonb THEN ${user_model_preferences.favorites} ELSE ${user_model_preferences.favorites} || ${appended}::jsonb END`,
          updated_at: sql`now()`,
        },
      });
    return { success: true };
  }),

  removeFavorite: baseProcedure.input(modelIdInput).mutation(async ({ ctx, input }) => {
    await db
      .insert(user_model_preferences)
      .values({ user_id: ctx.user.id, favorites: [] })
      .onConflictDoUpdate({
        target: user_model_preferences.user_id,
        set: {
          favorites: sql`${user_model_preferences.favorites} - ${input.model}::text`,
          updated_at: sql`now()`,
        },
      });
    return { success: true };
  }),

  setFavorites: baseProcedure.input(setFavoritesInput).mutation(async ({ ctx, input }) => {
    const deduped = Array.from(new Set(input.models));
    await db
      .insert(user_model_preferences)
      .values({ user_id: ctx.user.id, favorites: deduped })
      .onConflictDoUpdate({
        target: user_model_preferences.user_id,
        set: { favorites: deduped, updated_at: sql`now()` },
      });
    return { success: true };
  }),
});
