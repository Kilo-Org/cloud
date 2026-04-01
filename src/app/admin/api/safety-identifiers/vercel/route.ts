import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { generateVercelDownstreamSafetyIdentifier } from '@/lib/providerHash';
import { isNull, desc, eq } from 'drizzle-orm';

export type BackfillBatchResponse = {
  processed: number;
  remaining: boolean;
};

export async function POST(): Promise<NextResponse<BackfillBatchResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const processed = await db.transaction(async tran => {
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

  return NextResponse.json({ processed, remaining: processed === 1000 });
}
