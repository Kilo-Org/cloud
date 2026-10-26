import 'server-only';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { user_model_preferences } from '@kilocode/db/schema';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { createDirectByokReferenceResolver } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { byokOwner } from '@kilocode/web-shared/lib/ai-gateway/byok';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';

const lastSelectedInput = z.object({
  model: z.string().min(1),
  variant: z.string().min(1).optional(),
});

const modelIdInput = z.object({
  model: z.string().min(1),
});

// The organization whose BYOK keys translated the favorites the caller saw.
const organizationIdInput = z.object({
  organizationId: z.string().min(1).optional(),
});

const removeFavoriteInput = modelIdInput.extend(organizationIdInput.shape);

const setFavoritesInput = organizationIdInput.extend({
  models: z.array(z.string().min(1)).max(500),
});

const getInput = z
  .object({
    organizationId: z.string().min(1).optional(),
  })
  .optional();

async function getAllowedModelIdsForOrg(
  organizationId: string | undefined,
  kiloUserId: string
): Promise<Set<string> | null> {
  if (!organizationId) {
    return null;
  }
  const response = await getAvailableModelsForOrganization(
    organizationId,
    {
      type: 'member',
      kiloUserId,
      // Callers reach this after `ensureOrganizationAccess`, which also admits Kilo
      // admins and parent-organization owners without a membership row.
      allowNonMember: true,
    },
    'member',
    { countryCode: null }
  );
  if (!response) {
    return new Set();
  }
  return new Set(response.data.map(model => model.id));
}

function isAllowed(id: string, allowed: Set<string> | null): boolean {
  return allowed === null || allowed.has(id);
}

type ReferenceResolver = (modelId: string) => Promise<string | null>;

async function favoritesResolver(
  ctx: TRPCContext,
  organizationId: string | undefined
): Promise<ReferenceResolver> {
  if (organizationId) {
    await ensureOrganizationAccess(ctx, organizationId);
  }
  return createDirectByokReferenceResolver(byokOwner(ctx.user.id, organizationId));
}

async function storedFavorites(userId: string): Promise<string[]> {
  const row = await db.query.user_model_preferences.findFirst({
    columns: { favorites: true },
    where: eq(user_model_preferences.user_id, userId),
  });
  return row?.favorites ?? [];
}

async function resolveAll(ids: string[], resolveReference: ReferenceResolver) {
  return Promise.all(ids.map(async id => ({ id, resolved: await resolveReference(id) })));
}

/**
 * Favorites are read with bespoke ids of catalog-mode keys translated, but stored unchanged, so
 * turning catalog mode off restores them. A full replacement keeps a stored original in place of
 * its translation, and keeps the originals the reader could not see.
 */
async function withStoredOriginals(
  favorites: string[],
  stored: string[],
  resolveReference: ReferenceResolver
): Promise<string[]> {
  const originals = new Map<string, string>();
  const hidden: string[] = [];
  for (const { id, resolved } of await resolveAll(stored, resolveReference)) {
    if (resolved === null) hidden.push(id);
    else if (resolved !== id && !favorites.includes(id) && !originals.has(resolved)) {
      originals.set(resolved, id);
    }
  }
  return [...new Set([...favorites.map(id => originals.get(id) ?? id), ...hidden])];
}

export const modelPreferencesRouter = createTRPCRouter({
  get: baseProcedure.input(getInput).query(async ({ ctx, input }) => {
    const organizationId = input?.organizationId;
    if (organizationId) {
      await ensureOrganizationAccess(ctx, organizationId);
    }

    const [allowed, row, resolveReference] = await Promise.all([
      getAllowedModelIdsForOrg(organizationId, ctx.user.id),
      db.query.user_model_preferences.findFirst({
        where: eq(user_model_preferences.user_id, ctx.user.id),
      }),
      createDirectByokReferenceResolver(byokOwner(ctx.user.id, organizationId)),
    ]);

    const resolvedFavorites = await resolveAll(row?.favorites ?? [], resolveReference);
    const favorites = [
      ...new Set(
        resolvedFavorites.flatMap(({ resolved }) =>
          resolved !== null && isAllowed(resolved, allowed) ? [resolved] : []
        )
      ),
    ];
    const lastSelectedModel = row?.last_selected
      ? await resolveReference(row.last_selected.model)
      : null;
    const lastSelected =
      row?.last_selected && lastSelectedModel !== null && isAllowed(lastSelectedModel, allowed)
        ? { ...row.last_selected, model: lastSelectedModel }
        : null;

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

  removeFavorite: baseProcedure.input(removeFavoriteInput).mutation(async ({ ctx, input }) => {
    const resolveReference = await favoritesResolver(ctx, input.organizationId);
    // Also remove stored originals that were read as this id, or the favorite would reappear.
    const originals = (await resolveAll(await storedFavorites(ctx.user.id), resolveReference))
      .filter(({ id, resolved }) => resolved === input.model && id !== input.model)
      .map(({ id }) => id);
    const removed = sql.join(
      [input.model, ...originals].map(id => sql`${id}`),
      sql`, `
    );
    await db
      .insert(user_model_preferences)
      .values({ user_id: ctx.user.id, favorites: [] })
      .onConflictDoUpdate({
        target: user_model_preferences.user_id,
        set: {
          favorites: sql`${user_model_preferences.favorites} - ARRAY[${removed}]::text[]`,
          updated_at: sql`now()`,
        },
      });
    return { success: true };
  }),

  setFavorites: baseProcedure.input(setFavoritesInput).mutation(async ({ ctx, input }) => {
    const resolveReference = await favoritesResolver(ctx, input.organizationId);
    const deduped = await withStoredOriginals(
      Array.from(new Set(input.models)),
      await storedFavorites(ctx.user.id),
      resolveReference
    );
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
