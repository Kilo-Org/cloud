import { captureException } from '@sentry/nextjs';
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { byok_api_keys } from '@kilocode/db/schema';
import { getByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  createByokDataKey,
  encryptByokWithDataKey,
  getByokKmsClientConfig,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';

/** Recorded by the KMS service as the actor of every data key this job creates. */
export const BYOK_ENVELOPE_BACKFILL_ACTOR = 'system:byok-envelope-backfill';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 10;
/** Failures sent to Sentry per run; the rest are only counted, so a systemic fault is one alert. */
const MAX_REPORTED_FAILURES = 5;

export type ByokEnvelopeBackfillSummary = {
  /** False when the KMS service is not configured, so nothing was attempted. */
  enabled: boolean;
  scanned: number;
  migrated: number;
  /** Rows a user or another writer changed between our read and write; left for the next run. */
  skippedConcurrentWrite: number;
  failed: number;
  /**
   * Rows that still have no envelope, counted at the end of the run. This is the figure to
   * watch: skipped, failed and not-yet-reached rows all show up in it.
   */
  remaining: number;
  /** True only when `remaining` is zero: every row has an envelope. */
  drained: boolean;
};

type ByokRowToMigrate = {
  id: string;
  encrypted_api_key: typeof byok_api_keys.$inferSelect.encrypted_api_key;
  organization_id: string | null;
  kilo_user_id: string | null;
  provider_id: string;
};

async function countRowsWithoutEnvelope(): Promise<number> {
  const [row] = await db
    .select({ remaining: count() })
    .from(byok_api_keys)
    .where(isNull(byok_api_keys.encrypted_api_key_envelope));
  return row.remaining;
}

async function selectBatch(afterId: string | null, limit: number): Promise<ByokRowToMigrate[]> {
  return db
    .select({
      id: byok_api_keys.id,
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      organization_id: byok_api_keys.organization_id,
      kilo_user_id: byok_api_keys.kilo_user_id,
      provider_id: byok_api_keys.provider_id,
    })
    .from(byok_api_keys)
    .where(
      and(
        isNull(byok_api_keys.encrypted_api_key_envelope),
        afterId === null ? undefined : gt(byok_api_keys.id, afterId)
      )
    )
    .orderBy(asc(byok_api_keys.id))
    .limit(limit);
}

/**
 * Gives one row its envelope. The legacy column is left as it is: it stays valid for rollback,
 * exactly as for rows written through the router.
 */
async function migrateRow(row: ByokRowToMigrate): Promise<'migrated' | 'skipped'> {
  const apiKey = decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY);
  const dataKey = await createByokDataKey({
    context: getByokKmsContext(row),
    actorUserId: BYOK_ENVELOPE_BACKFILL_ACTOR,
  });
  if (!dataKey) throw new Error('BYOK KMS service is not configured');

  const updated = await db
    .update(byok_api_keys)
    .set({
      encrypted_api_key_envelope: encryptByokWithDataKey(apiKey, dataKey),
      // The key itself did not change, so keep its last-modified time.
      updated_at: sql`${byok_api_keys.updated_at}`,
    })
    .where(
      and(
        eq(byok_api_keys.id, row.id),
        isNull(byok_api_keys.encrypted_api_key_envelope),
        // The envelope was built from the value read above. If the key was replaced since,
        // writing it would resurrect the old secret.
        sql`${byok_api_keys.encrypted_api_key} = ${JSON.stringify(row.encrypted_api_key)}::jsonb`
      )
    )
    .returning({ id: byok_api_keys.id });
  return updated.length > 0 ? 'migrated' : 'skipped';
}

/**
 * Creates the KMS envelope of every BYOK row that has none. Safe to run repeatedly and from
 * overlapping invocations: a row is only written while it still has no envelope and the legacy
 * ciphertext is the one the envelope was built from, and the pass is a cheap indexed no-op once
 * every row is migrated.
 *
 * Work stops at `deadlineAt` (epoch ms) so the caller can finish inside its function duration.
 */
export async function backfillByokEnvelopes({
  deadlineAt,
  batchSize = DEFAULT_BATCH_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
}: {
  deadlineAt: number;
  batchSize?: number;
  concurrency?: number;
}): Promise<ByokEnvelopeBackfillSummary> {
  const summary: ByokEnvelopeBackfillSummary = {
    enabled: getByokKmsClientConfig() !== null,
    scanned: 0,
    migrated: 0,
    skippedConcurrentWrite: 0,
    failed: 0,
    remaining: 0,
    drained: false,
  };
  if (!summary.enabled) return finish(summary);

  let afterId: string | null = null;
  let reported = 0;
  while (Date.now() < deadlineAt) {
    const rows = await selectBatch(afterId, batchSize);
    if (rows.length === 0) break;
    // Keyset paging past this batch: a row that keeps failing cannot starve the rows after it.
    afterId = rows[rows.length - 1].id;

    let next = 0;
    const worker = async () => {
      while (next < rows.length && Date.now() < deadlineAt) {
        const row = rows[next++];
        summary.scanned += 1;
        try {
          if ((await migrateRow(row)) === 'migrated') summary.migrated += 1;
          else summary.skippedConcurrentWrite += 1;
        } catch (error) {
          summary.failed += 1;
          if (reported < MAX_REPORTED_FAILURES) {
            reported += 1;
            captureException(error, {
              tags: { source: 'byok_envelope_backfill' },
              extra: { keyId: row.id },
            });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  }
  return finish(summary);
}

/** Counts after the work, so rows this run migrated are not in the figure. */
async function finish(summary: ByokEnvelopeBackfillSummary): Promise<ByokEnvelopeBackfillSummary> {
  const remaining = await countRowsWithoutEnvelope();
  return { ...summary, remaining, drained: remaining === 0 };
}
