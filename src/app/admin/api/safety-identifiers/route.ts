import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { isNull, count } from 'drizzle-orm';

export type SafetyIdentifierCountsResponse = {
  openrouterMissing: number;
  vercelMissing: number;
};

export async function GET(): Promise<NextResponse<SafetyIdentifierCountsResponse | { error: string }>> {
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
