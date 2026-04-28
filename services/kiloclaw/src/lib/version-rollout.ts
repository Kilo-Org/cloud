/**
 * Image-version rollout: per-image `is_latest` marker + per-image
 * `rollout_percent` slider.
 *
 * Catalog (`kiloclaw_image_catalog`) is the source of truth. KV mirrors the
 * data needed at the resolution hot path:
 *
 *   image-version:latest:<variant>     — the row marked is_latest=true
 *   image-version:candidate:<variant>  — the newest available row that has
 *                                        rollout_percent > 0 AND is_latest=false
 *   image-version-tag:<imageTag>       — full ImageVersionEntry per tag (existing)
 *
 * Selection: read both pointers, try candidate first (bucket-gated), fall back
 * to :latest. Two KV reads + one hash. No Postgres on the hot path.
 *
 * Pins (kiloclaw_version_pins) bypass this entire flow — pinned instances
 * always resolve via resolveVersionByTag and ignore both pointers.
 */
import { getWorkerDb } from '@kilocode/db/client';
import { kiloclaw_image_catalog } from '@kilocode/db';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import {
  ImageVersionEntrySchema,
  imageVersionLatestKey,
  imageVersionTagKey,
  type ImageVariant,
  type ImageVersionEntry,
} from '../schemas/image-version';
import { rolloutBucket } from './rollout-bucket';

export function imageVersionCandidateKey(variant: string): string {
  return `image-version:candidate:${variant}`;
}

async function readPointer(kv: KVNamespace, key: string): Promise<ImageVersionEntry | null> {
  const raw = await kv.get(key, 'json');
  if (!raw) return null;
  const parsed = ImageVersionEntrySchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[version-rollout] Invalid KV entry at', key, parsed.error.flatten());
    return null;
  }
  return parsed.data;
}

export interface SelectImageVersionOptions {
  kv: KVNamespace;
  variant: ImageVariant;
  /** Instance whose bucket determines candidate eligibility. */
  instanceId: string;
  /** Tag the instance is currently running, if any. Used to skip self-upgrades. */
  currentImageTag?: string | null;
  /** When true, the candidate (if any) is always offered regardless of bucket. */
  autoEnroll?: boolean;
}

/**
 * Resolve which image version this instance should run next.
 *
 * Order:
 *   1. Candidate (if present, instance is in cohort or autoEnrolled, and not
 *      already running it).
 *   2. :latest (if present and not already running it).
 *   3. null — already on the right image, no upgrade.
 */
