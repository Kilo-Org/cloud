import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  model_experiment,
  model_experiment_variant,
  model_experiment_variant_version,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { decryptApiKey, type EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';
import { ExperimentUpstreamSchema } from '@/lib/ai-gateway/experiments/upstream-schema';
import type {
  AllocationSubject,
  ExperimentStatus,
  PickVariantInput,
  PickVariantResult,
  ResolveResult,
  RoutingVariant,
} from '@/lib/ai-gateway/experiments/pick-variant.types';

/**
 * Returns the routing-relevant experiment for `publicId` (status active or
 * paused) with all variants resolved to their current
 * `model_experiment_variant_version`. This only runs after the Redis-backed
 * membership pre-check (`isPublicIdExperimented` in `./membership.ts`) says
 * the public id is experiment-routed, so preview traffic pays the Postgres
 * lookup while normal models avoid it.
 */
export async function getRoutingExperimentForPublicId(publicId: string): Promise<ResolveResult> {
  try {
    return await loadExperimentFromDb(publicId);
  } catch (err) {
    captureException(err, {
      tags: { source: 'model-experiments', operation: 'getRoutingExperimentForPublicId' },
      extra: { publicId },
    });
    return { kind: 'unavailable' };
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

  // We deliberately DO NOT call decryptApiKey here. Decryption happens
  // per-pick so key rotation takes effect on the next request.
  const variants: RoutingVariant[] = [];
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
