import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import {
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@/lib/providerHash';
import { isNull, count, or, desc, eq, and } from 'drizzle-orm';

const missingEither = and(
  isNull(kilocode_users.blocked_reason),
  or(
    isNull(kilocode_users.openrouter_upstream_safety_identifier),
    isNull(kilocode_users.vercel_downstream_safety_identifier)
  )
);

export type SafetyIdentifierCountsResponse = {
  missing: number;
};

export type BackfillBatchResponse = {
  processed: number;
  remaining: boolean;
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
const BATCHES_PER_REQUEST = 10;

export async function POST(): Promise<NextResponse<BackfillBatchResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let totalProcessed = 0;

  for (let i = 0; i < BATCHES_PER_REQUEST; i++) {
    const processed = await db.transaction(async tran => {
      const rows = await tran
        .select({ id: kilocode_users.id })
        .from(kilocode_users)
        .where(missingEither)
        .orderBy(desc(kilocode_users.created_at))
        .limit(BATCH_SIZE);

      for (const user of rows) {
        const openrouter_upstream_safety_identifier = generateOpenRouterUpstreamSafetyIdentifier(
          user.id
        );
        if (openrouter_upstream_safety_identifier === null) {
          return null;
        }
        await tran
          .update(kilocode_users)
          .set({
            openrouter_upstream_safety_identifier,
            vercel_downstream_safety_identifier: generateVercelDownstreamSafetyIdentifier(user.id),
          })
          .where(eq(kilocode_users.id, user.id))
          .execute();
      }

      return rows.length;
    });

    if (processed === null) {
      return NextResponse.json(
        { error: 'OPENROUTER_ORG_ID is not configured on this server' },
        { status: 500 }
      );
    }

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
