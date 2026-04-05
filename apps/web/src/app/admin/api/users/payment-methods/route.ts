import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { payment_methods } from '@kilocode/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getUserFromAuth } from '@/lib/user.server';

export async function GET(
  req: NextRequest
): Promise<
  NextResponse<{ error: string } | { payment_methods: (typeof payment_methods.$inferSelect)[] }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const { searchParams } = new URL(req.url);
  const kilo_user_id = searchParams.get('kilo_user_id');

  if (!kilo_user_id) throw new Error('kilo_user_id is required');

  const methods = await db.query.payment_methods.findMany({
    where: eq(payment_methods.user_id, kilo_user_id),
    orderBy: desc(payment_methods.created_at),
  });

  return NextResponse.json({ payment_methods: methods });
}