export async function selectImageVersionForInstance(
  opts: SelectImageVersionOptions
): Promise<ImageVersionEntry | null> {
  const [candidate, latest] = await Promise.all([
    readPointer(opts.kv, imageVersionCandidateKey(opts.variant)),
    readPointer(opts.kv, imageVersionLatestKey(opts.variant)),
  ]);

  // Track whether the candidate path was skipped because the instance is
  // already on the candidate. If so, we must NOT fall through to :latest —
  // that would silently downgrade an instance whose admin slid the rollout
  // back below its bucket. Sticky-on-candidate is the documented behavior;
  // moving an instance off the candidate requires an explicit admin action
  // (disable the candidate's tag), which clears the KV pointer.
  const alreadyOnCandidate = candidate !== null && candidate.imageTag === opts.currentImageTag;

  if (candidate && !alreadyOnCandidate) {
    if (opts.autoEnroll) {
      return candidate;
    }
    if (candidate.rolloutPercent > 0) {
      const bucket = await rolloutBucket(`${candidate.imageTag}:instance:${opts.instanceId}`);
      if (bucket < candidate.rolloutPercent) {
        return candidate;
      }
    }
  }

  if (alreadyOnCandidate) {
    return null;
  }

  if (latest && latest.imageTag !== opts.currentImageTag) {
    return latest;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface SetRolloutPercentResult {
  imageTag: string;
  variant: string;
  rolloutPercent: number;
  isLatest: boolean;
}

/**
 * Set an image's rollout_percent. Refuses to operate on a row marked is_latest
 * (the slider doesn't apply to :latest — it's served unconditionally).
 *
 * Enforces the "at most one candidate per variant" invariant: when setting a
 * non-zero percent on a row, any OTHER non-:latest available row in the same
 * variant with a non-zero percent is reset to 0. The admin UI confirms this
 * replacement with a dialog before calling, but the enforcement also lives
 * here so direct API calls or future callers can't end up with two
 * candidates simultaneously (which would make refreshPointersForVariant pick
 * one by published_at and silently hide the other from instances).
 */
export async function setRolloutPercent(opts: {
  kv: KVNamespace;
  hyperdriveConnectionString: string;
  imageTag: string;
  percent: number;
}): Promise<SetRolloutPercentResult> {
  if (!Number.isInteger(opts.percent) || opts.percent < 0 || opts.percent > 100) {
    throw new Error(`Invalid rollout percent: ${opts.percent}`);
  }

  const db = getWorkerDb(opts.hyperdriveConnectionString);

  const [target] = await db
    .select()
    .from(kiloclaw_image_catalog)
    .where(eq(kiloclaw_image_catalog.image_tag, opts.imageTag))
    .limit(1);
  if (!target) throw new Error(`Image not found: ${opts.imageTag}`);
  if (target.status !== 'available')
    throw new Error(`Image not available: ${opts.imageTag} (status=${target.status})`);
  if (target.is_latest) throw new Error('Cannot set rollout percent on the :latest image');

  // Atomically: clear any OTHER in-flight candidate for this variant, then
  // set the new percent on the target. Both operations in a single TX so we
  // never observe two candidates at once.
  const row = await db.transaction(async tx => {
    if (opts.percent > 0) {
      await tx
        .update(kiloclaw_image_catalog)
        .set({ rollout_percent: 0, updated_at: sql`NOW()` })
        .where(
          and(
            eq(kiloclaw_image_catalog.variant, target.variant),
            ne(kiloclaw_image_catalog.image_tag, opts.imageTag),
            eq(kiloclaw_image_catalog.status, 'available'),
            eq(kiloclaw_image_catalog.is_latest, false),
            sql`${kiloclaw_image_catalog.rollout_percent} > 0`
          )
        );
    }

    const [updated] = await tx
      .update(kiloclaw_image_catalog)
      .set({ rollout_percent: opts.percent, updated_at: sql`NOW()` })
      .where(eq(kiloclaw_image_catalog.image_tag, opts.imageTag))
      .returning();
    if (!updated) throw new Error(`Image not found: ${opts.imageTag}`);
    return updated;
  });

  await mirrorTagEntryToKv(opts.kv, row);
  await refreshPointersForVariant(opts.kv, opts.hyperdriveConnectionString, row.variant);

  return {
    imageTag: row.image_tag,
    variant: row.variant,
    rolloutPercent: row.rollout_percent,
    isLatest: row.is_latest,
  };
}

/**
 * Mark an image as the production :latest for its variant.
 *
 * Atomically: clears is_latest from any other row in the same variant, sets
 * is_latest=true and rollout_percent=0 on this row (a :latest image's slider
 * is meaningless — it's served unconditionally, so we reset it to keep state
 * tidy), and refreshes both KV pointers.
 *
 * Independent of rollout_percent: the marker can be applied at any time
 * regardless of the image's current percent.
 */
export async function markImageAsLatest(opts: {
  kv: KVNamespace;
  hyperdriveConnectionString: string;
  imageTag: string;
}): Promise<{ imageTag: string; variant: string }> {
  const db = getWorkerDb(opts.hyperdriveConnectionString);

  const [target] = await db
    .select({
      variant: kiloclaw_image_catalog.variant,
      status: kiloclaw_image_catalog.status,
    })
    .from(kiloclaw_image_catalog)
    .where(eq(kiloclaw_image_catalog.image_tag, opts.imageTag))
    .limit(1);
  if (!target) throw new Error(`Image not found: ${opts.imageTag}`);
  if (target.status !== 'available')
    throw new Error(`Image is disabled and cannot be marked :latest: ${opts.imageTag}`);

  // Clear-then-set inside a transaction so there's never a window where no
  // row has is_latest=true for the variant. Without the TX, a concurrent
  // refreshPointersForVariant (e.g. another admin's setRolloutPercent) could
  // see "no :latest" and clear the KV pointer.
  const row = await db.transaction(async tx => {
    await tx
      .update(kiloclaw_image_catalog)
      .set({ is_latest: false, updated_at: sql`NOW()` })
      .where(
        and(
          eq(kiloclaw_image_catalog.variant, target.variant),
          ne(kiloclaw_image_catalog.image_tag, opts.imageTag),
          eq(kiloclaw_image_catalog.is_latest, true)
        )
      );

    const [updated] = await tx
      .update(kiloclaw_image_catalog)
      .set({ is_latest: true, rollout_percent: 0, updated_at: sql`NOW()` })
      .where(eq(kiloclaw_image_catalog.image_tag, opts.imageTag))
      .returning();
    if (!updated) throw new Error(`Image not found: ${opts.imageTag}`);
    return updated;
  });

  await mirrorTagEntryToKv(opts.kv, row);
  await refreshPointersForVariant(opts.kv, opts.hyperdriveConnectionString, row.variant);

  return { imageTag: row.image_tag, variant: row.variant };
}

/**
 * Mark an image as disabled and clear any in-flight rollout on it. Refuses to
 * disable the row currently marked :latest — admin must promote a replacement
 * first (otherwise no image would be served as :latest).
 */
export async function disableImageAndClearRollout(opts: {
  kv: KVNamespace;
  hyperdriveConnectionString: string;
  imageTag: string;
  updatedBy: string;
}): Promise<void> {
  const db = getWorkerDb(opts.hyperdriveConnectionString);

  const [target] = await db
    .select({ is_latest: kiloclaw_image_catalog.is_latest })
    .from(kiloclaw_image_catalog)
    .where(eq(kiloclaw_image_catalog.image_tag, opts.imageTag))
    .limit(1);
  if (!target) return;
  if (target.is_latest) {
    throw new Error('Cannot disable the current :latest image. Promote a replacement first.');
  }

  const [row] = await db
    .update(kiloclaw_image_catalog)
    .set({
      status: 'disabled',
      rollout_percent: 0,
      updated_by: opts.updatedBy,
      updated_at: sql`NOW()`,
    })
    .where(eq(kiloclaw_image_catalog.image_tag, opts.imageTag))
    .returning();
  if (!row) return;

  await mirrorTagEntryToKv(opts.kv, row);
  await refreshPointersForVariant(opts.kv, opts.hyperdriveConnectionString, row.variant);
}

// ---------------------------------------------------------------------------
// Internal: KV mirroring
// ---------------------------------------------------------------------------

type CatalogRow = typeof kiloclaw_image_catalog.$inferSelect;

function rowToEntry(row: CatalogRow): ImageVersionEntry {
  return {
    openclawVersion: row.openclaw_version,
    variant: row.variant as ImageVariant,
    imageTag: row.image_tag,
    imageDigest: row.image_digest,
    publishedAt: row.published_at,
    rolloutPercent: row.rollout_percent,
    isLatest: row.is_latest,
  };
}

async function mirrorTagEntryToKv(kv: KVNamespace, row: CatalogRow): Promise<void> {
  const entry = rowToEntry(row);
  const parsed = ImageVersionEntrySchema.safeParse(entry);
  if (!parsed.success) {
    console.warn(
      '[version-rollout] Refusing to mirror invalid entry to KV:',
      parsed.error.flatten()
    );
    return;
  }
  await kv.put(imageVersionTagKey(row.image_tag), JSON.stringify(parsed.data));
}

/**
 * Recompute the per-variant :latest and :candidate KV pointers from Postgres.
 * - :latest = row with is_latest=true (at most one).
 * - :candidate = newest available non-:latest row with rollout_percent > 0.
 */
async function refreshPointersForVariant(
  kv: KVNamespace,
  hyperdriveConnectionString: string,
  variant: string
): Promise<void> {
  const db = getWorkerDb(hyperdriveConnectionString);

  const rows = await db
    .select()
    .from(kiloclaw_image_catalog)
    .where(
      and(
        eq(kiloclaw_image_catalog.variant, variant),
        eq(kiloclaw_image_catalog.status, 'available')
      )
    )
    .orderBy(desc(kiloclaw_image_catalog.published_at));

  const latest = rows.find(r => r.is_latest) ?? null;
  const candidate = rows.find(r => !r.is_latest && r.rollout_percent > 0) ?? null;

  const latestKey = imageVersionLatestKey(variant);
  const candidateKey = imageVersionCandidateKey(variant);

  await Promise.all([
    latest ? kv.put(latestKey, JSON.stringify(rowToEntry(latest))) : kv.delete(latestKey),
    candidate
      ? kv.put(candidateKey, JSON.stringify(rowToEntry(candidate)))
      : kv.delete(candidateKey),
  ]);
}
