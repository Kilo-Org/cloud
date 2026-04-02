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

export async function POST(): Promise<NextResponse<BackfillBatchResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const processed = await db.transaction(async tran => {
    const rows = await tran
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(missingEither)
      .orderBy(desc(kilocode_users.created_at))
      .limit(1000);

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

  return NextResponse.json({ processed, remaining: processed === 1000 });
}
