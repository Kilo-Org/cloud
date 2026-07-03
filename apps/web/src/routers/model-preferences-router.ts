import 'server-only';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { user_model_preferences } from '@kilocode/db/schema';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';

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
  get: baseProcedure.input(getInput ?? z.object({}).optional()).query(async ({ ctx, input }) => {
    const organizationId = input?.organizationId;
    const allowed = await getAllowedModelIdsForOrg(organizationId);

    const row = await db.query.user_model_preferences.findFirst({
      where: eq(user_model_preferences.user_id, ctx.user.id),
    });

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
    const row = await db.query.user_model_preferences.findFirst({
      where: eq(user_model_preferences.user_id, ctx.user.id),
    });
    const current = row?.favorites ?? [];
    if (current.includes(input.model)) {
      return { success: true };
    }
    const next = [...current, input.model];
    await db
      .insert(user_model_preferences)
      .values({ user_id: ctx.user.id, favorites: next })
      .onConflictDoUpdate({
        target: user_model_preferences.user_id,
        set: { favorites: next, updated_at: sql`now()` },
      });
    return { success: true };
  }),

  removeFavorite: baseProcedure.input(modelIdInput).mutation(async ({ ctx, input }) => {
    const row = await db.query.user_model_preferences.findFirst({
      where: eq(user_model_preferences.user_id, ctx.user.id),
    });
    const current = row?.favorites ?? [];
    if (!current.includes(input.model)) {
      return { success: true };
    }
    const next = current.filter(id => id !== input.model);
    await db
      .insert(user_model_preferences)
      .values({ user_id: ctx.user.id, favorites: next })
      .onConflictDoUpdate({
        target: user_model_preferences.user_id,
        set: { favorites: next, updated_at: sql`now()` },
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
