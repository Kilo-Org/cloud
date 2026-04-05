import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getBalanceForUser } from '@/lib/user.balance';
import { findUserById } from '@/lib/user';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ success: boolean } | { error: string }>> {
  const id = (await params).id;
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  const userId = decodeURIComponent(id);

  const user = await findUserById(userId);
  if (!user) {
    return NextResponse.json({ error: 'User not found: ' + userId }, { status: 404 });
  }
  await getBalanceForUser(user, { forceRefresh: true });

  return NextResponse.json({ success: true });
}
