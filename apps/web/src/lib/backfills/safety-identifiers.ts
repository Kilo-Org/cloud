import { count, isNull, or, sql } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  generateOpenRouterDownstreamSafetyIdentifier,
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import {
  BACKFILL_BATCH_SIZE,
  BACKFILL_BATCHES_PER_REQUEST,
  type BackfillBatchResult,
} from '@/lib/backfills/batch';

export const safetyIdentifierBackfillCandidates = or(
  isNull(kilocode_users.openrouter_upstream_safety_identifier),
  isNull(kilocode_users.openrouter_downstream_safety_identifier),
  isNull(kilocode_users.vercel_downstream_safety_identifier)
);

export async function countMissingSafetyIdentifiers(): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(safetyIdentifierBackfillCandidates);
  return result?.count ?? 0;
}

export async function backfillSafetyIdentifiersBatch(): Promise<BackfillBatchResult> {
  let totalProcessed = 0;

  for (let i = 0; i < BACKFILL_BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(safetyIdentifierBackfillCandidates)
      .limit(BACKFILL_BATCH_SIZE);

    if (rows.length === 0) return { processed: totalProcessed, remaining: false };

    const updates = rows.map(({ id }) => {
      const upstream = generateOpenRouterUpstreamSafetyIdentifier(id);
      if (upstream === null) {
        throw new Error('OPENROUTER_ORG_ID is not configured on this server');
      }
      return sql`(${id}, ${upstream}, ${generateOpenRouterDownstreamSafetyIdentifier(id)}, ${generateVercelDownstreamSafetyIdentifier(id)})`;
    });

    // Raw SQL intentionally preserves updated_at and never overwrites an existing identifier.
    await db.execute(sql`
      UPDATE ${kilocode_users}
      SET openrouter_upstream_safety_identifier = COALESCE(${kilocode_users.openrouter_upstream_safety_identifier}, updates.upstream),
          openrouter_downstream_safety_identifier = COALESCE(${kilocode_users.openrouter_downstream_safety_identifier}, updates.downstream),
          vercel_downstream_safety_identifier = COALESCE(${kilocode_users.vercel_downstream_safety_identifier}, updates.vercel)
      FROM (VALUES ${sql.join(updates, sql`, `)}) AS updates(id, upstream, downstream, vercel)
      WHERE ${kilocode_users.id} = updates.id
    `);

    totalProcessed += rows.length;

    if (rows.length < BACKFILL_BATCH_SIZE) return { processed: totalProcessed, remaining: false };
  }

  return { processed: totalProcessed, remaining: true };
}
