import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { organizations } from '@/db/schema';
import { db } from '@/lib/drizzle';
import { eq, sql } from 'drizzle-orm';
import { toMicrodollars } from '@/lib/utils';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ success: boolean; consumed_usd: number } | { error: string }>> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 });
  }

  const id = (await params).id;
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const org = await getOrganizationById(id);
  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  }

  const body = await request.json();
  const amount_usd = body.amount_usd;
  if (typeof amount_usd !== 'number' || amount_usd <= 0) {
    return NextResponse.json({ error: 'amount_usd must be a positive number' }, { status: 400 });
  }

  const microdollars = toMicrodollars(amount_usd);

  await db
    .update(organizations)
    .set({
      microdollars_used: sql`${organizations.microdollars_used} + ${microdollars}`,
      microdollars_balance: sql`${organizations.microdollars_balance} - ${microdollars}`,
    })
    .where(eq(organizations.id, id));

  return NextResponse.json({ success: true, consumed_usd: amount_usd });
}
