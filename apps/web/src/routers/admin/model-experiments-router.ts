import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  microdollar_usage,
  model_experiment,
  model_experiment_request,
  model_experiment_variant,
  model_experiment_variant_version,
} from '@kilocode/db/schema';
import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { ExperimentUpstreamSchema } from '@/lib/ai-gateway/experiments/upstream-schema';
import { EXPERIMENTED_PUBLIC_IDS_REDIS_KEY, modelExperimentRedisKey } from '@/lib/redis-keys';
import { redisDel, redisSet } from '@/lib/redis';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';

type TrpcErrorCode = ConstructorParameters<typeof TRPCError>[0]['code'];

function trpcThrow(code: TrpcErrorCode, message: string): never {
  throw new TRPCError({ code, message });
}

const notFound = (entity: string): never => trpcThrow('NOT_FOUND', `${entity} not found`);
const badRequest = (message: string): never => trpcThrow('BAD_REQUEST', message);

const AllStatuses = ['draft', 'active', 'paused', 'completed'] as const;
type Status = (typeof AllStatuses)[number];

// Routing-relevant statuses. Drizzle's `inArray` types its second arg as
// a mutable array, so this is a plain `Status[]`, not `readonly`.
const ROUTING_STATUSES: Status[] = ['active', 'paused'];

const idSchema = z.object({ id: z.string().uuid() });
const variantIdSchema = z.object({ variantId: z.string().uuid() });

const labelSchema = z.string().min(1).max(64);
const weightSchema = z.number().int().positive();

const apiKeySchema = z.string().min(1);

async function loadExperimentOrThrow(id: string) {
  const row = await db.query.model_experiment.findFirst({
    where: eq(model_experiment.id, id),
  });
  return row ?? notFound('Experiment');
}

async function loadVariantOrThrow(variantId: string) {
  const row = await db.query.model_experiment_variant.findFirst({
    where: eq(model_experiment_variant.id, variantId),
  });
  return row ?? notFound('Variant');
}

async function recomputeExperimentedPublicIds() {
  const rows = await db
    .select({ public_model_id: model_experiment.public_model_id })
    .from(model_experiment)
    .where(inArray(model_experiment.status, ROUTING_STATUSES));
  const ids = Array.from(new Set(rows.map(r => r.public_model_id))).sort();
  await redisSet(EXPERIMENTED_PUBLIC_IDS_REDIS_KEY, JSON.stringify(ids));
}

/**
 * Postgres unique-constraint violation. We use this to convert the
 * `UQ_model_experiment_public_model_id_routing` partial unique index
 * violation (raised when two activates race past the friendly
 * pre-check) into a CONFLICT instead of an INTERNAL_SERVER_ERROR.
 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code?: unknown }).code === '23505';
}

type ExperimentRow = typeof model_experiment.$inferSelect;

/**
 * Common shape of every state-change mutation: load existing, run a
 * guard, write a `.set(...)` patch, return updated. The DB partial
 * unique index on `(public_model_id) WHERE status IN ('active','paused')`
 * is the authoritative concurrency guard; this helper turns its 23505
 * into a CONFLICT so the friendly message survives a TOCTOU race past
 * the pre-checks in each handler.
 *
 * `guard` may short-circuit by returning the existing row (idempotent
 * no-op transitions, e.g. re-activating an already-active experiment).
 */
// Drizzle's `.set()` accepts both column values and `SQL<unknown>` per column
// (e.g. `started_at: sql\`now()\``). `Partial<$inferInsert>` is too narrow for
// that, so we capture the actual parameter type of `.set()` here.
type UpdateExperimentValues = Parameters<
  ReturnType<typeof db.update<typeof model_experiment>>['set']
>[0];

type TransitionDecision =
  | { kind: 'proceed'; values: UpdateExperimentValues }
  | { kind: 'noop'; row: ExperimentRow };

