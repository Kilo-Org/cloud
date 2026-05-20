import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  model_experiment,
  model_experiment_variant,
  model_experiment_variant_version,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { redisGet, redisSet } from '@/lib/redis';
import { EXPERIMENTED_PUBLIC_IDS_REDIS_KEY, modelExperimentRedisKey } from '@/lib/redis-keys';
import { createCachedFetch } from '@/lib/cached-fetch';
import { decryptApiKey, type EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';
import { ExperimentUpstreamSchema } from '@/lib/ai-gateway/experiments/upstream-schema';
import type {
  AllocationSubject,
  CachedExperiment,
  CachedVariant,
  ExperimentStatus,
  PickVariantInput,
  PickVariantResult,
  ResolveResult,
  SerializedCacheEntry,
  SerializedCachedExperiment,
} from '@/lib/ai-gateway/experiments/pick-variant.types';

/** Shared Redis cache TTL. Cached experiment rows hold ciphertext only;
 *  plaintext keys are decrypted per-pick and never stored in Redis. */
const EXPERIMENT_REDIS_CACHE_TTL_SECONDS = 600;
const EXPERIMENTED_PUBLIC_IDS_LOCAL_CACHE_TTL_MS = 60_000;

const getExperimentedPublicIds = createCachedFetch<string[]>(
  async () => {
    try {
      const cached = await redisGet(EXPERIMENTED_PUBLIC_IDS_REDIS_KEY);
      if (cached === null) return [];
      return parseStringArray(cached) ?? [];
    } catch {
      // captureException already invoked by the redis helper
      return [];
    }
  },
  EXPERIMENTED_PUBLIC_IDS_LOCAL_CACHE_TTL_MS,
  []
);

/**
 * Fast pre-check: does any active|paused experiment target this public id?
 *
 * Reads from a short-lived in-process cache backed by Redis. Admin writes are
 * responsible for maintaining the Redis membership set; if Redis is empty,
 * corrupt, or unavailable, treat it as "no experimented public ids".
 */
export async function isPublicIdExperimented(publicId: string): Promise<boolean> {
  const ids = await getExperimentedPublicIds();
  return ids.includes(publicId);
}

function parseStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (parsed.some(v => typeof v !== 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

/**
 * Returns the routing-relevant experiment for `publicId` (status active or
 * paused) with all variants resolved to their current
 * `model_experiment_variant_version`. The cached payload holds CIPHERTEXT
 * for partner-issued api keys; decryption is deferred to
 * `pickModelExperimentVariant`. Returns `none` only after Postgres has
 * proven there is no routing-relevant experiment for this id.
 *
 * Cached per-publicId for ~10 minutes. The cache is invalidated by every
 * admin mutation that affects routing.
 */
export async function getRoutingExperimentForPublicId(publicId: string): Promise<ResolveResult> {
  const cacheKey = modelExperimentRedisKey(publicId);
  try {
    const cached = await redisGet(cacheKey);
    if (cached !== null) {
      const parsed = tryParseCachedExperiment(cached);
      if (parsed === 'none' || parsed === null) {
        // null = corrupt; fall through to DB rebuild.
        if (parsed === 'none') return { kind: 'none' };
      } else {
        return { kind: 'experiment', experiment: parsed };
      }
    }
  } catch {
    // captured by redis helper; fall through to DB
  }

  let resolved: ResolveResult;
  try {
    resolved = await loadExperimentFromDb(publicId);
  } catch (err) {
    captureException(err, {
      tags: { source: 'model-experiments', operation: 'getRoutingExperimentForPublicId' },
      extra: { publicId },
    });
    return { kind: 'unavailable' };
  }

  // Best-effort cache write. A failure here does not affect routing.
  try {
    if (resolved.kind === 'experiment') {
      await redisSet(
        cacheKey,
        JSON.stringify(serializeCachedExperiment(resolved.experiment)),
        EXPERIMENT_REDIS_CACHE_TTL_SECONDS
      );
    } else if (resolved.kind === 'none') {
      await redisSet(
        cacheKey,
        JSON.stringify({ kind: 'none' }),
        EXPERIMENT_REDIS_CACHE_TTL_SECONDS
      );
    }
  } catch {
    // already captured
  }

  return resolved;
}

function serializeCachedExperiment(exp: CachedExperiment): SerializedCachedExperiment {
  return { kind: 'experiment', ...exp };
}

function tryParseCachedExperiment(raw: string): CachedExperiment | 'none' | null {
  try {
    const parsed = JSON.parse(raw) as SerializedCacheEntry;
    if (parsed.kind === 'none') return 'none';
    if (parsed.kind === 'experiment') {
      return {
        experimentId: parsed.experimentId,
        publicModelId: parsed.publicModelId,
        status: parsed.status,
        variants: parsed.variants,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function loadExperimentFromDb(publicId: string): Promise<ResolveResult> {
  const [experiment] = await db
    .select({
      id: model_experiment.id,
      public_model_id: model_experiment.public_model_id,
      status: model_experiment.status,
    })
    .from(model_experiment)
    .where(
      and(
        eq(model_experiment.public_model_id, publicId),
        inArray(model_experiment.status, ['active', 'paused'])
      )
    )
    .limit(1);

  if (!experiment) {
    return { kind: 'none' };
  }

  const status = experiment.status as ExperimentStatus;

  // Variants for this experiment.
  const variantRows = await db
    .select({
      id: model_experiment_variant.id,
      weight: model_experiment_variant.weight,
    })
    .from(model_experiment_variant)
    .where(eq(model_experiment_variant.experiment_id, experiment.id))
    .orderBy(model_experiment_variant.id);

  if (variantRows.length === 0) {
    // Active/paused with no variants is an invariant violation; admin
    // activation should never permit this. Fail closed.
    captureMessage('Routing-relevant experiment has no variants', {
      level: 'error',
      tags: { source: 'model-experiments' },
      extra: { experimentId: experiment.id, publicId },
    });
    return { kind: 'unavailable' };
  }

  const variantIds = variantRows.map(v => v.id);

  // Resolve "current version" per variant: the latest version row whose
  // effective_at <= now() per (variant_id, effective_at desc, id desc).
  // Postgres SELECT DISTINCT ON for one query, no per-variant round trips.
  const { rows: versionRows } = await db.execute<{
    id: string;
    variant_id: string;
    upstream: unknown;
    encrypted_api_key: EncryptedData;
  }>(sql`
    SELECT DISTINCT ON (${model_experiment_variant_version.variant_id})
      ${model_experiment_variant_version.id} AS id,
      ${model_experiment_variant_version.variant_id} AS variant_id,
      ${model_experiment_variant_version.upstream} AS upstream,
      ${model_experiment_variant_version.encrypted_api_key} AS encrypted_api_key
    FROM ${model_experiment_variant_version}
    WHERE ${inArray(model_experiment_variant_version.variant_id, variantIds)}
      AND ${lte(model_experiment_variant_version.effective_at, sql`now()`)}
    ORDER BY ${model_experiment_variant_version.variant_id},
             ${desc(model_experiment_variant_version.effective_at)},
             ${desc(model_experiment_variant_version.id)}
  `);

  const versionByVariantId = new Map<
    string,
    { id: string; upstream: unknown; encryptedApiKey: EncryptedData }
  >();
  for (const r of versionRows) {
    versionByVariantId.set(r.variant_id, {
      id: r.id,
      upstream: r.upstream,
      encryptedApiKey: r.encrypted_api_key,
    });
  }

  // Every variant must have a current version.
  for (const v of variantRows) {
    if (!versionByVariantId.has(v.id)) {
      captureMessage('Routing-relevant experiment variant missing current version', {
        level: 'error',
        tags: { source: 'model-experiments' },
        extra: { experimentId: experiment.id, variantId: v.id, publicId },
      });
      return { kind: 'unavailable' };
    }
  }

  // We deliberately DO NOT call decryptApiKey here. The cache should only
  // hold encrypted blobs; decryption happens per-pick so key rotation takes
  // effect on the next request.
  const variants: CachedVariant[] = [];
  for (const v of variantRows) {
    const ver = versionByVariantId.get(v.id);
    if (!ver) {
      // Already verified above; this is a defensive belt-and-suspenders.
      return { kind: 'unavailable' };
    }
    const parsedUpstream = ExperimentUpstreamSchema.safeParse(ver.upstream);
    if (!parsedUpstream.success) {
      captureMessage('Failed to parse experiment variant upstream blob', {
        level: 'error',
        tags: { source: 'model-experiments' },
        extra: {
          experimentId: experiment.id,
          variantId: v.id,
          variantVersionId: ver.id,
          issues: parsedUpstream.error.issues,
        },
      });
      return { kind: 'unavailable' };
    }
    variants.push({
      variantId: v.id,
      weight: v.weight,
      variantVersionId: ver.id,
      upstream: parsedUpstream.data,
      encryptedApiKey: ver.encryptedApiKey,
    });
  }

  return {
    kind: 'experiment',
    experiment: {
      experimentId: experiment.id,
      publicModelId: experiment.public_model_id,
      status,
      variants,
    },
  };
}

/**
 * Picks a variant for the request, or returns a status that the caller can
 * map to a local error response.
 *
 * - `active`: variant chosen, return the upstream blob and metadata.
 * - `not-found`: experiment exists but is paused; route as 404 instead of
 *   silently falling through to default routing.
 * - `unavailable`: cache/DB/config failure or no allocation subject. Map to
 *   503 temporarily-unavailable.
 *
 * Returns `null` only when Postgres/cache state proves the public id is not
 * currently routed by an experiment (caller should continue with non-
 * experiment routing).
 */
export async function pickModelExperimentVariant(
  input: PickVariantInput
): Promise<PickVariantResult | null> {
  const resolved = await getRoutingExperimentForPublicId(input.publicModelId);
  if (resolved.kind === 'none') return null;
  if (resolved.kind === 'unavailable') return { status: 'unavailable' };

  const exp = resolved.experiment;
  if (exp.status === 'paused') {
    return { status: 'not-found' };
  }

  const allocationSubject = pickAllocationSubject(input);
  if (!allocationSubject) {
    captureMessage('Experiment request missing all allocation subjects', {
      level: 'error',
      tags: { source: 'model-experiments' },
      extra: { experimentId: exp.experimentId, publicModelId: exp.publicModelId },
    });
    return { status: 'unavailable' };
  }

  const totalWeight = exp.variants.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight <= 0) {
    captureMessage('Experiment total weight is non-positive', {
      level: 'error',
      tags: { source: 'model-experiments' },
      extra: { experimentId: exp.experimentId },
    });
    return { status: 'unavailable' };
  }

  const seed = `model_exp_${exp.experimentId}_${allocationSubject.subject}_${allocationSubject.value}`;
  const bucket = getRandomNumber(seed, totalWeight);

  // Walk variants in id-asc order (cache layer already sorted them) and
  // pick the variant whose cumulative weight first exceeds the bucket.
  let cumulative = 0;
  for (const v of exp.variants) {
    cumulative += v.weight;
    if (bucket < cumulative) {
      // Decrypt only the chosen variant's key, here and now. This is the
      // ONLY decryption point for experiment routing — the cache holds
      // ciphertext exclusively. Doing it per-pick (a) keeps the
      // key rotation effective immediately (next request after the key
      // flips fails closed), and (b) means we never decrypt N-1 keys we
      // won't use.
      let apiKey: string;
      try {
        apiKey = decryptApiKey(v.encryptedApiKey, BYOK_ENCRYPTION_KEY);
      } catch (err) {
        captureException(err, {
          tags: { source: 'model-experiments', operation: 'decryptApiKey' },
          extra: {
            experimentId: exp.experimentId,
            variantId: v.variantId,
            variantVersionId: v.variantVersionId,
          },
        });
        return { status: 'unavailable' };
      }
      return {
        status: 'active',
        experimentId: exp.experimentId,
        variantId: v.variantId,
        variantVersionId: v.variantVersionId,
        upstream: { ...v.upstream, api_key: apiKey },
        allocationSubject: allocationSubject.subject,
      };
    }
  }

  // Defensive fail-closed: `getRandomNumber` is contractually expected to
  // return a finite value in `[0, totalWeight)`, so the loop above should
  // always select a variant. We still handle the no-selection case rather
  // than silently routing as unexperimented if that contract ever breaks
  // (NaN, negative, weight rounding) — billing-touching code shouldn't
  // depend on a math invariant we can't statically prove.
  captureMessage('Experiment bucket walk did not select a variant', {
    level: 'error',
    tags: { source: 'model-experiments' },
    extra: { experimentId: exp.experimentId, bucket, totalWeight },
  });
  return { status: 'unavailable' };
}

function pickAllocationSubject(
  input: PickVariantInput
): { subject: AllocationSubject; value: string } | null {
  if (input.userId) return { subject: 'user', value: input.userId };
  if (input.machineId) return { subject: 'machine', value: input.machineId };
  if (input.clientIp) return { subject: 'ip', value: input.clientIp };
  return null;
}

export type {
  AllocationSubject,
  ModelExperiment,
  PickVariantInput,
  PickVariantResult,
} from '@/lib/ai-gateway/experiments/pick-variant.types';
