import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import {
  generateOpenRouterUpstreamSafetyIdentifier,
  generateVercelDownstreamSafetyIdentifier,
} from '@/lib/providerHash';
import { isNull, count, desc, eq } from 'drizzle-orm';

export type SafetyIdentifierCountsResponse = {
  openrouterMissing: number;
  vercelMissing: number;
};

export type BackfillBatchResponse = {
  openrouterProcessed: number;
  vercelProcessed: number;
  remaining: boolean;
};

export async function GET(): Promise<
  NextResponse<SafetyIdentifierCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const [openrouterResult, vercelResult] = await Promise.all([
    db
      .select({ count: count() })
      .from(kilocode_users)
      .where(isNull(kilocode_users.openrouter_upstream_safety_identifier)),
    db
      .select({ count: count() })
      .from(kilocode_users)
      .where(isNull(kilocode_users.vercel_downstream_safety_identifier)),
  ]);

  return NextResponse.json({
    openrouterMissing: openrouterResult[0]?.count ?? 0,
    vercelMissing: vercelResult[0]?.count ?? 0,
  });
}

async function backfillOpenRouter(): Promise<number | null> {
  return db.transaction(async tran => {
    const rows = await tran
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(isNull(kilocode_users.openrouter_upstream_safety_identifier))
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
        .set({ openrouter_upstream_safety_identifier })
        .where(eq(kilocode_users.id, user.id))
        .execute();
    }

    return rows.length;
  });
}

async function backfillVercel(): Promise<number> {
  return db.transaction(async tran => {
    const rows = await tran
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(isNull(kilocode_users.vercel_downstream_safety_identifier))
      .orderBy(desc(kilocode_users.created_at))
      .limit(1000);

    for (const user of rows) {
      const vercel_downstream_safety_identifier = generateVercelDownstreamSafetyIdentifier(user.id);
      await tran
        .update(kilocode_users)
        .set({ vercel_downstream_safety_identifier })
        .where(eq(kilocode_users.id, user.id))
        .execute();
    }

    return rows.length;
  });
}

export async function POST(): Promise<
  NextResponse<BackfillBatchResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const [openrouterResult, vercelProcessed] = await Promise.all([
    backfillOpenRouter(),
    backfillVercel(),
  ]);

  if (openrouterResult === null) {
    return NextResponse.json(
      { error: 'OPENROUTER_ORG_ID is not configured on this server' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    openrouterProcessed: openrouterResult,
    vercelProcessed,
    remaining: openrouterResult === 1000 || vercelProcessed === 1000,
  });
}