async function applyExperimentTransition(opts: {
  id: string;
  guard: (existing: ExperimentRow) => Promise<TransitionDecision>;
}): Promise<ExperimentRow> {
  const existing = await loadExperimentOrThrow(opts.id);
  const decision = await opts.guard(existing);
  if (decision.kind === 'noop') return decision.row;
  try {
    const [updated] = await db
      .update(model_experiment)
      .set(decision.values)
      .where(eq(model_experiment.id, opts.id))
      .returning();
    if (!updated) notFound('Experiment');
    await invalidateExperimentCaches(updated.public_model_id);
    return updated;
  } catch (err) {
    if (isUniqueViolation(err)) {
      trpcThrow(
        'CONFLICT',
        `Another active or paused experiment exists for ${existing.public_model_id}`
      );
    }
    throw err;
  }
}

async function invalidateExperimentCaches(publicModelId: string) {
  // Per-public-id cache and the membership set are both touched by every
  // routing-affecting mutation. Best-effort — Redis being down does not block
  // admin writes.
  try {
    await redisDel(modelExperimentRedisKey(publicModelId));
  } catch {
    // already captured by redis helper
  }
  try {
    await recomputeExperimentedPublicIds();
  } catch {
    // already captured by redis helper
  }
}

// ---- Selectors ----------------------------------------------------------

// NEVER select encrypted_api_key here. Plaintext keys are decrypted only by
// the gateway-side cache loader (Phase 3); admin reads must not see them.
const variantVersionPublicColumns = {
  id: model_experiment_variant_version.id,
  variant_id: model_experiment_variant_version.variant_id,
  upstream: model_experiment_variant_version.upstream,
  effective_at: model_experiment_variant_version.effective_at,
  created_by: model_experiment_variant_version.created_by,
  created_at: model_experiment_variant_version.created_at,
} as const;

async function listVariantsWithCurrentVersion(experimentId: string) {
  const variants = await db
    .select()
    .from(model_experiment_variant)
    .where(eq(model_experiment_variant.experiment_id, experimentId))
    .orderBy(asc(model_experiment_variant.id));

  if (variants.length === 0) return [];

  const variantIds = variants.map(v => v.id);
  const versions = await db
    .select(variantVersionPublicColumns)
    .from(model_experiment_variant_version)
    .where(inArray(model_experiment_variant_version.variant_id, variantIds))
    .orderBy(
      asc(model_experiment_variant_version.variant_id),
      desc(model_experiment_variant_version.effective_at),
      desc(model_experiment_variant_version.id)
    );

  const latestByVariant = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    if (!latestByVariant.has(v.variant_id)) {
      latestByVariant.set(v.variant_id, v);
    }
  }

  return variants.map(v => ({
    ...v,
    current_version: latestByVariant.get(v.id) ?? null,
  }));
}

// ---- Validation helpers -------------------------------------------------

function assertDraft(status: Status, op: string) {
  if (status !== 'draft') {
    badRequest(`${op} is only allowed on draft experiments`);
  }
}

function assertNonTerminal(status: Status, op: string) {
  if (status === 'completed') {
    badRequest(`${op} is not allowed on completed experiments`);
  }
}

async function assertActivatable(experimentId: string, publicModelId: string) {
  const variants = await listVariantsWithCurrentVersion(experimentId);
  if (variants.length < 1) {
    badRequest('Active experiments must have at least 1 variant');
  }
  if (variants.some(v => v.weight <= 0)) {
    badRequest('Every variant must have a positive weight');
  }
  const now = new Date();
  if (variants.some(v => !v.current_version || new Date(v.current_version.effective_at) > now)) {
    badRequest('Every variant must have at least one variant_version with effective_at <= now()');
  }
  // Routing-relevant uniqueness per public_model_id (active|paused). The DB
  // partial unique index will also enforce this; we check first to surface a
  // friendlier error.
  const conflict = await db
    .select({ id: model_experiment.id })
    .from(model_experiment)
    .where(
      and(
        eq(model_experiment.public_model_id, publicModelId),
        inArray(model_experiment.status, ROUTING_STATUSES),
        sql`${model_experiment.id} <> ${experimentId}`
      )
    )
    .limit(1);
  if (conflict.length > 0) {
    trpcThrow('CONFLICT', `Another active or paused experiment exists for ${publicModelId}`);
  }
}

