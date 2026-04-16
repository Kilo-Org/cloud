import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import {
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@/lib/ai-gateway/providerHash';
import { isNull, count, or, desc, sql } from 'drizzle-orm';

const missingEither = or(
  isNull(kilocode_users.openrouter_upstream_safety_identifier),
  isNull(kilocode_users.vercel_downstream_safety_identifier)
);

export type SafetyIdentifierCountsResponse = {
  missing: number;
};

export type BackfillBatchResponse = {
  processed: number;
  remaining: boolean;
};

type SafetyIdentifierUpdate = {
  id: string;
  openrouter_upstream_safety_identifier: string;
  vercel_downstream_safety_identifier: string;
};

export async function GET(): Promise<
  NextResponse<SafetyIdentifierCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const [result] = await db.select({ count: count() }).from(kilocode_users).where(missingEither);

  return NextResponse.json({ missing: result?.count ?? 0 });
}

const BATCH_SIZE = 1000;
const BATCHES_PER_REQUEST = 50;

export async function POST(): Promise<NextResponse<BackfillBatchResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let totalProcessed = 0;

  for (let i = 0; i < BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(missingEither)
      .orderBy(desc(kilocode_users.created_at))
      .limit(BATCH_SIZE);

    const updates: SafetyIdentifierUpdate[] = [];
    for (const user of rows) {
      const openrouter_upstream_safety_identifier = generateOpenRouterUpstreamSafetyIdentifier(
        user.id
      );
      if (openrouter_upstream_safety_identifier === null) {
        return NextResponse.json(
          { error: 'OPENROUTER_ORG_ID is not configured on this server' },
          { status: 500 }
        );
      }
      updates.push({
        id: user.id,
        openrouter_upstream_safety_identifier,
        vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(user.id),
      });
    }

    if (updates.length > 0) {
      await db.execute(sql`
        UPDATE ${kilocode_users}
        SET
          openrouter_upstream_safety_identifier = safety_identifier_updates.openrouter_upstream_safety_identifier,
          vercel_downstream_safety_identifier = safety_identifier_updates.vercel_downstream_safety_identifier
        FROM (VALUES ${sql.join(
          updates.map(
            update =>
              sql`(${update.id}, ${update.openrouter_upstream_safety_identifier}, ${update.vercel_downstream_safety_identifier})`
          ),
          sql`, `
        )}) AS safety_identifier_updates(id, openrouter_upstream_safety_identifier, vercel_downstream_safety_identifier)
        WHERE ${kilocode_users.id} = safety_identifier_updates.id
      `);
    }

    const processed = rows.length;

    totalProcessed += processed;

    if (processed < BATCH_SIZE) {
      break;
    }
  }

  return NextResponse.json({
    processed: totalProcessed,
    remaining: totalProcessed === BATCH_SIZE * BATCHES_PER_REQUEST,
  });
}