// ---- Router -------------------------------------------------------------

const CreateExperimentSchema = z.object({
  public_model_id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const UpdateExperimentSchema = idSchema.extend({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  // public_model_id is editable only on draft.
  public_model_id: z.string().min(1).optional(),
});

const AddVariantSchema = idSchema.extend({
  label: labelSchema,
  weight: weightSchema,
});

const UpdateVariantLabelSchema = z.object({
  variantId: z.string().uuid(),
  label: labelSchema,
});

const SwapVariantVersionSchema = z.object({
  variantId: z.string().uuid(),
  upstream: ExperimentUpstreamSchema,
  // Optional: if omitted, the prior version's encrypted_api_key is reused
  // (so admins can hot-swap the upstream config without retyping the key).
  // Required when the variant has no prior version.
  apiKey: apiKeySchema.optional(),
});

const RotateApiKeySchema = z.object({
  variantId: z.string().uuid(),
  apiKey: apiKeySchema,
});

const SetArchivedSchema = idSchema.extend({
  archived: z.boolean(),
});

export const adminModelExperimentsRouter = createTRPCRouter({
  // ---- Experiment-level ------------------------------------------------

  list: adminProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      const includeArchived = input?.includeArchived ?? false;
      const rows = await db
        .select()
        .from(model_experiment)
        .where(includeArchived ? sql`true` : eq(model_experiment.is_archived, false))
        .orderBy(desc(model_experiment.created_at));
      return { items: rows };
    }),

  listRequests: adminProcedure.query(async () => {
    const rows = await db
      .select({
        usageId: model_experiment_request.usage_id,
        createdAt: model_experiment_request.created_at,
        experimentId: model_experiment.id,
        experimentName: model_experiment.name,
        publicModelId: model_experiment.public_model_id,
        variantId: model_experiment_variant.id,
        variantLabel: model_experiment_variant.label,
        variantVersionId: model_experiment_variant_version.id,
        allocationSubject: model_experiment_request.allocation_subject,
        clientRequestId: model_experiment_request.client_request_id,
        requestKind: model_experiment_request.request_kind,
        requestBodySha256: model_experiment_request.request_body_sha256,
        wasTruncated: model_experiment_request.was_truncated,
        userId: microdollar_usage.kilo_user_id,
        organizationId: microdollar_usage.organization_id,
        requestedModel: microdollar_usage.requested_model,
        upstreamModel: microdollar_usage.model,
        provider: microdollar_usage.provider,
        inferenceProvider: microdollar_usage.inference_provider,
        inputTokens: microdollar_usage.input_tokens,
        outputTokens: microdollar_usage.output_tokens,
        cacheWriteTokens: microdollar_usage.cache_write_tokens,
        cacheHitTokens: microdollar_usage.cache_hit_tokens,
        costMicrodollars: microdollar_usage.cost,
        cacheDiscountMicrodollars: microdollar_usage.cache_discount,
        hasError: microdollar_usage.has_error,
      })
      .from(model_experiment_request)
      .innerJoin(microdollar_usage, eq(model_experiment_request.usage_id, microdollar_usage.id))
      .innerJoin(
        model_experiment_variant_version,
        eq(model_experiment_request.variant_version_id, model_experiment_variant_version.id)
      )
      .innerJoin(
        model_experiment_variant,
        eq(model_experiment_variant_version.variant_id, model_experiment_variant.id)
      )
      .innerJoin(model_experiment, eq(model_experiment_variant.experiment_id, model_experiment.id))
      .orderBy(desc(model_experiment_request.created_at))
      .limit(100);

    return { items: rows };
  }),

  get: adminProcedure.input(idSchema).query(async ({ input }) => {
    const experiment = await loadExperimentOrThrow(input.id);
    const variants = await listVariantsWithCurrentVersion(input.id);
    return { experiment, variants };
  }),

  create: adminProcedure.input(CreateExperimentSchema).mutation(async ({ input, ctx }) => {
    const [row] = await db
      .insert(model_experiment)
      .values({
        public_model_id: input.public_model_id,
        name: input.name,
        description: input.description ?? null,
        status: 'draft',
        created_by_user_id: ctx.user.id,
      })
      .returning();
    return row;
  }),

  update: adminProcedure.input(UpdateExperimentSchema).mutation(async ({ input }) => {
    const existing = await loadExperimentOrThrow(input.id);
    const next: Partial<typeof model_experiment.$inferInsert> = {};
    if (input.name !== undefined) next.name = input.name;
    if (input.description !== undefined) next.description = input.description;
    if (input.public_model_id !== undefined) {
      assertDraft(existing.status as Status, 'Changing public_model_id');
      next.public_model_id = input.public_model_id;
    }
    if (Object.keys(next).length === 0) return existing;
    const [updated] = await db
      .update(model_experiment)
      .set(next)
      .where(eq(model_experiment.id, input.id))
      .returning();
    // Only routing-relevant edits touch the per-public-id cache; cosmetic
    // name/description-only changes don't invalidate.
    if (existing.public_model_id !== updated.public_model_id) {
      await invalidateExperimentCaches(updated.public_model_id);
      await invalidateExperimentCaches(existing.public_model_id);
    }
    return updated;
  }),

  delete: adminProcedure.input(idSchema).mutation(async ({ input }) => {
    const existing = await loadExperimentOrThrow(input.id);
    assertDraft(existing.status as Status, 'Deleting');
    await db.delete(model_experiment).where(eq(model_experiment.id, input.id));
    return { success: true };
  }),

  activate: adminProcedure.input(idSchema).mutation(({ input }) =>
    applyExperimentTransition({
      id: input.id,
      guard: async existing => {
        if (existing.status === 'completed') {
          badRequest('Cannot activate a completed experiment');
        }
        if (existing.status === 'active') return { kind: 'noop', row: existing };
        await assertActivatable(existing.id, existing.public_model_id);
        return {
          kind: 'proceed',
          values: { status: 'active', started_at: existing.started_at ?? sql`now()` },
        };
      },
    })
  ),

  pause: adminProcedure.input(idSchema).mutation(({ input }) =>
    applyExperimentTransition({
      id: input.id,
      guard: async existing => {
        if (existing.status === 'paused') return { kind: 'noop', row: existing };
        if (existing.status !== 'active') badRequest('Only active experiments can be paused');
        return { kind: 'proceed', values: { status: 'paused' } };
      },
    })
  ),

  complete: adminProcedure.input(idSchema).mutation(({ input }) =>
    applyExperimentTransition({
      id: input.id,
      guard: async existing => {
        if (existing.status === 'completed') return { kind: 'noop', row: existing };
        if (existing.status !== 'active' && existing.status !== 'paused') {
          badRequest('Only active or paused experiments can be completed');
        }
        return { kind: 'proceed', values: { status: 'completed', ended_at: sql`now()` } };
      },
    })
  ),

  setArchived: adminProcedure.input(SetArchivedSchema).mutation(async ({ input }) => {
    const existing = await loadExperimentOrThrow(input.id);
    if (input.archived && existing.status === 'active') {
      badRequest('Cannot archive an active experiment');
    }
    const [updated] = await db
      .update(model_experiment)
      .set({ is_archived: input.archived })
      .where(eq(model_experiment.id, input.id))
      .returning();
    return updated;
  }),

  // ---- Variant-level ---------------------------------------------------

  addVariant: adminProcedure.input(AddVariantSchema).mutation(async ({ input }) => {
    const experiment = await loadExperimentOrThrow(input.id);
    assertDraft(experiment.status as Status, 'Adding variants');
    const [row] = await db
      .insert(model_experiment_variant)
      .values({
        experiment_id: experiment.id,
        label: input.label,
        weight: input.weight,
      })
      .returning();
    return row;
  }),

  removeVariant: adminProcedure.input(variantIdSchema).mutation(async ({ input }) => {
    const variant = await loadVariantOrThrow(input.variantId);
    const experiment = await loadExperimentOrThrow(variant.experiment_id);
    assertDraft(experiment.status as Status, 'Removing variants');
    await db.delete(model_experiment_variant).where(eq(model_experiment_variant.id, variant.id));
    return { success: true };
  }),

  updateVariantLabel: adminProcedure.input(UpdateVariantLabelSchema).mutation(async ({ input }) => {
    const variant = await loadVariantOrThrow(input.variantId);
    const experiment = await loadExperimentOrThrow(variant.experiment_id);
    assertNonTerminal(experiment.status as Status, 'Updating variant label');
    const [updated] = await db
      .update(model_experiment_variant)
      .set({ label: input.label })
      .where(eq(model_experiment_variant.id, variant.id))
      .returning();
    // Label is cosmetic only; no cache invalidation needed (cache keys on
    // variant_id, not label).
    return updated;
  }),

  swapVariantVersion: adminProcedure
    .input(SwapVariantVersionSchema)
    .mutation(async ({ input, ctx }) => {
      const variant = await loadVariantOrThrow(input.variantId);
      const experiment = await loadExperimentOrThrow(variant.experiment_id);
      assertNonTerminal(experiment.status as Status, 'Swapping variant version');

      // If the caller supplied a key, encrypt it. Otherwise reuse the
      // existing variant's latest encrypted_api_key blob — admins should
      // be able to hot-swap the upstream config without retyping the key
      // every time. If there is no prior version we have nothing to
      // copy and the key is required.
      let encrypted_api_key;
      if (input.apiKey !== undefined) {
        encrypted_api_key = encryptApiKey(input.apiKey, BYOK_ENCRYPTION_KEY);
      } else {
        const previous = await db
          .select({ encrypted_api_key: model_experiment_variant_version.encrypted_api_key })
          .from(model_experiment_variant_version)
          .where(eq(model_experiment_variant_version.variant_id, variant.id))
          .orderBy(
            desc(model_experiment_variant_version.effective_at),
            desc(model_experiment_variant_version.id)
          )
          .limit(1);
        if (previous.length === 0) {
          badRequest('apiKey is required when the variant has no prior version');
        }
        encrypted_api_key = previous[0].encrypted_api_key;
      }

      const [inserted] = await db
        .insert(model_experiment_variant_version)
        .values({
          variant_id: variant.id,
          upstream: input.upstream,
          encrypted_api_key,
          created_by: ctx.user.id,
        })
        .returning(variantVersionPublicColumns);
      await invalidateExperimentCaches(experiment.public_model_id);
      return inserted;
    }),

  rotateApiKey: adminProcedure.input(RotateApiKeySchema).mutation(async ({ input, ctx }) => {
    const key = BYOK_ENCRYPTION_KEY;
    const variant = await loadVariantOrThrow(input.variantId);
    const experiment = await loadExperimentOrThrow(variant.experiment_id);
    assertNonTerminal(experiment.status as Status, 'Rotating api key');

    const latest = await db
      .select(variantVersionPublicColumns)
      .from(model_experiment_variant_version)
      .where(eq(model_experiment_variant_version.variant_id, variant.id))
      .orderBy(
        desc(model_experiment_variant_version.effective_at),
        desc(model_experiment_variant_version.id)
      )
      .limit(1);
    const previousUpstream = latest[0]?.upstream;
    if (!previousUpstream) {
      badRequest(
        'Cannot rotate api key: variant has no existing version. Use swapVariantVersion to seed.'
      );
    }

    const validated = ExperimentUpstreamSchema.safeParse(previousUpstream);
    if (!validated.success) {
      trpcThrow('INTERNAL_SERVER_ERROR', 'Latest variant version has an invalid upstream blob');
    }

    const encrypted = encryptApiKey(input.apiKey, key);
    const [inserted] = await db
      .insert(model_experiment_variant_version)
      .values({
        variant_id: variant.id,
        upstream: validated.data,
        encrypted_api_key: encrypted,
        created_by: ctx.user.id,
      })
      .returning(variantVersionPublicColumns);
    await invalidateExperimentCaches(experiment.public_model_id);
    return inserted;
  }),
});
